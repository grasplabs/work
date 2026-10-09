import { expect } from "@playwright/test";

import { test } from "./csp.ts";
import { apiOf, ordinaryData, pageOf, peopleIn } from "./people.ts";
import { origin } from "./stack.ts";

// A chat builds an App in a studio: the chat alone until its agent writes
// a draft, then the chat on the left and the draft's preview on the
// right, under the App's own top row with the way to the App. The preview
// is the draft's screen, calling the draft's server code in a preview of
// its own, which changes none of the App's data. The local stack reaches no model,
// so the draft is written straight into the chat's Workspace object, as
// the agent's `env.build.write` leaves it, through the local dev server's
// own tools (as connections-seed.ts writes into connect's database). The
// agent's side of it, and what the preview reports back to it, are core's
// tests (apps/core/test/preview-repairs.test.ts).

/** Where the local dev server runs SQL in a Durable Object's storage. */
const explorer = new URL("/cdn-cgi/local/explorer/api/", origin);

const namespacesSchema = {
  parse: (value: unknown): { id: string; class: string }[] => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("result" in value) ||
      !Array.isArray(value.result)
    ) {
      throw new TypeError("The dev server listed no Durable Objects");
    }
    return value.result.flatMap((entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      "id" in entry &&
      typeof entry.id === "string" &&
      "class" in entry &&
      typeof entry.class === "string"
        ? [{ id: entry.id, class: entry.class }]
        : []
    );
  },
};

/**
 * Writes a draft of `app` over `base`, with `files`, into `chatId` in
 * `userId`'s Workspace object (core's chats-rpc.ts names it), as its
 * agent's first write does.
 */
const writeDraft = async (
  userId: string,
  chatId: string,
  app: string,
  base: number,
  files: Record<string, string>
): Promise<void> => {
  const listed = await fetch(
    new URL("workers/durable_objects/namespaces", explorer)
  );
  const workspaces = namespacesSchema
    .parse(await listed.json())
    .find((namespace) => namespace.class === "Workspace");
  if (workspaces === undefined) {
    throw new Error("The dev server has no Workspace objects");
  }
  const written = await fetch(
    new URL(
      `workers/durable_objects/namespaces/${encodeURIComponent(workspaces.id)}/query`,
      explorer
    ),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        durable_object_name: `person:${userId}`,
        queries: [
          {
            sql: "INSERT INTO chat_drafts (chat_id, app_id, base, revision, updated_at) VALUES (?, ?, ?, 1, ?)",
            params: [chatId, app, base, Date.now()],
          },
          ...Object.entries(files).map(([path, content]) => ({
            sql: "INSERT INTO chat_draft_files (chat_id, app_id, path, content) VALUES (?, ?, ?, ?)",
            params: [chatId, app, path, content],
          })),
        ],
      }),
    }
  );
  if (!written.ok) {
    throw new Error(`The draft wasn't written: ${await written.text()}`);
  }
};

/** Server code that counts, in its storage, what was added. */
const server = (
  label: string
) => `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  add(): string {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tally (n INTEGER)");
    this.ctx.storage.sql.exec("INSERT INTO tally VALUES (1)");
    return this.count();
  }

  count(): string {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tally (n INTEGER)");
    const [row] = this.ctx.storage.sql.exec("SELECT count(*) AS n FROM tally").toArray();
    return \`\${String(row?.n ?? 0)} ${label}\`;
  }
}
`;

const screen = `import { callServer } from "@grasp-os/sdk/screen";
import { Button } from "@grasp-os/ui/components/button";
import { useState } from "react";

export default function Tally() {
  const [tally, setTally] = useState("none yet");
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button onClick={() => { void callServer<string>("add").then(setTally); }} variant="outline">
        Add one
      </Button>
      <output>{tally}</output>
    </main>
  );
}
`;

