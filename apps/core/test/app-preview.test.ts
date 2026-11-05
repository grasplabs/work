import { fallbackRevision } from "@grasp-os/shared/chat";
import { appIdSchema, chatIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import type { AppVersionPush } from "@grasp-os/shared/screens";
import { describe, expect, it } from "vite-plus/test";

import { openTestRun } from "./agent-chat.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { deskFiles, notesApp, notesFiles } from "./preview-drafts.ts";
import { chatsOf, chatWithDraft, outcome } from "./previews.ts";
import { loadFrame, servedFrom } from "./screen-frames.ts";
import { followedVersion, signedInApi } from "./sign-in.ts";

// A chat's preview of its draft of an App: the draft's screens and server
// code, run for the chat's person with no side effects. These tests start
// from the ways it can fail: the draft's code writes to the App's real
// storage or Knowledge, calls a connection or another App, records a
// statistic, reaches the network, or reads real data it could show; a
// name a permission asked for and not granted gives the preview reaches
// what only a grant allows; a preview keeps what an earlier draft wrote;
// someone other than the chat's person, or a person who no longer builds
// the App, previews it; and a preview with nothing to show while the App
// has a version: before the chat's first write, or once its changes went.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

const screen = `export default function Desk() {
  return <main>Desk</main>;
}
`;

/** The App as released: a screen. */
const released = {
  "screens/desk.tsx": screen,
};

/** A new App of `builder`'s, released. */
const newApp = async (
  builder: Person,
  name: string,
  files: Record<string, string>
): Promise<AppId> => {
  const { id } = await builder.api.apps.create({ name });
  await release(builder, id, files);
  return appIdSchema.parse(id);
};

/** What a call answered, or the code of the error it failed with. */
const answer = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    return await promise;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? error.code
      : String(error);
  }
};

/** The notes App's desk screen, saying `word` before its titles. */
const deskSaying = (word: string): string =>
  (notesFiles("drafted")["screens/desk.tsx"] ?? "").replace(
    'titles.join(", ")',
    `"${word} " + titles.join(", ")`
  );

/** `person`'s chat of App `app`, its own (`chats.forApp`). */
const appChat = async (person: Person, app: AppId): Promise<ChatId> => {
  const chat = await person.api.chats.forApp(app);
  return chatIdSchema.parse(chat.id);
};

/** Writes `changes` into the chat's draft of `app` over version 1, at `revision`. */
const writeDraft = async (
  person: Person,
  chatId: ChatId,
  app: AppId,
  changes: Record<string, string | null>,
  revision: number
): Promise<void> => {
  const saved = await chatsOf(person).saveDraft(
    chatId,
    app,
    1,
    changes,
    [],
    revision,
    await openTestRun(chatsOf(person), chatId)
  );
  if (!saved) {
    throw new Error("The draft wasn't written");
  }
};

/**
 * A call of `notes.titles`, as the screen of the App's latest version
 * names it: by its path, whatever the draft calls its functions.
 */
const titlesRequest = JSON.stringify({
  reference: { name: "notes.titles", kind: "query" },
  input: {},
});

/** What a call of `notes.titles` in the chat's preview of `app` at `revision` answers. */
const titlesAt = async (
  person: Person,
  chatId: ChatId,
  app: AppId,
  revision: number
): Promise<unknown> =>
  outcome(
    await person.api.chats.previewFunction(chatId, app, revision, titlesRequest)
  );

/** The notes App's server code with `notes.titles` renamed `notes.allTitles`. */
const renamedTitles = (notesFiles("drafted")["server/notes.ts"] ?? "").replace(
  "export const titles = query(",
  "export const allTitles = query("
);

