// Concepts only, not for merging: screenshots of the campaign page's
// concepts and of today's screens, at 1440x900 and 390x844, light and dark.
// One browser page, one shot after another, on purpose: the shots wait for each other.
/* oxlint-disable no-await-in-loop */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium } from "@playwright/test";

import { cookieHeader, signInAs } from "./seed/local.ts";

const out = process.argv[2] ?? "shots";
const only = process.argv[3] ?? "";
const onlySize = process.argv[4] ?? "";
mkdirSync(out, { recursive: true });
const origin = "http://localhost:5173";
const cookie = cookieHeader(await signInAs("admin@acme.test"));
const [name, ...value] = cookie.split("=");

const sizes = [
  { id: "1440", width: 1440, height: 900 },
  { id: "390", width: 390, height: 844 },
] as const;
const themes = ["light", "dark"] as const;
const states = ["day1", "day3", "day5", "close", "small"];

const pages: { id: string; url: string }[] = [
  { id: "before-listening", url: "/setup?step=listening" },
  { id: "before-review", url: "/setup?step=review" },
  { id: "before-settings", url: "/settings/onboarding" },
];
for (const concept of ["a", "b", "c"]) {
  for (const state of states) {
    pages.push({
      id: `${concept}-${state}`,
      url: `/setup?step=listening&concept=${concept}&state=${state}`,
    });
  }
  pages.push({
    id: `${concept}-settings`,
    url: `/settings/onboarding?concept=${concept}&state=day5`,
  });
}

const browser = await chromium
  .launch({ executablePath: "/opt/pw-browsers/chromium" })
  .catch(async () => await chromium.launch());
for (const size of sizes) {
  if (onlySize !== "" && size.id !== onlySize) {
    continue;
  }
  for (const theme of themes) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: 2,
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    await context.addCookies([
      {
        name: name ?? "",
        value: value.join("="),
        domain: "localhost",
        path: "/",
        secure: true,
        sameSite: "Lax",
      },
    ]);
    // Stephen stays quiet.
    await context.addInitScript(() => {
      localStorage.setItem("grasp-theme", "system");
    });
    const page = await context.newPage();
    for (const each of pages) {
      if (only !== "" && !each.id.startsWith(only)) {
        continue;
      }
      await page.goto(`${origin}${each.url}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(2500);
      await page.screenshot({
        path: path.join(out, `${each.id}-${size.id}-${theme}.png`),
        fullPage: true,
      });
    }
    await context.close();
  }
}
await browser.close();
console.log("done");
