import { expect } from "@playwright/test";

import { callGate } from "./call-gate.ts";
import { test } from "./csp.ts";
import { peopleIn, signInTo } from "./people.ts";

// Members and roles, and the workspace, as an admin keeps them: inviting
// someone, making teams, changing a role, signing someone out everywhere
// and removing them, and the workspace's name and time zone, which
// everyone sees.

test("an admin signs someone out everywhere, then removes them, and is told what that disconnected", async ({
  context,
  page,
}) => {
  const { admin, leaving } = peopleIn("memberRemoval");
  await signInTo(context, admin);
  await page.goto("/settings/members");
  const who = `Person (${leaving.email})`;
  await page
    .getByRole("searchbox", { name: "Search members" })
    .fill(leaving.email);
  const actions = page.getByRole("button", { name: `Actions for ${who}` });
  // What a change did, said over the people's table.
  const notice = page.getByRole("status").filter({ hasText: /^Person is/u });

  await actions.click();
  await page.getByRole("menuitem", { name: "Sign out everywhere" }).click();
  await expect(notice).toHaveText("Person is signed out everywhere.");
  // Still a member.
  await expect(actions).toBeVisible();

  await actions.click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Remove Person?" });
  await confirm.getByRole("button", { name: "Remove" }).click();
  // They had no personal connections, so none is counted.
  await expect(notice).toHaveText("Person is removed.");
  // They stay in the people's table, a state of their row.
  await expect(
    page
      .getByRole("table", { name: "Members" })
      .getByRole("row")
      .filter({ hasText: leaving.email })
  ).toContainText("Removed");
});

test("lets an admin rename the workspace and set its time zone, and shows them to everyone", async ({
  context,
  newContext,
  page,
}) => {
  const { admin, member } = peopleIn("workspaceSettings");
  await signInTo(context, admin);
  await page.goto("/settings/workspace");
  // The organization's card names it, and its pencil renames it.
  const card = page.getByRole("region", { name: "Organization", exact: true });
  const heading = card.getByRole("heading");
  const zone = page.getByRole("combobox", { name: "Time zone" });
  const before = (await heading.textContent()) ?? "";
  const dialog = page.getByRole("dialog", { name: "Organization name" });
  const renamed = `Acme ${crypto.randomUUID().slice(0, 6)}`;
  const rename = async (to: string): Promise<void> => {
    await card.getByRole("button", { name: "Edit the name" }).click();
    const name = dialog.getByRole("textbox", { name: "Name" });
    await name.fill(to);
    await name.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(heading).toHaveText(to);
  };

  await rename(renamed);
  await zone.click();
  await page.getByRole("option", { name: /^Amsterdam/u }).click();
  await expect(zone).toHaveValue(/^Amsterdam/u);
  await expect(card).toContainText("European Union");

  // A member reads the workspace by its address, and changes nothing.
  const other = await newContext();
  const theirs = await other.newPage();
  await signInTo(other, member);
  await theirs.goto("/settings/workspace");
  const their = theirs.getByRole("region", {
    name: "Organization",
    exact: true,
  });
  await expect(their.getByRole("heading")).toHaveText(renamed);
  await expect(
    their.getByRole("button", { name: "Edit the name" })
  ).toHaveCount(0);
  await expect(theirs.getByRole("combobox", { name: "Time zone" })).toHaveValue(
    /^Amsterdam/u
  );
  await other.close();

  await rename(before);
  // Back to UTC, where every deployment starts.
  await zone.click();
  await page.getByRole("option", { name: "UTC", exact: true }).click();
  await expect(zone).toHaveValue(/^UTC/u);
});

