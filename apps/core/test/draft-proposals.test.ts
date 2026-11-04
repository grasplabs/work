import { appIdSchema, chatIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { chatsOf, chatWithDraft } from "./previews.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// A chat's draft of an App proposed by the chat's person themselves
// (`chats.proposeDraft`), from the App's workspace, when its agent never
// proposed it: committed as the App's next version, up for review, as the
// agent's proposal is. What could go wrong: a draft that fails its checks
// committed anyway; someone proposing a chat that isn't theirs, or an App
// they don't build; a draft written in a chat that read restricted data
// committed, which its agent couldn't do; the proposal recorded as the
// agent's, or not at all; the version made current on its own.

const idp = mockIdp();

/** A screen whose button is restyled, which @shadcn/lint refuses. */
const restyled = `import { Button } from "@grasp-os/ui/components/button";

export default function Desk() {
  return (
    <main className="flex flex-col gap-4 p-6">
      <Button className="rounded-full">Approve</Button>
    </main>
  );
}
`;

/** The same screen with the button's own variant: what the lint asks for. */
const fixed = restyled.replace(
  '<Button className="rounded-full">',
  '<Button variant="outline">'
);

/** A builder's App at version 1, live, and the builder's chat with a draft of `screen`. */
const drafted = async (screen: string) => {
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: `Desk ${unique()}` });
  await release(builder, id, { "AGENTS.md": "# Desk\n" });
  const app = appIdSchema.parse(id);
  const { chatId } = await chatWithDraft(builder, app, {
    "screens/desk.tsx": screen,
  });
  return { builder, app, chatId };
};

describe("a person proposing a chat's draft", { timeout: 180_000 }, () => {
  it("commits it as the App's next version, up for review, as the person, and drops the draft", async () => {
    const { builder, app, chatId } = await drafted(fixed);

    const version = await builder.api.chats.proposeDraft(chatId, app, "A desk");
    const review = await builder.api.apps.versions.review(app, version);
    const events = await allEvents();

    expect({
      version,
      app: await builder.api.apps.get(app),
      review: {
        author: review.version.author,
        message: review.version.message,
        proposedBy: review.version.proposedBy,
        files: review.files,
      },
      drafts: await builder.api.chats.drafts(chatId),
      recorded: events
        .filter(
          ({ action, target, detail }) =>
            target?.id === app &&
            detail?.version === 2 &&
            (action === "app.committed" || action === "app.version.proposed")
        )
        .map(({ action, actor, detail }) => ({
          action,
          actor,
          chat: detail?.chat,
        }))
        .toSorted((one, other) => one.action.localeCompare(other.action)),
    }).toMatchObject({
      version: 2,
      // Up for review: version 1 stays live until a builder publishes it.
      app: { currentVersion: 1, pendingVersion: 2 },
      review: {
        author: builder.userId,
        message: "A desk",
        proposedBy: null,
        files: [{ path: "screens/desk.tsx", change: "added" }],
      },
      drafts: [],
      recorded: [
        {
          action: "app.committed",
          actor: { type: "person", userId: builder.userId },
          chat: undefined,
        },
        {
          action: "app.version.proposed",
          actor: { type: "person", userId: builder.userId },
          // Which chat's draft it was: the version names no agent.
          chat: chatId,
        },
      ],
    });
  });

  it("commits nothing that fails its checks, and keeps the draft", async () => {
    const { builder, app, chatId } = await drafted(restyled);

    const refused = await outcome(
      builder.api.chats.proposeDraft(chatId, app, "A desk")
    );

    const versions = await builder.api.apps.versions.list(app);
    const drafts = await builder.api.chats.drafts(chatId);

    expect({
      refused,
      app: await builder.api.apps.get(app),
      versions: versions.map(({ version }) => version),
      drafts: drafts.map(({ app: drafting }) => drafting),
    }).toMatchObject({
      refused: "app.draft_failed",
      app: { pendingVersion: null },
      versions: [1],
      drafts: [app],
    });
  });

  it("is only the chat's own person's, while they build the App, and never from a restricted chat", async () => {
    const { builder, app, chatId } = await drafted(fixed);
    const [other, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
    ]);
    await builder.api.apps.members.add(app, {
      type: "person",
      id: other.userId,
      role: "builder",
    });
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });

    const othersChat = await outcome(
      other.api.chats.proposeDraft(chatId, app, "Mine now")
    );
    const notBuilding = await outcome(
      user.api.chats.proposeDraft(chatId, app, "Mine now")
    );
    await runInDurableObject(chatsOf(builder), (instance) =>
      instance.restrictChat(chatIdSchema.parse(chatId))
    );
    const restricted = await outcome(
      builder.api.chats.proposeDraft(chatId, app, "From a restricted chat")
    );

    const versions = await builder.api.apps.versions.list(app);

    expect({
      othersChat,
      notBuilding,
      restricted,
      app: await builder.api.apps.get(app),
      versions: versions.map(({ version }) => version),
    }).toMatchObject({
      othersChat: "agent.chat_not_found",
      notBuilding: "role.forbidden",
      restricted: "permission.restricted",
      app: { pendingVersion: null },
      versions: [1],
    });
  });

  it("commits nothing when the chat read restricted data after its draft was checked", async () => {
    const { builder, app, chatId } = await drafted(fixed);
    // The chat is restricted as the version's files are stored, after the
    // draft was read and checked and right before the commit: its agent
    // read restricted data meanwhile, and may have written it there.
    const { FILES: files } = env;
    let restricting: Promise<boolean> | undefined;
    const restrictOnce = async (): Promise<boolean> => {
      restricting ??= runInDurableObject(chatsOf(builder), (instance) =>
        instance.restrictChat(chatIdSchema.parse(chatId))
      );
      return await restricting;
    };
    env.FILES = new Proxy(files, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        return async (...args: unknown[]): Promise<unknown> => {
          const [key] = args;
          if (
            property === "put" &&
            typeof key === "string" &&
            key.startsWith(`apps/${app}/trees/`)
          ) {
            await restrictOnce();
          }
          return await Reflect.apply(value, target, args);
        };
      },
    });
    let refused: string;
    try {
      refused = await outcome(
        builder.api.chats.proposeDraft(chatId, app, "A desk")
      );
    } finally {
      env.FILES = files;
    }
    const versions = await builder.api.apps.versions.list(app);

    expect({
      restricted: restricting !== undefined,
      refused,
      app: await builder.api.apps.get(app),
      versions: versions.map(({ version }) => version),
    }).toMatchObject({
      restricted: true,
      refused: "permission.restricted",
      app: { pendingVersion: null },
      versions: [1],
    });
  });
});
