import { expect } from "@playwright/test";

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
  const actions = page.getByRole("button", { name: `Actions for ${who}` });
  const notice = page
    .getByRole("region", { name: "Members" })
    .getByRole("status");

  await actions.click();
  await page.getByRole("menuitem", { name: "Sign out everywhere" }).click();
  await expect(notice).toHaveText("Person is signed out everywhere.");
  // Still a member.
  await expect(actions).toBeVisible();

  await actions.click();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  const confirm = page.getByRole("dialog", { name: "Remove Person?" });
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(notice).toHaveText(
    "Person is removed. 0 personal connections were disconnected."
  );
  await expect(actions).toHaveCount(0);
});

test("lets an admin rename the workspace and set its time zone, and shows them to everyone", async ({
  context,
  newContext,
  page,
}) => {
  const { admin, member } = peopleIn("workspaceSettings");
  await signInTo(context, admin);
  await page.goto("/settings/workspace");
  const name = page.getByRole("textbox", { name: "Name" });
  const zone = page.getByRole("combobox", { name: "Time zone" });
  const before = await name.inputValue();
  const renamed = `Acme ${crypto.randomUUID().slice(0, 6)}`;

  await name.fill(renamed);
  await name.press("Enter");
  await zone.click();
  await page.getByRole("option", { name: /^Amsterdam/u }).click();
  await expect(zone).toHaveText(/^Amsterdam/u);
  await expect(page.getByText("European Union")).toBeVisible();

  const other = await newContext();
  const theirs = await other.newPage();
  await signInTo(other, member);
  await theirs.goto("/settings/workspace");
  await expect(theirs.getByRole("textbox", { name: "Name" })).toHaveValue(
    renamed
  );
  await expect(theirs.getByRole("textbox", { name: "Name" })).toBeDisabled();
  await expect(theirs.getByRole("combobox", { name: "Time zone" })).toHaveText(
    /^Amsterdam/u
  );
  await other.close();

  await name.fill(before);
  await name.press("Enter");
  await expect(name).toHaveValue(before);
  // Back to UTC, where every deployment starts.
  await zone.click();
  await page.getByRole("option", { name: "UTC", exact: true }).click();
  await expect(zone).toHaveText(/^UTC/u);
});

test("invites someone with a role, says what each role may do, and withdraws the invitation", async ({
  context,
  page,
}) => {
  const { admin } = peopleIn("memberInvites");
  await signInTo(context, admin);
  await page.goto("/settings/members");
  const roles = page.getByRole("region", { name: "Roles" });
  await expect(
    roles.getByRole("row", { name: /^Invite people, change roles/u })
  ).toBeVisible();

  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Invite someone" });
  await dialog
    .getByRole("textbox", { name: "Email" })
    .fill("someone@elsewhere.test");
  await dialog.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(
    dialog.getByText(
      "Use an email address in one of the domains your organization signs in with."
    )
  ).toBeVisible();

  const email = `invited-${crypto.randomUUID().slice(0, 8)}@acme.test`;
  await dialog.getByRole("textbox", { name: "Email" }).fill(email);
  await dialog.getByRole("combobox", { name: "Role" }).click();
  await page.getByRole("option", { name: "Builder" }).click();
  await dialog.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(dialog).toBeHidden();

  const members = page.getByRole("region", { name: "Members" });
  await expect(members.getByText(email)).toBeVisible();
  await expect(
    members.getByText(/^Invited as Builder by .+ · hasn’t signed in yet$/u)
  ).toBeVisible();
  await members
    .getByRole("button", { name: `Withdraw the invitation of ${email}` })
    .click();
  await expect(members.getByText(email)).toHaveCount(0);
});

test("an admin makes a team, puts someone in it and takes them off, renames it and deletes it", async ({
  context,
  page,
}) => {
  const { admin, member } = peopleIn("teams");
  await signInTo(context, admin);
  await page.goto("/settings/members");
  await page.getByRole("tab", { name: "Teams" }).click();
  const teams = page.getByRole("region", { name: "Teams" });
  const name = `Finance ${crypto.randomUUID().slice(0, 6)}`;

  await teams.getByRole("button", { name: "New team" }).click();
  const create = page.getByRole("dialog", { name: "New team" });
  await create.getByRole("textbox", { name: "Name" }).fill(name);
  await create.getByRole("button", { name: "Create team" }).click();
  await expect(create).toBeHidden();
  await expect(teams.getByText(name, { exact: true })).toBeVisible();

  await teams.getByRole("button", { name: `Members of ${name}` }).click();
  const team = page.getByRole("dialog", { name: `Members of ${name}` });
  await team.getByRole("combobox", { name: "Add a member" }).click();
  await page
    .getByRole("option", { name: `Person (${member.email})`, exact: true })
    .click();
  await team.getByRole("button", { name: "Add", exact: true }).click();
  const inTeam = team.getByRole("list", { name: `Members of ${name}` });
  await expect(inTeam.getByText(member.email)).toBeVisible();
  await team.getByRole("button", { name: `Take Person off ${name}` }).click();
  await expect(team.getByText("Nobody is in this team yet.")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(team).toBeHidden();

  const renamed = `${name} and legal`;
  await teams.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  const rename = page.getByRole("dialog", { name: `Rename ${name}` });
  await rename.getByRole("textbox", { name: "Name" }).fill(renamed);
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(teams.getByText(renamed, { exact: true })).toBeVisible();

  await teams.getByRole("button", { name: `Actions for ${renamed}` }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page
    .getByRole("dialog", { name: `Delete ${renamed}?` })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(teams.getByText(renamed, { exact: true })).toHaveCount(0);
});

test("an admin changes a member's role", async ({ context, page }) => {
  const { admin, one } = peopleIn("roleChange");
  await signInTo(context, admin);
  await page.goto("/settings/members");
  const role = page.getByRole("combobox", {
    name: `Role of Person (${one.email})`,
  });
  await expect(role).toContainText("User");

  await role.click();
  await page.getByRole("option", { name: "Builder" }).click();
  await expect(role).toContainText("Builder");
});
