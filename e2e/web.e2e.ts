import { errorReportMaxBytes } from "@grasp-os/shared/error-reports";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import { expect } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";
import { z } from "zod";

import { callGate } from "./call-gate.ts";
import { test } from "./csp.ts";
import { endSession, peopleIn, signInAs, signInTo } from "./people.ts";

/**
 * How long the page may take to show what came of a connection that had to
 * be made again: the read's own 5 s for one that never comes, and the
 * pauses between attempts (1 s, 2 s, then 3 s each) for one that does.
 */
const reconnectMs = 10_000;

test("loads the frontend from core, reaches core over RPC, and asks whoever isn't signed in to sign in", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Grasp" })).toBeVisible();
  // Only once core answered: without an answer, the page says so instead.
  await expect(
    page.getByText("Use your organization’s account to go on.")
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/");
});

test("shows only its own words for a refused sign-in, never the link's", async ({
  page,
}) => {
  const planted = "Your account is locked. Call +1 555 0100";
  await page.goto(`/?error=${encodeURIComponent(planted)}`);
  await expect(page.getByRole("alert")).toHaveText(
    "Sign-in didn't work. Try again, or ask an admin."
  );
  await expect(page.getByText(planted)).toHaveCount(0);
});

test("an interview link nobody made asks to sign in first, then can't be opened with the request ID core refused it under, says nothing was saved, and lets them sign out to sign in again", async ({
  context,
  page,
}) => {
  await page.goto(`/interview#${"A".repeat(43)}`);
  await expect(
    page.getByRole("heading", { name: "Sign in to open your interview" })
  ).toBeVisible();
  const email = `person.${crypto.randomUUID()}@acme.test`;
  await signInTo(context, {
    userId: "",
    email,
    role: "user",
    cookie: await signInAs(email),
  });
  const refused = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === interviewApiPath && !response.ok()
  );
  await page.reload();
  const refusal = await refused;
  const requestId = refusal.headers()["x-request-id"] ?? "";
  expect(requestId).toMatch(/^[\da-f-]{36}$/u);
  await expect(
    page.getByRole("heading", { name: "This interview can't be opened" })
  ).toBeVisible();
  // Core's refusal, with the reference the person can quote.
  await expect(page.getByText(`Reference: ${requestId}`)).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toHaveCount(0);
  // Signed in with another account than the link's: a way out, to sign in
  // again.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Sign in to open your interview" })
  ).toBeVisible();
});

test("reports an error the page never caught once core has it, cut to the size core takes", async ({
  context,
  page,
}) => {
  const { member } = peopleIn("errorReports");
  await signInTo(context, member);
  // The first report never gets there; the rest go on to core.
  let attempts = 0;
  const taken: { message: string; status: number; bytes: number }[] = [];
  await page.route("**/api/error-reports", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.abort();
      return;
    }
    const response = await route.fetch();
    const body = route.request().postData() ?? "";
    const { message } = z
      .object({ message: z.string() })
      .parse(JSON.parse(body));
    taken.push({
      message: message.slice(0, 1),
      status: response.status(),
      bytes: Buffer.byteLength(body),
    });
    await route.fulfill({ response });
  });
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();

  // Within each field's limit in characters, but over core's body limit
  // in bytes: each of these characters is two in UTF-8.
  const rejectWide = async (): Promise<void> => {
    await page.evaluate(() => {
      const error = new Error("é".repeat(1000));
      error.stack = "ü".repeat(4000);
      void Promise.reject(error);
    });
  };
  await rejectWide();
  await expect.poll(() => attempts).toBe(1);
  // Not taken the first time, so reported again the next.
  await rejectWide();
  await expect.poll(() => attempts).toBe(2);
  // Taken now: never again on this page, unlike another error.
  await rejectWide();
  await page.evaluate(() => {
    void Promise.reject(new Error("another"));
  });
  // Until core has answered both: a report counts as an attempt when it
  // leaves the page, and core answers the two in either order.
  await expect.poll(() => taken.length).toBe(2);
  expect(attempts).toBe(3);
  const wide = taken.find(({ message }) => message === "é");
  const other = taken.find(({ message }) => message === "a");
  expect([wide, other]).toStrictEqual([
    { message: "é", status: 204, bytes: expect.any(Number) },
    { message: "a", status: 204, bytes: expect.any(Number) },
  ]);
  expect(wide?.bytes).toBeLessThanOrEqual(errorReportMaxBytes);
});

