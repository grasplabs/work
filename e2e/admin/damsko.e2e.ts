import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

/**
 * What `element` paints for `property`, and what Damsko's `token` gives an
 * element of its own beside it: the same when the build compiled the part's
 * styles into the admin's stylesheet and the token's theme is loaded.
 */
const painted = async (
  element: Locator,
  property: "backgroundColor" | "color",
  token: string
): Promise<{ element: string; token: string }> =>
  await element.evaluate(
    (node, { name, variable }) => {
      const probe = document.createElement("span");
      probe.style[name] = `var(${variable})`;
      node.after(probe);
      const read = {
        element: getComputedStyle(node)[name],
        token: getComputedStyle(probe)[name],
      };
      probe.remove();
      return read;
    },
    { name: property, variable: token }
  );

/** The parts whose paint is read, by their key in `paints`. */
const parts = ["button", "input", "head"] as const;

/** Each part's paint, read once the page shows them. */
const paints = async (page: Page) => {
  const main = page.getByRole("main");
  return {
    button: await painted(
      main.getByRole("button", { name: "Save changes" }),
      "backgroundColor",
      "--damsko-primary"
    ),
    input: await painted(
      main.getByRole("textbox", { name: "Organization name" }),
      "backgroundColor",
      "--damsko-input-bg"
    ),
    head: await painted(
      main
        .getByRole("table", { name: "Releases" })
        .getByRole("columnheader", { name: "Release" }),
      "color",
      "--damsko-table-head-foreground"
    ),
  };
};

// Damsko's components (packages/ui) in the admin: StyleX compiled by the
// admin's own build, through the Cloudflare plugin, beside the kit's
// Tailwind, in the tokens' colours, which follow the system's scheme.
test("Damsko's button, input, dialog and data table are drawn by their own styles beside the kit, light and dark", async ({
  page,
  request,
}) => {
  // The admin's database, with no client: the page reads none.
  const seeded = await request.post("/__e2e/seed-create");
  expect(seeded.status()).toBe(200);
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/damsko", { waitUntil: "networkidle" });
  const main = page.getByRole("main");
  // The kit's page header, above Damsko's parts.
  await expect(
    main.getByRole("heading", { level: 1, name: "Damsko" })
  ).toBeVisible();
  await expect(
    main.getByRole("table", { name: "Releases" }).getByRole("row")
  ).toHaveCount(4);

  const light = await paints(page);
  for (const part of Object.values(light)) {
    expect(part.element).not.toBe("rgba(0, 0, 0, 0)");
    expect(part.element).toBe(part.token);
  }

  // The dialog opens on Damsko's card, with its title and words.
  await main.getByRole("button", { name: "Rename" }).click();
  const dialog = page.getByRole("dialog", { name: "Rename the organization" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Its address stays the same.")).toBeVisible();
  const card = await painted(dialog, "backgroundColor", "--damsko-card");
  expect(card.element).toBe(card.token);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Each colour glides to the other scheme's: once there, it is the
  // token's again, and another colour.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(async () => {
      const dark = await paints(page);
      return parts.every(
        (part) =>
          dark[part].element === dark[part].token &&
          dark[part].token !== light[part].token
      );
    })
    .toBeTruthy();

  // In Damsko's own Geist, a file the admin serves.
  await expect
    .poll(
      async () =>
        await page.evaluate(() =>
          [...document.fonts].some(
            (face) => face.family === "Geist" && face.status === "loaded"
          )
        )
    )
    .toBeTruthy();
});