describe("previewing a chat's draft", { timeout: 120_000 }, () => {
  it("shows the App's latest version, its functions running, while the chat has written nothing, then takes the chat's first write", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { chats } = builder.api;
    const chatId = await appChat(builder, app);

    const before = await chats.preview(chatId, app);
    const frame = await loadFrame(before);
    const latest = {
      drafts: await chats.drafts(chatId),
      revision: before.revision,
      screens: before.screens,
      appVersion: before.refresh?.appVersion,
      titles: await titlesAt(builder, chatId, app, before.revision),
    };
    await writeDraft(
      builder,
      chatId,
      app,
      { "screens/desk.tsx": deskSaying("Drafted") },
      before.revision
    );
    const [draft] = await chats.drafts(chatId);
    // The frame opened before the write takes it, at the draft's revision.
    const update = await chats.previewUpdate(chatId, app, "desk", 1);
    // As the frame imports it: under the token it opened with.
    const served = await servedFrom(frame, update.refresh.entry);

    expect({
      latest,
      draft: { changed: draft?.changed, revision: draft?.revision },
      update: {
        revision: update.refresh.revision,
        appVersion: update.refresh.appVersion,
        served: served.status,
        drafted: served.code.includes('"Drafted "'),
      },
    }).toStrictEqual({
      latest: {
        drafts: [],
        revision: 0,
        screens: ["desk"],
        appVersion: 1,
        titles: [],
      },
      draft: { changed: ["screens/desk.tsx"], revision: 1 },
      update: {
        revision: 1,
        appVersion: undefined,
        served: 200,
        drafted: true,
      },
    });
  });

  it("previews only an App the chat changes, or the App whose chat it is", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const other = await notesApp(builder);
    const { chats } = builder.api;
    const chatId = await appChat(builder, app);
    const { id: elsewhere } = await chats.create("Elsewhere");
    const own = await chats.preview(chatId, app);

    expect({
      // Neither this App's chat nor one that changes it.
      otherApp: await answer(chats.preview(chatId, other)),
      otherChat: await answer(chats.preview(elsewhere, app)),
      ownApp: own.revision,
    }).toStrictEqual({
      otherApp: "app.not_in_chat",
      otherChat: "app.not_in_chat",
      ownApp: 0,
    });
  });

  it("opens a draft whose screen doesn't build on the App's latest version, with its own server code, keeping what it runs out of the draft's check, then takes the next write that builds", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { chats } = builder.api;
    const chatId = await appChat(builder, app);
    // The draft renames the function the latest version's screen calls.
    await writeDraft(
      builder,
      chatId,
      app,
      {
        "screens/desk.tsx": "export default function Desk( {",
        "server/notes.ts": renamedTitles,
      },
      0
    );

    const broken = await chats.preview(chatId, app);
    // The latest version's build, under a token of its own frame's.
    const frame = await loadFrame(broken);
    const opened = {
      fallback: broken.fallback,
      loaded: frame?.status,
      revision: broken.revision,
      refresh: {
        revision: broken.refresh?.revision,
        appVersion: broken.refresh?.appVersion,
      },
      screen: broken.screen,
      // Its calls run on the latest version's own server code, at the
      // revision the frame names.
      titles: await titlesAt(builder, chatId, app, broken.revision),
      // Asked for the draft's screen, it still doesn't build.
      update: await answer(chats.previewUpdate(chatId, app, "desk", 1)),
    };
    // The draft's own screen never ran: the agent's check saw nothing.
    const reports = await chatsOf(builder).previewReports(chatId, app, 1, 0);
    await writeDraft(
      builder,
      chatId,
      app,
      { "screens/desk.tsx": deskSaying("Fixed") },
      1
    );
    const { refresh } = await chats.previewUpdate(chatId, app, "desk", 2);
    const fixed = await servedFrom(frame, refresh.entry);

    expect({
      opened,
      reports: { seen: reports.seen, problems: reports.problems.length },
      fixed: {
        revision: refresh.revision,
        appVersion: refresh.appVersion,
        served: fixed.status,
        says: fixed.code.includes('"Fixed "'),
      },
    }).toStrictEqual({
      opened: {
        fallback: true,
        loaded: 200,
        revision: fallbackRevision,
        refresh: { revision: 1, appVersion: 1 },
        screen: "desk",
        titles: [],
        update: "screen.build_failed",
      },
      reports: { seen: false, problems: 0 },
      fixed: { revision: 2, appVersion: undefined, served: 200, says: true },
    });
  });

  it("opens a draft whose server code doesn't build, or that deletes every screen, on the App's latest version", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { chats } = builder.api;
    const serverChat = await appChat(builder, app);
    await writeDraft(
      builder,
      serverChat,
      app,
      { "server/notes.ts": "export const titles = query({ (" },
      0
    );
    const { chatId: screenless } = await chatWithDraft(builder, app, {
      "screens/desk.tsx": null,
    });

    const server = await chats.preview(serverChat, app);
    const deleted = await chats.preview(screenless, app);

    expect({
      server: {
        fallback: server.fallback,
        titles: await titlesAt(builder, serverChat, app, server.revision),
      },
      deleted: { fallback: deleted.fallback, screen: deleted.screen },
    }).toStrictEqual({
      server: { fallback: true, titles: [] },
      deleted: { fallback: true, screen: "desk" },
    });
  });

  it("refuses a draft that doesn't build only for an App with no version that does", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Unbuilt" });
    const app = appIdSchema.parse(id);
    const chatId = await appChat(builder, app);
    const saved = await chatsOf(builder).saveDraft(
      chatId,
      app,
      null,
      {
        ...notesFiles("unbuilt"),
        "screens/desk.tsx": "export default function Desk( {",
      },
      [],
      0,
      await openTestRun(chatsOf(builder), chatId)
    );

    expect({
      saved,
      broken: await answer(builder.api.chats.preview(chatId, app)),
    }).toStrictEqual({ saved: true, broken: "screen.build_failed" });
  });

  it("shows the App's latest version again once the chat's draft is discarded", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { chats } = builder.api;
    const chatId = await appChat(builder, app);
    await writeDraft(
      builder,
      chatId,
      app,
      { "screens/desk.tsx": deskSaying("Drafted") },
      0
    );

    await chats.discardDraft(chatId, app);
    const [discarded] = await chats.drafts(chatId);
    const after = await chats.preview(chatId, app);

    expect({
      discarded: { changed: discarded?.changed, revision: discarded?.revision },
      after: {
        revision: after.revision,
        screens: after.screens,
        appVersion: after.refresh?.appVersion,
      },
      titles: await titlesAt(builder, chatId, app, after.revision),
    }).toStrictEqual({
      discarded: { changed: [], revision: 2 },
      after: { revision: 2, screens: ["desk"], appVersion: 1 },
      titles: [],
    });
  });

  it("tells the open preview of a chat that changes nothing of each version committed or proposed elsewhere, and gives it that version at the same revision", async () => {
    const builder = await signedInApi(idp, "builder");
    // An App whose drafts pass their checks to be proposed.
    const app = await newApp(builder, "Desk", deskFiles("Released"));
    const { chats } = builder.api;
    const chatId = await appChat(builder, app);
    const opened = await chats.preview(chatId, app);
    const frame = await loadFrame(opened);
    /**
     * Follows the App's version as the open frame does, past its first
     * push: `told` is the next push that tells of another version, past
     * those that only ask the page to check its access again (`recheck`).
     */
    const follow = async () => {
      const followed = await followedVersion(
        async (onVersion) =>
          await builder.api.screens.watchVersion(app, onVersion)
      );
      await followed.next();
      const told = async (): Promise<AppVersionPush> => {
        let push = await followed.next();
        while (push.type === "current" && push.recheck) {
          // oxlint-disable-next-line no-await-in-loop -- one push after the other
          push = await followed.next();
        }
        return push;
      };
      return { told, release: followed.release };
    };
    /** What the open frame is given at its revision now. */
    const updated = async () => {
      const { refresh } = await chats.previewUpdate(
        chatId,
        app,
        "desk",
        opened.revision
      );
      // As the open frame imports it: under the token it opened with.
      const served = await servedFrom(frame, refresh.entry);
      return {
        revision: refresh.revision,
        appVersion: refresh.appVersion,
        served: served.status,
        says: served.code.includes("Committed"),
      };
    };

    // A commit from the App's code, not made current.
    const beforeCommit = await follow();
    await builder.api.apps.files.commit(
      app,
      { "screens/desk.tsx": deskFiles("Committed")["screens/desk.tsx"] ?? "" },
      "Elsewhere"
    );
    const committed = await beforeCommit.told();
    await beforeCommit.release();
    const afterCommit = await updated();
    // Another chat's draft, proposed.
    const { chatId: proposing } = await chatWithDraft(builder, app, {
      "schema.ts": `${deskFiles()["schema.ts"] ?? ""}// Proposed elsewhere.\n`,
    });
    const beforeProposal = await follow();
    await chats.proposeDraft(proposing, app, "Proposed elsewhere");
    const proposed = await beforeProposal.told();
    await beforeProposal.release();
    const afterProposal = await updated();

    expect({
      opened: {
        revision: opened.revision,
        appVersion: opened.refresh?.appVersion,
      },
      pushes: [committed.type, proposed.type],
      afterCommit,
      afterProposal: afterProposal.appVersion,
    }).toStrictEqual({
      opened: { revision: 0, appVersion: 1 },
      pushes: ["current", "current"],
      afterCommit: { revision: 0, appVersion: 2, served: 200, says: true },
      afterProposal: 3,
    });
  });

  it("has nothing to show of an App with no version before the chat's first write, and shows the first committed elsewhere", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Empty" });
    const app = appIdSchema.parse(id);
    const chatId = await appChat(builder, app);

    const before = await answer(builder.api.chats.preview(chatId, app));
    await builder.api.apps.files.commit(app, deskFiles("Committed"), "First");
    const after = await builder.api.chats.preview(chatId, app);

    expect({
      before,
      after: { screen: after.screen, appVersion: after.refresh?.appVersion },
    }).toStrictEqual({
      before: "app.not_running",
      after: { screen: "desk", appVersion: 1 },
    });
  });

  it("says which of its paths a draft deletes, and previews no screen it deleted", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder, "Invoice desk", released);
    const { chatId } = await chatWithDraft(builder, app, {
      "screens/desk.tsx": null,
      "screens/list.tsx": screen,
    });
    const { chats } = builder.api;

    const [draft] = await chats.drafts(chatId);
    const first = await chats.preview(chatId, app);

    expect({
      changed: draft?.changed,
      deleted: draft?.deleted,
      first: { screen: first.screen, screens: first.screens },
      gone: await answer(chats.preview(chatId, app, "desk")),
    }).toStrictEqual({
      changed: ["screens/desk.tsx", "screens/list.tsx"],
      deleted: ["screens/desk.tsx"],
      first: { screen: "list", screens: ["list"] },
      gone: "screen.not_found",
    });
  });
});
