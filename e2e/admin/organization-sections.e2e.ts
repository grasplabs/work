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

/** Makes the admin's server function `fn` fail as `mode` says, or none with null. */
const fault = async (
  request: APIRequestContext,
  fn: string | null,
  mode: "error" | "garbled" = "error"
): Promise<void> => {
  const response = await request.post("/__e2e/fault", { data: { fn, mode } });
  expect(response.status()).toBe(204);
};

// The dev server is shared by every test and retry: a fault a test set
// never outlives it, however the test ends, nor is one left from before.
test.beforeEach(async ({ request }) => {
  await fault(request, null);
});
test.afterEach(async ({ request }) => {
  await fault(request, null);
});

/** The section's failure in its place, and Try again bringing the section back once its cause is gone. */
const failsThenRecovers = async (
  page: Page,
  request: APIRequestContext,
  clientId: string
): Promise<void> => {
  const main = page.getByRole("main");
  await openSection(page, "Answering Acme", clientId, "log");
  await expect(main.getByText("This couldn’t be shown")).toBeVisible();
  await expect(main.getByText("Something went wrong")).toHaveCount(0);

  await fault(request, null);
  await main.getByRole("button", { name: "Try again" }).click();
  await expect(main.getByLabel("Search the log")).toBeVisible();
  await expect(main.getByText("This couldn’t be shown")).toHaveCount(0);
};

// The Log's loader reads the admin's trail (`fetchOrganizationTrail`).
test("a section whose read fails says so in its place, the column and sidebar still work, and Try again brings it back", async ({
  page,
  request,
}) => {
  const { answered } = await seed(request);
  await page.goto(sectionPath(answered, "members"), {
    waitUntil: "networkidle",
  });
  await fault(request, "fetchOrganizationTrail");

  const main = page.getByRole("main");
  await openSection(page, "Answering Acme", answered, "log");
  await expect(main.getByText("This couldn’t be shown")).toBeVisible();
  // The organization's column still moves between its sections.
  await openSection(page, "Answering Acme", answered, "members");
  await expect(main.getByText("Nobody has made an account yet.")).toBeVisible();
  // And the admin's sidebar still goes elsewhere.
  await page
    .getByRole("navigation", { name: "Organizations" })
    .getByRole("link", { name: "Answering Acme" })
    .click();
  await expect(
    main.getByRole("heading", { level: 1, name: "Answering Acme" })
  ).toBeVisible();

  await fault(request, "fetchOrganizationTrail");
  await failsThenRecovers(page, request, answered);
});

test("a section that can't render what it read says so in its place, and Try again brings it back", async ({
  page,
  request,
}) => {
  const { answered } = await seed(request);
  await page.goto(sectionPath(answered, "members"), {
    waitUntil: "networkidle",
  });
  // A trail that isn't one: the Log throws rendering it.
  await fault(request, "fetchOrganizationTrail", "garbled");
  await failsThenRecovers(page, request, answered);
});

// The frame's loader reads the platform's counts (`fetchPlatformSidebar`).
test("a frame that can't be read says so with Try again, which brings the admin back", async ({
  page,
  request,
}) => {
  const { answered } = await seed(request);
  await page.goto(sectionPath(answered, "members"), {
    waitUntil: "networkidle",
  });
  await fault(request, "fetchPlatformSidebar");
  // The frame read again, as it is once its read went stale, and failing.
  await page.evaluate(async () => {
    // The router the page made: TanStack Router keeps it on the window.
    const router: unknown = Reflect.get(globalThis, "__TSR_ROUTER__");
    if (typeof router !== "object" || router === null) {
      throw new Error("The page has no router");
    }
    const invalidate: unknown = Reflect.get(router, "invalidate");
    if (typeof invalidate !== "function") {
      throw new TypeError("The page's router can't be read again");
    }
    await Reflect.apply(invalidate, router, []);
  });
  await expect(page.getByText("The admin couldn’t be read")).toBeVisible();
  await expect(page.getByText("Something went wrong")).toHaveCount(0);

  await fault(request, null);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Nobody has made an account yet.")).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Organizations" })
  ).toBeVisible();
});