test("a chat builds an App in a studio, the chat on the left and a preview that changes none of the App's data on the right", async ({
  browser,
}) => {
  const { builder } = peopleIn("chatPreview");
  const { core, api } = apiOf(builder);
  const tag = crypto.randomUUID().slice(0, 8);
  const name = `Tally ${tag}`;
  try {
    const app = await api.apps.create({ name });
    const { version } = await api.apps.files.commit(
      app.id,
      { "screens/tally.tsx": screen, "app/server.ts": server("in the App") },
      "A tally"
    );
    await api.apps.versions.setCurrent(app.id, version);
    await ordinaryData(app.id);
    const chat = await api.chats.create(`Build ${tag}`);

    // Nothing built yet: the chat alone, the chats' sidebar open beside it.
    const page = await pageOf(browser, builder);
    // While `failDrafts` holds, reading the chat's drafts goes to an API
    // this stack has switched off (improvement signals), which core
    // refuses: as a read that fails.
    let failDrafts = false;
    await page.routeWebSocket("**/rpc", (socket) => {
      const toCore = socket.connectToServer();
      socket.onMessage((message) => {
        const text = String(message);
        toCore.send(
          failDrafts
            ? text.replaceAll('["chats","drafts"]', '["signals","list"]')
            : text
        );
      });
    });
    await page.goto(`/?chat=${chat.id}`);
    const thread = page.getByRole("region", {
      name: `Build ${tag}`,
      exact: true,
    });
    const studio = page.getByRole("region", { name, exact: true });
    await expect(thread).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Fold the chats" })
    ).toBeVisible();
    await expect(studio).toHaveCount(0);

    // Its agent writes a draft: the App stands on the right, the chat
    // moves to its left, and the sidebar folds to give it the room.
    await writeDraft(builder.userId, chat.id, app.id, version, {
      "app/server.ts": server("in the preview"),
    });
    // A read of it that fails says so beside the chat, and is tried again
    // from there.
    failDrafts = true;
    await page.reload();
    await expect(
      thread.getByText("The engines this chat builds didn't load.")
    ).toBeVisible();
    await expect(studio).toHaveCount(0);
    failDrafts = false;
    await thread.getByRole("button", { name: "Try again" }).click();
    // Named by its top row's heading: the App's name.
    await expect(studio).toBeVisible();
    await expect(
      thread.getByText("The engines this chat builds didn't load.")
    ).toHaveCount(0);
    await expect(studio).toContainText(
      "1 file changed in this chat, not proposed yet"
    );
    await expect(
      page.getByRole("button", { name: "Expand the chats" })
    ).toBeVisible();
    const chatBox = await thread.boundingBox();
    const appBox = await studio.boundingBox();
    expect(chatBox).not.toBeNull();
    expect(appBox).not.toBeNull();
    expect((chatBox?.x ?? 0) + (chatBox?.width ?? 0)).toBeLessThanOrEqual(
      (appBox?.x ?? 0) + 1
    );

    const preview = studio.getByRole("region", { name: `Preview of ${name}` });
    await expect(preview).toContainText(
      "Preview: changes nothing, reads no real data"
    );
    const frame = preview.frameLocator("iframe");
    await frame.getByRole("button", { name: "Add one" }).click();
    await expect(frame.getByRole("status")).toHaveText("1 in the preview");
    await frame.getByRole("button", { name: "Add one" }).click();
    await expect(frame.getByRole("status")).toHaveText("2 in the preview");

    // The App's own storage has none of it.
    const counted = await api.screens.call(app.id, "count", []);
    expect(counted).toBe("0 in the App");

    // A phone: the chat and the App take turns, the App first. The
    // preview keeps what it shows through the turns: it isn't loaded anew.
    await page.setViewportSize({ width: 390, height: 844 });
    const showChat = page.getByRole("button", { name: "Chat", exact: true });
    const showApp = page.getByRole("button", { name: "App", exact: true });
    await expect(showApp).toHaveAttribute("aria-pressed", "true");
    await expect(studio).toBeVisible();
    await expect(thread).toBeHidden();
    await frame.getByRole("button", { name: "Add one" }).click();
    await expect(frame.getByRole("status")).toHaveText("3 in the preview");
    await showChat.click();
    await expect(showChat).toHaveAttribute("aria-pressed", "true");
    await expect(thread).toBeVisible();
    await expect(studio).toBeHidden();
    await showApp.click();
    await expect(studio).toBeVisible();
    await expect(frame.getByRole("status")).toHaveText("3 in the preview");

    // Wider than lg the two stand side by side again, with no turns to
    // take; narrower again, the App is where it was. The preview stays.
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(showApp).toHaveCount(0);
    await expect(thread).toBeVisible();
    await expect(studio).toBeVisible();
    await expect(frame.getByRole("status")).toHaveText("3 in the preview");
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(showApp).toHaveAttribute("aria-pressed", "true");
    await expect(thread).toBeHidden();
    await expect(frame.getByRole("status")).toHaveText("3 in the preview");
    await page.setViewportSize({ width: 1280, height: 720 });

    // View app opens the App itself.
    await studio.getByRole("link", { name: "View app" }).click();
    await expect(page).toHaveURL(new RegExp(`/engines/${app.id}$`, "u"));
    await expect(
      page.getByRole("heading", { level: 1, name, exact: true })
    ).toBeVisible();
  } finally {
    core[Symbol.dispose]();
  }
});