test("names each member's actions for them, and asks before making someone an admin", async ({
  context,
  page,
}) => {
  // Everyone signed in here has the same name.
  const { admin, one, two } = peopleIn("memberActions");
  await signInTo(context, admin);
  await page.goto("/settings/members");

  const search = page.getByRole("searchbox", { name: "Search members" });
  for (const person of [one, two]) {
    const who = `Person (${person.email})`;
    // The table shows a page at a time: each is found first.
    // oxlint-disable-next-line no-await-in-loop -- one search at a time
    await search.fill(person.email);
    // oxlint-disable-next-line no-await-in-loop -- one control at a time
    await expect(
      page.getByRole("button", { name: `Actions for ${who}`, exact: true })
    ).toHaveCount(1);
  }
  const labels = await page
    .getByRole("button", { name: /^Actions for /u })
    .evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label"))
    );
  expect(new Set(labels).size).toBe(labels.length);
  await search.fill(one.email);
  await page
    .getByRole("button", { name: `Actions for Person (${one.email})` })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Sign out everywhere" })
  ).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove" })).toBeVisible();
  await page.keyboard.press("Escape");

  const role = page.getByRole("combobox", {
    name: `Role of Person (${one.email})`,
  });
  await role.click();
  await page.getByRole("option", { name: /^Admin/u }).click();
  await expect(
    page.getByRole("alertdialog", { name: "Make Person an admin?" })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await expect(role).toContainText("User");
});

