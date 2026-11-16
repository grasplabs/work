import { expect } from "@playwright/test";
import type { WebSocketRoute } from "@playwright/test";

import { test } from "./csp.ts";
import { appPlanned, appReady, modelScripts } from "./model-scripts.ts";
import { peopleIn } from "./people.ts";

// An App, end to end, as a builder makes one: Make something, what they
// want to get done, Grasp's plan, Build it, and the chat building it (the
// stack's scripted model proposes a page the team opens, then reads the
// deployment's docs, writes the App's files and says it's ready, e2e/
// model-scripts.ts), the builder landing in the App to try it, then Share
// with your team, which makes it the App's first version and shares it in
// one step, and says so. Shared with someone, they open the App and add a
// contact on its page, which the App's data shows its builder.

/** A turn of the agent's, its model's calls and the tools they call. */
const agentTurn = { timeout: 30_000 };

/** A page's first build, or a read from core on a loaded stack. */
const built = { timeout: 20_000 };

/** How much of the end of their ID tells a person apart from a namesake (people-apart.ts). */
const namesakeIdEnd = 6;

// Each action waits as long as a build or a read: one that never can
// fails as itself, not as the whole test's timeout.
test.use({ actionTimeout: built.timeout });

test("a builder makes an App from what they want done, shares it with their team, and someone it is shared with adds a contact its data then shows", async ({
  pageOf,
}) => {
  // Its longest waits, one after another: two of the agent's turns and
  // the preview's first load (30 s each) and ten builds or reads (20 s
  // each): 290 s, before its clicks.
  test.setTimeout(300_000);
  const { builder, user } = peopleIn("appBuilt");
  const { opener } = modelScripts.buildsApp;
  const page = await pageOf(builder);
  // The builder's connections to core (the tab's, and the preview's own),
  // dropped once, as a blip does, the moment the page reads the App again
  // once core answered the share (its first read of the App's contents
  // after that), and refused until the page says Grasp can't be reached;
  // the page then reads the App again by itself. Calls as Cap'n Web sends
  // them: a push, then a pull naming its answer, which core resolves.
  const sockets = new Set<WebSocketRoute>();
  const blip = { sharing: false, armed: false, down: false };
  await page.routeWebSocket("**/rpc", (socket) => {
    if (blip.down) {
      void socket.close();
      return;
    }
    const core = socket.connectToServer();
    sockets.add(socket);
    socket.onClose(() => {
      sockets.delete(socket);
    });
    const added = { pushed: false, answer: "" };
    socket.onMessage((message) => {
      const sent = String(message);
      if (blip.sharing && sent.includes('["apps","members","add"]')) {
        added.pushed = true;
      } else if (added.pushed && sent.startsWith('["pull",')) {
        added.pushed = false;
        added.answer = `["resolve",${sent.slice('["pull",'.length, -1)},`;
      }
      // The App's page reads its contents only as it loads.
      if (blip.armed && sent.includes('["apps","contents"]')) {
        blip.armed = false;
        blip.down = true;
        for (const open of sockets) {
          void open.close();
        }
        return;
      }
      core.send(message);
    });
    core.onMessage((message) => {
      if (added.answer !== "" && String(message).startsWith(added.answer)) {
        added.answer = "";
        blip.sharing = false;
        blip.armed = true;
      }
      socket.send(message);
    });
  });
  // Nothing the page does as its connections drop and its preview goes
  // fails unhandled.
  const uncaught: string[] = [];
  page.on("pageerror", (error) => {
    uncaught.push(error.message);
  });

  // Make something: Chat's page, what they want done, and Grasp's plan
  // for it in the chat. Nothing is made until Build it; then Grasp builds
  // it in the chat, ticking off what it does, and offers to open the App,
  // where the same chat docks beside it.
  await page.goto("/apps");
  await page.getByRole("link", { name: "Make something" }).click();
  await expect(page).toHaveURL(/\/\?make=app$/u);
  await expect(
    page.getByRole("heading", { name: "What do you want to get done?" })
  ).toBeVisible();
  const ask = page.getByRole("textbox", { name: "Your question" });
  await ask.fill(opener);
  await ask.press("Enter");
  const plan = page.getByRole("region", {
    name: "Here's what Grasp will make",
  });
  await expect(plan.getByText(appPlanned)).toBeVisible(agentTurn);
  // Build it lands on the App at once, its bar naming it, while the chat
  // beside it builds it. The calm "Setting up" between is not waited for
  // here: the stack's model builds the App in about a second, so it can be
  // gone between two of the assertion's looks. Its page test proves it
  // (app-workspace.test.tsx).
  await plan.getByRole("button", { name: "Build it" }).click();
  await expect(page).toHaveURL(/\/apps\/[^/?]+$/u);
  await expect(
    page.getByRole("heading", { level: 1, name: appPlanned })
  ).toBeAttached(built);
  const app = new URL(page.url()).pathname.split("/").at(-1) ?? "";

  // The chat read how an App is written, wrote it, and said so.
  const chat = page.getByRole("region", { name: "Chat" });
  await expect(chat.getByText("Read /guides/project in the docs")).toBeVisible(
    agentTurn
  );
  await expect(chat.getByText(appReady)).toBeVisible(agentTurn);
  // Where it stands, in the bar: beside the docked chat it gives way to
  // the name and Share, so it is there, unseen.
  await expect(page.getByText("Only you see this")).toBeAttached();

  // The preview is the draft's page, on a store of its own.
  const preview = page.getByRole("region", { name: /, your version$/u });
  const frame = preview.frameLocator("iframe");
  // Its first load waits for core to build the draft, behind any update
  // ahead of it: as long as an agent's turn.
  await expect(frame.getByLabel("Contact's name")).toBeVisible(agentTurn);
  await frame.getByLabel("Contact's name").fill("Ada Lovelace");
  await frame.getByRole("button", { name: "Add contact" }).click();
  await expect(
    frame.getByRole("list", { name: "Contacts" }).getByRole("listitem")
  ).toHaveText(["Ada Lovelace"], built);

  // The chat never shares it: the builder does, with whom they pick, which
  // checks the draft, makes it the App's first version and shares it, in
  // one step. Everyone the stack signs in is called Person, and a builder
  // sees names, not emails: they are told apart by the ID each goes by.
  await page.getByRole("button", { name: "Share with your team" }).click(built);
  const sharing = page.getByRole("dialog");
  await sharing
    .getByRole("checkbox", {
      name: `Person (ID …${user.userId.slice(-namesakeIdEnd)})`,
    })
    .check();
  blip.sharing = true;
  await sharing.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByText("Shared with Person")).toBeVisible(built);
  // Its read again after sharing lost its connection: Grasp can't be
  // reached, until a connection answers again, when the page reads the
  // App by itself, with no Try again.
  const unreachable = page
    .getByRole("main")
    .getByText("Grasp can't be reached right now. Try again in a moment.");
  await expect(
    page.getByRole("heading", { level: 1, name: "This page didn't load" })
  ).toBeVisible(built);
  await expect(unreachable).toBeVisible();
  blip.down = false;
  await expect(
    page.getByRole("heading", { level: 1, name: appPlanned })
  ).toBeAttached(built);
  await expect(unreachable).toHaveCount(0);
  expect(uncaught).toStrictEqual([]);

  // They use the live App: none of the preview's contacts, then theirs.
  const used = await pageOf(user);
  await used.goto(`/apps/${app}`);
  await expect(
    used.getByRole("heading", { level: 1, name: appPlanned })
  ).toBeVisible(built);
  const appPage = used.frameLocator('iframe[title="App"]');
  const contacts = appPage
    .getByRole("list", { name: "Contacts" })
    .getByRole("listitem");
  await expect(appPage.getByLabel("Contact's name")).toBeVisible(built);
  await expect(contacts).toHaveCount(0);
  await appPage.getByLabel("Contact's name").fill("Grace Hopper");
  await appPage.getByRole("button", { name: "Add contact" }).click();
  await expect(contacts).toHaveText(["Grace Hopper"], built);

  // Shared, with nothing changed since, the workspace is what the team
  // sees: its Data shows its builder the contact they added, a row of its
  // table's grid, and none of the preview's.
  await page
    .getByRole("navigation", { name: "Workspace views" })
    .getByRole("link", { name: "Data" })
    .click();
  await expect(page.getByRole("cell", { name: "Grace Hopper" })).toBeVisible(
    built
  );
  await expect(page.getByRole("cell", { name: "Ada Lovelace" })).toHaveCount(0);
});
