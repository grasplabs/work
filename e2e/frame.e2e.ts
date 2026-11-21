import { expect } from "@playwright/test";

import { callGate } from "./call-gate.ts";
import { test } from "./csp.ts";
import { apiOf, peopleIn, signInTo } from "./people.ts";

// The frame across a reload and between pages (apps/web's
// frame/shell-pending.tsx and the router's defaults in main.tsx). Core's
// answers are held back where a test needs to see what shows before they
// come: on a fast local stack they would come before anything could look.

test("a reload keeps the frame on screen while core says who is in, and shows the person only once it has", async ({
  context,
  page,
}) => {
  const { member } = peopleIn("frameReload");
  await signInTo(context, member);
  const whoIsIn = await callGate(page, '"whoami"');
  await page.goto("/apps");
  const nav = page.getByRole("navigation", { name: "Main" });
  // Everyone signed in on the stack is called Person.
  const person = page.getByRole("button", { name: /^Person\b/u });
  await expect(person).toBeVisible();

  whoIsIn.hold();
  await page.reload();
  await expect.poll(whoIsIn.stalled).toBeGreaterThan(0);
  // The sidebar and its sections, the current one marked, and the chat's
  // bar, before core has said who this is.
  await expect(nav.getByRole("link", { name: "Apps" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Integrations" })).toBeVisible();
  // The chat's box waits too, out of reach until the shell is in.
  await expect(page.locator('[data-slot="composer"]')).toBeVisible();
  // Nothing of the person: their name and menu wait for core.
  await expect(person).toHaveCount(0);

  whoIsIn.release();
  await expect(person).toBeVisible();
  await expect(page.getByRole("heading", { name: "Apps" })).toBeVisible();
});

test("after signing out, a reload paints no frame, and the browser keeps nothing of the person", async ({
  context,
  page,
}) => {
  const { member } = peopleIn("frameSignOut");
  await signInTo(context, member);
  // Signed out, core refuses the session before it is asked who: the
  // status the shell waits for holds on its other answer.
  const whoIsIn = await callGate(page, '"signInOptions"');
  await page.goto("/apps");
  await page.getByRole("button", { name: /^Person\b/u }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();

  // Back to a page of the product while core has not yet said nobody is in.
  whoIsIn.hold();
  await page.goto("/apps");
  await expect.poll(whoIsIn.stalled).toBeGreaterThan(0);
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Apps" })).toHaveCount(0);

  whoIsIn.release();
  await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  // Every key and value this browser keeps for the page.
  const kept = await page.evaluate(() =>
    [localStorage, sessionStorage]
      .flatMap((storage) =>
        Array.from({ length: storage.length }, (_, index) => {
          const key = storage.key(index) ?? "";
          return `${key}=${storage.getItem(key) ?? ""}`;
        })
      )
      .join("\n")
  );
  expect(kept).not.toContain(member.email);
  expect(kept).not.toContain(member.userId);
});

test("a page visited before shows what it read at once, then what core says now", async ({
  context,
  page,
}) => {
  const { builder } = peopleIn("frameRevisit");
  await signInTo(context, builder);
  const lists = await callGate(page, '"projects","list"');
  await page.goto("/projects");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Apps" }).click();
  await expect(page.getByRole("heading", { name: "Apps" })).toBeVisible();

  // Someone makes a project meanwhile.
  const name = `Quarter close ${crypto.randomUUID().slice(0, 8)}`;
  const { core, api } = apiOf(builder);
  try {
    await api.projects.create({ name });
  } finally {
    core[Symbol.dispose]();
  }

  // Back to Projects (no longer in the sidebar): the list read before, at
  // once, while it is read again.
  lists.hold();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
  await expect.poll(lists.stalled).toBeGreaterThan(0);
  await expect(page.getByText(name)).toHaveCount(0);

  lists.release();
  await expect(page.getByText(name)).toBeVisible();
});