for (const [where, path, landed] of [
  ["a shell page", "/projects", "Projects"],
  // Outside the shell, in the app's frame all the same.
  [
    "a decision page",
    `/decisions/${crypto.randomUUID()}`,
    "Decision not found",
  ],
] as const) {
  test(`a sign-out core doesn't carry out is said in a toast on ${where}, and the person stays signed in`, async ({
    context,
    page,
  }) => {
    const { member } = peopleIn("signOutFailure");
    await signInTo(context, member);
    await page.goto(path);
    await expect(
      page.getByRole("heading", { name: landed, exact: true })
    ).toBeVisible();
    // Core, or something in front of it, answers the sign-out with a failure.
    await page.route("**/api/auth/sign-out", async (route) => {
      await route.fulfill({ status: 503, body: "Unavailable" });
    });
    await page.getByRole("button", { name: "Person", exact: true }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();

    await expect(page.getByText("Signing out didn't work")).toBeVisible();
    await expect(
      page.getByText("You're still signed in. Try again in a moment.")
    ).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`, "u"));
    await expect(
      page.getByRole("button", { name: "Person", exact: true })
    ).toBeVisible();
  });
}

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

  // A member sees the new name on the organization's card, with no way to
  // change it.
  const other = await newContext();
  const theirs = await other.newPage();
  await signInTo(other, member);
  await theirs.goto("/settings/workspace");
  const theirCard = theirs.getByRole("region", {
    name: "Organization",
    exact: true,
  });
  await expect(theirCard.getByRole("heading")).toHaveText(renamed);
  await expect(
    theirCard.getByRole("button", { name: "Edit the name" })
  ).toHaveCount(0);
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
  // Damsko's tags input: a combobox, which suggests as it is typed in.
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
  await dialog
    .getByRole("button", { name: "Remove someone@elsewhere.test" })
    .click();

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

test("shows the members page only to someone signed in, and never signs them out for core failing", async ({
  context,
  page,
}) => {
  await page.goto("/settings/members");
  await expect(
    page.getByText("Use your organization’s account to go on.")
  ).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/sign-in");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(
    "/settings/members"
  );
  await expect(
    page.getByRole("heading", { level: 1, name: "Members and roles" })
  ).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: /^Role of /u })).toHaveCount(
    0
  );

  // Core fails the next connections outright, as a busy database failing
  // the upgrade does: the browser sees only a closed socket.
  let failing = 0;
  await page.routeWebSocket("**/rpc", async (socket) => {
    if (failing > 0) {
      failing -= 1;
      await socket.close();
      return;
    }
    socket.connectToServer();
  });
  const { admin } = peopleIn("membersRecover");
  await signInTo(context, admin);

  // A couple of failures pass: the page's connection tries again, with a
  // growing pause, and lets them in.
  failing = 2;
  await page.goto("/settings/members");
  await expect(
    page.getByRole("heading", { level: 1, name: "Members and roles" })
  ).toBeVisible({
    timeout: reconnectMs,
  });
  expect(new URL(page.url()).pathname).toBe("/settings/members");
  expect(failing).toBe(0);

  // Failing for good says so, rather than asking them to sign in again:
  // once the page has waited its few seconds for a connection.
  failing = Number.POSITIVE_INFINITY;
  await page.goto("/settings/members");
  await expect(
    page.getByText("Grasp can't be reached right now. Try again in a moment.")
  ).toBeVisible({ timeout: reconnectMs });
  expect(new URL(page.url()).pathname).toBe("/settings/members");
  await expect(
    page.getByText("Use your organization’s account to go on.")
  ).toHaveCount(0);

  // Trying again shows it's trying, then says so again while core fails.
  const unreachable = page.getByRole("alert");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("button", { name: "Trying again…" })
  ).toBeDisabled();
  await expect(unreachable).toHaveText(
    "Grasp can't be reached right now. Try again in a moment.",
    { timeout: reconnectMs }
  );
  expect(new URL(page.url()).pathname).toBe("/settings/members");

  // Once core answers again, trying again lets them in.
  failing = 0;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Members and roles" })
  ).toBeVisible({
    timeout: reconnectMs,
  });
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

test("shows the page loading while the members list is slow, then says core can't be reached when it never comes", async ({
  context,
  page,
}) => {
  const { admin } = peopleIn("membersUnreachable");
  await signInTo(context, admin);
  const gate = await callGate(page, '["members","list"]');
  gate.hold();
  await page.goto("/settings/members");
  // In Settings, under the section's name, as placeholders while the read
  // is slow.
  const heading = page.getByRole("heading", {
    level: 1,
    name: "Members and roles",
  });
  await expect(heading).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Members" }).getByRole("row")
  ).not.toHaveCount(0);

  // Then the members' section says why it didn't load, with a way to ask
  // again, still in the frame.
  const members = page.getByRole("region", { name: "Members", exact: true });
  await expect(members.getByRole("alert")).toHaveText(
    "Grasp can't be reached right now. Try again in a moment.",
    { timeout: 15_000 }
  );
  await expect(
    members.getByRole("button", { name: "Try again" })
  ).toBeVisible();
  await expect(heading).toBeVisible();
  await expect(page.getByRole("combobox", { name: /^Role of /u })).toHaveCount(
    0
  );
});

test("sends someone whose session ended elsewhere to sign in, and back to the page they asked for", async ({
  context,
  page,
}) => {
  const { member } = peopleIn("sessionEnded");
  await signInTo(context, member);
  await page.goto("/projects");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Apps" })).toBeVisible();

  // Signed out in another tab, or revoked: the page's connection, opened
  // while they were signed in, is refused at the next page they open.
  await endSession(member);
  await nav.getByRole("link", { name: "Apps" }).click();
  await expect(
    page.getByText("Use your organization’s account to go on.")
  ).toBeVisible({
    timeout: reconnectMs,
  });
  expect(new URL(page.url()).pathname).toBe("/sign-in");
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/apps");
  await expect(nav).toHaveCount(0);
});

test("says an address no page has, and an App that isn't there, are not found, in the frame", async ({
  context,
  page,
}) => {
  const { member } = peopleIn("notFound");
  await signInTo(context, member);

  await page.goto("/no-such-page");
  await expect(
    page.getByRole("heading", { name: "This page is not here" })
  ).toBeVisible();
  await expect(
    page.getByText(
      "The address may be wrong, or the page was moved or removed."
    )
  ).toBeVisible();
  // In the frame: the sidebar is there to go on from, with no Domains:
  // each app is an App, under Apps.
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Apps" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Domains" })).toHaveCount(0);

  // Domains are gone: their address, and an App's under it, are no page.
  for (const gone of ["/domains", "/domains/no-such-app"]) {
    // oxlint-disable-next-line no-await-in-loop -- one address at a time
    await page.goto(gone);
    // oxlint-disable-next-line no-await-in-loop -- one address at a time
    await expect(
      page.getByRole("heading", { name: "This page is not here" })
    ).toBeVisible();
  }

  // An App that isn't there, on its own page.
  await page.goto("/apps/no-such-app");
  await expect(
    page.getByRole("heading", { name: "App not found" })
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" })
  ).toContainText("Not found");

  // A workflow that isn't there, on its own page, the same way.
  await page.goto("/workflows/no-such-workflow");
  await expect(
    page.getByRole("heading", { name: "Workflow not found" })
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb" })
  ).toContainText("Not found");

  // Apps own no workflows: an App's workflow address is no page.
  await page.goto("/workflows/no-such-app/no-such-workflow");
  await expect(
    page.getByRole("heading", { name: "This page is not here" })
  ).toBeVisible();
});

test("never sends what it gave up on while core was out of reach, once core is back", async ({
  context,
  page,
}) => {
  const { member } = peopleIn("readsGivenUp");
  await signInTo(context, member);
  let refusing = false;
  let open: WebSocketRoute | undefined;
  // What the page sends core from when core went out of reach.
  let recording = false;
  const sent: string[] = [];
  await page.routeWebSocket("**/rpc", async (socket) => {
    if (refusing) {
      await socket.close();
      return;
    }
    const server = socket.connectToServer();
    open = socket;
    socket.onMessage((message) => {
      if (recording) {
        sent.push(String(message));
      }
      server.send(message);
    });
  });
  await page.goto("/settings/members");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Brain" })).toBeVisible();

  // Core goes out of reach: the page's connection drops, and none gets in.
  refusing = true;
  recording = true;
  await open?.close();
  await nav.getByRole("link", { name: "Brain" }).click();
  // The page's own: the chat beside it says the same at once, as its
  // call drops, while the brain's read still waits for a connection.
  await expect(
    page
      .getByRole("main")
      .getByText("Grasp can't be reached right now. Try again in a moment.")
  ).toBeVisible({ timeout: reconnectMs });

  // Core is back. Trying the page again reads the brain once more: that is
  // the only read of it sent, not the one the page gave up on as well. The
  // shell knew who was signed in already, and asks core nothing for it.
  refusing = false;
  await page
    .getByRole("main")
    .getByRole("button", { name: "Try again" })
    .click();
  await expect(
    page.getByRole("complementary", { name: "The brain" })
  ).toBeVisible({ timeout: reconnectMs });
  const brainReads = sent.filter((message) =>
    message.includes('["brain","read"]')
  );
  expect(brainReads).toHaveLength(1);
});
