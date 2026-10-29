import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { peopleIn, signInTo } from "./people.ts";

// Erasing someone an admin removed (GRA-903, GRA-1195), as an admin does it
// on Members and roles: remove them, open the erasure, see who it is and
// what goes, find a name that isn't theirs exactly refused, confirm with
// theirs, follow each area to the end, then let their old address in
// again for whoever the company gave it to.

test("an admin removes someone, erases them by typing their name, follows it to the end, and releases their address", async ({
  context,
  page,
}) => {
  const { admin, leaving } = peopleIn("memberErasure");
  await signInTo(context, admin);
  await page.goto("/settings/members");
  const who = `Person (${leaving.email})`;

  // Removed first: only someone removed is erased.
  await page.getByRole("button", { name: `Actions for ${who}` }).click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await page
    .getByRole("dialog", { name: "Remove Person?" })
    .getByRole("button", { name: "Remove" })
    .click();
  const removed = page.getByRole("region", { name: "Removed people" });
  const erase = removed.getByRole("button", { name: `Erase ${who}` });
  await expect(erase).toBeVisible();

  await erase.click();
  const dialog = page.getByRole("dialog", { name: "Erase Person?" });
  // Who it is, as core has them now, and what goes and stays.
  await expect(dialog).toContainText(leaving.email);
  await expect(dialog).toContainText("Their email address and every sign-in");
  await expect(dialog).toContainText(
    "Their name, on what they did, so it stays traceable"
  );
  const confirm = dialog.getByRole("button", { name: "Erase" });
  const name = dialog.getByRole("textbox", { name: "Type Person to confirm" });
  await expect(confirm).toBeDisabled();

  // Not their name exactly: nothing can be erased.
  await name.fill("person");
  await expect(confirm).toBeDisabled();

  await name.fill("Person");
  await confirm.click();
  await expect(dialog.getByRole("status")).toHaveText("Person is erased.");
  await expect(dialog.getByRole("listitem")).toContainText([
    "Email and sign-ins",
  ]);
  await dialog
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();

  // Their row stays, by name, their address gone from it.
  await expect(erase).toHaveCount(0);
  await expect(removed.getByText(/email erased/u).first()).toBeVisible();

  // The company gave their address to someone else: it may sign in again.
  // Someone erased on an earlier try may be listed too, under the same name.
  const releases = removed.getByRole("button", {
    name: "Let the old address of Person in again",
  });
  await expect(releases.first()).toBeVisible();
  const kept = await releases.count();
  await releases.first().click();
  const release = page.getByRole("dialog", {
    name: "Let Person’s old address in again?",
  });
  await release
    .getByRole("textbox", { name: "The address" })
    .fill(leaving.email);
  await release.getByRole("button", { name: "Let it in" }).click();
  await expect(release.getByRole("status")).toHaveText(
    "The address can sign in again."
  );
  await release
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
  await expect(releases).toHaveCount(kept - 1);
});