test("invites someone with a role, says what each role may do, and withdraws the invitation", async ({
  context,
  page,
}) => {
  const { admin } = peopleIn("memberInvites");
  await signInTo(context, admin);
  await page.goto("/settings/members");
  // What each role may do opens from Roles in the members' head.
  await page.getByRole("button", { name: "Roles" }).click();
  await expect(
    page.getByText(/^Manages people, teams and permissions/u)
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Invite people" });
  // Grasp UI's tag input: a combobox, which suggests as it is typed in.
  const addresses = dialog.getByRole("combobox", { name: "Email addresses" });
  // An address outside the organization's domains: core refuses it, and it stays marked.
  await addresses.fill("someone@elsewhere.test");
  await addresses.press("Enter");
  await dialog.getByRole("button", { name: "Send invites" }).click();
  await expect(
    dialog.getByText(
      /Use an email address in one of the domains your organization signs in with/u
    )
  ).toBeVisible();
  // The first Backspace goes to the refused address's tag, the second takes it away.
  await addresses.press("Backspace");
  await page.keyboard.press("Backspace");

  const email = `invited-${crypto.randomUUID().slice(0, 8)}@acme.test`;
  await addresses.fill(email);
  await addresses.press("Enter");
  await dialog.getByRole("combobox", { name: "Role" }).click();
  await page.getByRole("option", { name: /^Builder/u }).click();
  await dialog.getByRole("button", { name: "Send invites" }).click();
  await expect(dialog).toBeHidden();

  // The invited stand in the people's table, a state of their row.
  await page.getByRole("searchbox", { name: "Search members" }).fill(email);
  const members = page.getByRole("table", { name: "Members" });
  const row = members.getByRole("row").filter({ hasText: email });
  await expect(row).toContainText("Invited");
  await expect(row).toContainText("Builder");
  await members.getByRole("button", { name: `Actions for ${email}` }).click();
  await page.getByRole("menuitem", { name: "Withdraw invitation" }).click();
  await expect(
    members.getByRole("button", { name: `Actions for ${email}` })
  ).toHaveCount(0);
});

test("an admin makes a team, puts someone in it and takes them off, renames it and deletes it", async ({
  context,
  page,
}) => {
  const { admin, member } = peopleIn("teams");
  await signInTo(context, admin);
  await page.goto("/settings/teams");
  const teams = page.getByRole("region", { name: "Teams" });
  const name = `Finance ${crypto.randomUUID().slice(0, 6)}`;

  await teams.getByRole("button", { name: "New team" }).click();
  const create = page.getByRole("dialog", { name: "New team" });
  await create.getByRole("textbox", { name: "Name" }).fill(name);
  await create.getByRole("button", { name: "Create team" }).click();
  await expect(create).toBeHidden();
  await expect(teams.getByText(name, { exact: true })).toBeVisible();

  // The team's name opens its dialog: tick someone in, save.
  await teams.getByRole("button", { name, exact: true }).click();
  const team = page.getByRole("dialog", { name });
  await team.getByRole("searchbox", { name: "Find people" }).fill(member.email);
  await team.getByRole("checkbox", { name: `Person ${member.email}` }).check();
  await team.getByRole("button", { name: "Save changes" }).click();
  await expect(team).toBeHidden();
  await expect(teams.getByText("1 person")).toBeVisible();

  // Untick them and rename it, in one save.
  const renamed = `${name} and legal`;
  await teams.getByRole("button", { name, exact: true }).click();
  await team
    .getByRole("checkbox", { name: `Person ${member.email}` })
    .uncheck();
  await team.getByRole("textbox", { name: "Name" }).fill(renamed);
  await team.getByRole("button", { name: "Save changes" }).click();
  await expect(team).toBeHidden();
  await expect(teams.getByText(renamed, { exact: true })).toBeVisible();

  await teams.getByRole("button", { name: `Actions for ${renamed}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page
    .getByRole("alertdialog", { name: `Delete ${renamed}?` })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(teams.getByText(renamed, { exact: true })).toHaveCount(0);
});

test("an admin changes a member's role, and the controls wait for the list to show it", async ({
  context,
  page,
}) => {
  const { admin, one } = peopleIn("roleChange");
  await signInTo(context, admin);
  const gate = await callGate(page, '["members","list"]');
  await page.goto("/settings/members");
  const who = `Person (${one.email})`;
  await page.getByRole("searchbox", { name: "Search members" }).fill(one.email);
  const role = page.getByRole("combobox", { name: `Role of ${who}` });
  await expect(role).toContainText("User");

  gate.hold();
  await role.click();
  await page.getByRole("option", { name: /^Builder/u }).click();
  // The change went through; the list that shows it hasn't come back yet.
  // The controls went off before the change was sent, so they're read
  // right away, then the list is let through, well before the page would
  // give up on it.
  await expect.poll(gate.stalled).toBe(1);
  const whileRefreshing = {
    role: await role.isDisabled(),
    remove: await page
      .getByRole("button", { name: `Actions for ${who}`, exact: true })
      .isDisabled(),
  };
  gate.release();
  expect(whileRefreshing).toStrictEqual({ role: true, remove: true });
  await expect(role).toBeEnabled();
  await expect(role).toContainText("Builder");
});
