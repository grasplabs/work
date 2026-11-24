// Concepts only, not for merging: screenshots of the onboarding's campaign
// page in its five fixture states, at 390, 900 and 1440 wide, light and
// dark, with the console's errors. `node scripts/concept-shots.ts <dir> [state] [width]`.
// One browser page, one shot after another, on purpose: the shots wait for each other.
/* oxlint-disable no-await-in-loop */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium } from "@playwright/test";

import { cookieHeader, signInAs } from "./seed/local.ts";

const [out = "shots", only = "", onlySize = ""] = process.argv
  .slice(2)
  .filter((each) => each !== "--settings");
mkdirSync(out, { recursive: true });
const origin = "http://localhost:5173";
const cookie = cookieHeader(await signInAs("admin@acme.test"));
const [name, ...value] = cookie.split("=");

// The page full screen, or in Settings, Onboarding with `--settings`.
const route = process.argv.includes("--settings")
  ? "/settings/onboarding?concept=c&state="
  : "/setup?step=listening&concept=c&state=";

const sizes = [
  { id: "390", width: 390, height: 844 },
  { id: "900", width: 900, height: 900 },
  { id: "1440", width: 1440, height: 900 },
] as const;
const themes = ["light", "dark"] as const;
const states = ["day1", "day3", "day5", "close", "small"];

const browser = await chromium.launch();
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
    // The local workspace has no AI ready, so the setup holds every visit at
    // its AI step: in this browser alone, let the asked step through.
    await page.route("**/src/onboarding/setup.ts*", async (request) => {
      try {
        const response = await request.fetch();
        const module = await response.text();
        const body = module.replace(
          "(held === reached || at <= held)",
          "(true)"
        );
        await request.fulfill({ response, body });
      } catch {
        // The page moved on before the module came back: nothing to answer.
      }
    });
    // The dev server can be slow to build a page the first time.
    page.setDefaultNavigationTimeout(180_000);
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.log(`console error: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      console.log(`page error: ${error.message}`);
    });
    for (const state of states) {
      if (only !== "" && state !== only) {
        continue;
      }
      const shot = path.join(out, `${state}-${size.id}-${theme}.png`);
      // A busy dev server can stall a load: one more try, then on to the next shot.
      for (const attempt of [1, 2]) {
        try {
          await page.goto(`${origin}${route}${state}`, {
            waitUntil: "commit",
          });
          // The page is there once its week is drawn (an error page has a title too).
          await page.locator("canvas").first().waitFor({ timeout: 120_000 });
          await page.waitForTimeout(1500);
          await page.screenshot({ path: shot, fullPage: true });
          break;
        } catch (error) {
          console.log(
            `attempt ${attempt} failed for ${shot}: ${String(error)}`
          );
        }
      }
    }
    await context.close();
  }
}
await browser.close();
console.log("done");
