import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { z } from "zod";

/** Every section of an organization, by its path under the organization's own, and its title. */
const sections = [
  ["", "Overview"],
  ["details", "Details"],
  ["contract", "Contract"],
  ["members", "Members"],
  ["steps", "Steps"],
  ["organization", "Organization"],
  ["interviews", "Interviews"],
  ["workflows", "Workflows"],
  ["setup", "Setup"],
  ["integrations", "Integrations"],
  ["ai-use", "AI use"],
  ["hours", "Hours"],
  ["brain", "Brain"],
  ["data", "Data"],
  ["log", "Log"],
] as const;

/** What the organizations seed made (apps/admin/test/e2e-seed.ts). */
const seededSchema = z.object({ answered: z.string(), unset: z.string() });

const seed = async (
  request: APIRequestContext
): Promise<z.infer<typeof seededSchema>> => {
  const response = await request.post("/__e2e/seed-organizations");
  expect(response.status()).toBe(200);
  return seededSchema.parse(await response.json());
};

/** The path of `clientId`'s section at `path`. */
const sectionPath = (clientId: string, path: string): string =>
  `/organizations/${clientId}${path === "" ? "" : `/${path}`}`;

/** Goes to a section from the organization's own column, as staff do. */
const openSection = async (
  page: Page,
  name: string,
  clientId: string,
  path: string
): Promise<void> => {
  await page
    .getByRole("navigation", { name })
    .locator(`a[href="${sectionPath(clientId, path)}"]`)
    .last()
    .click();
  await expect(page).toHaveURL(
    new RegExp(`${sectionPath(clientId, path)}$`, "u")
  );
};

/**
 * Goes from the organization's Setup, the one section that shows without
 * its core, to the section at `path`, and sees it say it isn't set up yet.
 */
const fromSetupTo = async (
  page: Page,
  clientId: string,
  path: string,
  title: string
): Promise<void> => {
  await openSection(page, "Unset Acme", clientId, "setup");
  await openSection(page, "Unset Acme", clientId, path);
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", {
      level: 1,
      name: path === "" ? "Unset Acme" : title,
    })
  ).toBeVisible();
  if (path !== "setup") {
    await expect(main.getByText("Unset Acme isn’t set up yet")).toBeVisible();
    await expect(
      main.getByRole("link", { name: "See its Setup progress" })
    ).toBeVisible();
  }
  await expect(main.getByText("This couldn’t be shown")).toHaveCount(0);
};

/** Whatever the page logs of a failure while rendering, from now on. */
const failuresOf = (page: Page): string[] => {
  const failures: string[] = [];
  page.on("pageerror", (error) => {
    failures.push(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      failures.push(message.text());
    }
  });
  return failures;
};

// Nick, on the admin: moving between an organization's sections showed
// the router's "Something went wrong" whenever its core hadn't answered.
test("every section of an organization not set up yet says so, moving between them from its column", async ({
  page,
  request,
}) => {
  const { unset } = await seed(request);
  const failures = failuresOf(page);
  await page.goto(sectionPath(unset, "setup"), { waitUntil: "networkidle" });

  for (const [path, title] of sections) {
    // oxlint-disable-next-line no-await-in-loop -- one section after another, as staff move
    await fromSetupTo(page, unset, path, title);
  }
  expect(failures).toStrictEqual([]);
});
