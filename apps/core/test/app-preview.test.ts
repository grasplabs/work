import { shownAt } from "@grasp-os/shared/chat";
import type { PreviewAt, PreviewBundle } from "@grasp-os/shared/chat";
import { appIdSchema, chatIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import type { AppVersionPush } from "@grasp-os/shared/screens";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { openTestRun } from "./agent-chat.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  deskFiles,
  livePushes,
  notesApp,
  notesFiles,
} from "./preview-drafts.ts";
import { chatsOf, chatWithDraft, outcome, refreshed } from "./previews.ts";
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

/** What a call of `notes.titles` in the chat's preview of `app` at `at` answers. */
const titlesAt = async (
  person: Person,
  chatId: ChatId,
  app: AppId,
  at: PreviewAt
): Promise<unknown> =>
  outcome(
    await person.api.chats.previewFunction(chatId, app, at, titlesRequest)
  );

/** What the calls of a frame opened on `bundle` name, as the page has them. */
const callsAt = (bundle: PreviewBundle): PreviewAt =>
  bundle.refresh === undefined ? bundle.revision : shownAt(bundle.refresh);

/** The notes App's server code with `notes.titles` answering `title` alone. */
const titlesSaying = (title: string): string =>
  (notesFiles("drafted")["server/notes.ts"] ?? "").replace(
    '(await ctx.db.query("notes").take(100)).map((note) => note.title).sort()',
    JSON.stringify([title])
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
      titles: await titlesAt(builder, chatId, app, callsAt(before)),
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
    const update = refreshed(
      await chats.previewUpdate(chatId, app, 1, {
        screen: "desk",
        appVersion: 1,
      })
    );
    // As the frame imports it: under the token it opened with.
    const served = await servedFrom(frame, update.entry);

    expect({
      latest,
      draft: { changed: draft?.changed, revision: draft?.revision },
      update: {
        revision: update.revision,
        appVersion: update.appVersion,
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
      // Its calls run on the latest version's own server code: they name
      // that version.
      callsAt: callsAt(broken),
      titles: await titlesAt(builder, chatId, app, callsAt(broken)),
      // Asked for the draft's screen, it still doesn't build.
      update: await answer(
        chats.previewUpdate(chatId, app, 1, { screen: "desk", appVersion: 1 })
      ),
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
    const refresh = refreshed(
      await chats.previewUpdate(chatId, app, 2, {
        screen: "desk",
        appVersion: 1,
      })
    );
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
        revision: 1,
        refresh: { revision: 1, appVersion: 1 },
        screen: "desk",
        callsAt: { appVersion: 1 },
        titles: [],
        update: "screen.build_failed",
      },
      reports: { seen: false, problems: 0 },
      fixed: { revision: 2, appVersion: undefined, served: 200, says: true },
    });
  });

  it("keeps serving the App's latest version a frame shows in place of a draft whose screen doesn't build, its live query and store included, while the draft's update seals the draft's server code", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { chats } = builder.api;
    const chatId = await appChat(builder, app);
    // The draft's server code seals; its screen doesn't build.
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
    const at = callsAt(broken);
    /** Has the frame on the version write a note titled `title`. */
    const create = async (title: string): Promise<unknown> =>
      outcome(
        await chats.previewFunction(
          chatId,
          app,
          at,
          JSON.stringify({
            reference: { name: "notes.create", kind: "mutation" },
            input: { title },
          })
        )
      );
    await create("Before");
    const live = livePushes();
    await chats.previewWatchQuery(chatId, app, at, titlesRequest, live.push);
    await live.until((latest) => {
      expect(latest?.result).toStrictEqual({ ok: true, value: ["Before"] });
    });
    // The page checks the draft's update: that builds the draft's screen,
    // which seals the draft's server code.
    const update = await answer(
      chats.previewUpdate(chatId, app, 1, { screen: "desk", appVersion: 1 })
    );
    // The frame still shows the version, on its own store: what it wrote
    // before is there, and what it writes now its live query reads.
    const kept = await titlesAt(builder, chatId, app, at);
    const refused = (): unknown[] =>
      live.pushed.filter(
        ({ result }) => !z.object({ ok: z.boolean() }).parse(result).ok
      );
    expect({ at, update, kept, refused: refused() }).toStrictEqual({
      at: { appVersion: 1 },
      update: "screen.build_failed",
      kept: ["Before"],
      refused: [],
    });

    await create("After");
    await live.until((latest) => {
      expect(latest?.result).toStrictEqual({
        ok: true,
        value: ["After", "Before"],
      });
    });
    expect(refused()).toStrictEqual([]);
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

    // The draft's screens build against the App's latest version's server
    // code in place of its own, which doesn't: the problem is being fixed.
    expect({
      server: {
        fallback: server.fallback,
        serverUnbuilt: server.refresh?.serverUnbuilt,
        titles: await titlesAt(builder, serverChat, app, callsAt(server)),
      },
      deleted: { fallback: deleted.fallback, screen: deleted.screen },
    }).toStrictEqual({
      server: { fallback: undefined, serverUnbuilt: true, titles: [] },
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

  it("says the server code doesn't build, and where, when no server code of the App's builds, never that it has none", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Unbuilt" });
    const app = appIdSchema.parse(id);
    const chatId = await appChat(builder, app);
    const files = notesFiles("unbuilt");
    await chatsOf(builder).saveDraft(
      chatId,
      app,
      null,
      {
        ...files,
        "server/notes.ts": (files["server/notes.ts"] ?? "").replace(
          'ctx.db.query("notes").take(100)',
          'ctx.db.query("notes").take(1000)'
        ),
      },
      [],
      0,
      await openTestRun(chatsOf(builder), chatId)
    );
    let refused: unknown;
    try {
      await builder.api.chats.preview(chatId, app);
    } catch (error) {
      refused = error;
    }
    const details = z
      .object({
        code: z.string(),
        details: z.object({
          diagnostics: z.array(
            z.object({ file: z.string().nullable(), message: z.string() })
          ),
        }),
      })
      .parse(refused);

    // The type error names the limit, and what to use past it.
    expect({
      code: details.code,
      files: details.details.diagnostics.map(({ file }) => file),
      namesLimit: details.details.diagnostics.some(({ message }) =>
        message.includes(
          "take() returns 0 to 100 records: use paginate() for more"
        )
      ),
    }).toStrictEqual({
      code: "version.build_failed",
      files: ["server/notes.ts"],
      namesLimit: true,
    });
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
      titles: await titlesAt(builder, chatId, app, callsAt(after)),
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
    /**
     * What the open frame, on version 1, is answered at its revision now,
     * and what it opens on afresh.
     */
    const updated = async () => {
      const answered = await chats.previewUpdate(chatId, app, opened.revision, {
        screen: "desk",
        ...(opened.refresh?.appVersion === undefined
          ? {}
          : { appVersion: opened.refresh.appVersion }),
      });
      const reopened = await chats.preview(chatId, app, "desk");
      // As its frame imports it: under the token it opened with.
      const served = await servedFrom(
        await loadFrame(reopened),
        reopened.refresh?.entry ?? ""
      );
      return {
        answered,
        revision: reopened.revision,
        appVersion: reopened.refresh?.appVersion,
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
      "server/schema.ts": `${deskFiles()["server/schema.ts"] ?? ""}// Proposed elsewhere.\n`,
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
      afterCommit: {
        answered: { app, restart: true },
        revision: 0,
        appVersion: 2,
        served: 200,
        says: true,
      },
      afterProposal: 3,
    });
  });

  it("runs each frame's calls on the App's version it shows: one still on version 1 once another frame opened on version 2", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { chats } = builder.api;
    const chatId = await appChat(builder, app);
    const first = await chats.preview(chatId, app);
    await builder.api.apps.files.commit(
      app,
      { "server/notes.ts": titlesSaying("from version 2") },
      "Second"
    );
    const second = await chats.preview(chatId, app);
    // Back and forth, as two frames open side by side call.
    const calls = [
      await titlesAt(builder, chatId, app, callsAt(first)),
      await titlesAt(builder, chatId, app, callsAt(second)),
      await titlesAt(builder, chatId, app, callsAt(first)),
    ];

    expect({
      at: [callsAt(first), callsAt(second)],
      calls,
      // A version of the App the frame names that it doesn't have.
      missing: await answer(titlesAt(builder, chatId, app, { appVersion: 9 })),
    }).toStrictEqual({
      at: [{ appVersion: 1 }, { appVersion: 2 }],
      calls: [[], ["from version 2"], []],
      missing: "app.version_not_found",
    });
  });

  it("starts a frame afresh on another version of the App, on its screen when that version has it and its first otherwise", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { chats } = builder.api;
    const chatId = await appChat(builder, app);
    const opened = await chats.preview(chatId, app, "desk");
    const same = await chats.previewUpdate(chatId, app, opened.revision, {
      screen: "desk",
      appVersion: 1,
    });
    // Version 2 names the page `board`.
    await builder.api.apps.files.commit(
      app,
      {
        "screens/desk.tsx": null,
        "screens/board.tsx": notesFiles("board")["screens/desk.tsx"] ?? "",
      },
      "Board"
    );
    const moved = await chats.previewUpdate(chatId, app, opened.revision, {
      screen: "desk",
      appVersion: 1,
    });
    const reopened = await chats.preview(chatId, app, "desk");

    expect({
      same,
      moved,
      reopened: {
        screen: reopened.screen,
        screens: reopened.screens,
        callsAt: callsAt(reopened),
      },
    }).toStrictEqual({
      same: { app, unchanged: true },
      moved: { app, restart: true },
      reopened: {
        screen: "board",
        screens: ["board"],
        callsAt: { appVersion: 2 },
      },
    });
  });

  it("moves a frame shown in place of a draft that doesn't build on to each newer version of the App while the draft stays broken", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { chats } = builder.api;
    const chatId = await appChat(builder, app);
    await writeDraft(
      builder,
      chatId,
      app,
      { "screens/desk.tsx": "export default function Desk( {" },
      0
    );
    const broken = await chats.preview(chatId, app);
    // The App's version it shows is still the latest: the draft's own
    // failure, which the frame shows as being fixed.
    const still = await answer(
      chats.previewUpdate(chatId, app, broken.revision, {
        screen: "desk",
        appVersion: 1,
      })
    );
    await builder.api.apps.files.commit(
      app,
      { "server/notes.ts": titlesSaying("from version 2") },
      "Second"
    );
    const moved = await chats.previewUpdate(chatId, app, broken.revision, {
      screen: "desk",
      appVersion: 1,
    });
    const reopened = await chats.preview(chatId, app);

    expect({
      opened: { fallback: broken.fallback, callsAt: callsAt(broken) },
      still,
      moved,
      reopened: {
        fallback: reopened.fallback,
        callsAt: callsAt(reopened),
        titles: await titlesAt(builder, chatId, app, callsAt(reopened)),
      },
    }).toStrictEqual({
      opened: { fallback: true, callsAt: { appVersion: 1 } },
      still: "screen.build_failed",
      moved: { app, restart: true },
      reopened: {
        fallback: true,
        callsAt: { appVersion: 2 },
        titles: ["from version 2"],
      },
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

  it("brings back the screen a frame was opened for once the draft's build of it builds, after showing the App's version of another in its place", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { chats } = builder.api;
    const chatId = await appChat(builder, app);
    // The draft replaces `desk` with a `board` that doesn't build.
    await writeDraft(
      builder,
      chatId,
      app,
      {
        "screens/desk.tsx": null,
        "screens/board.tsx": "export default function Board( {",
      },
      0
    );
    const opened = await chats.preview(chatId, app, "board");
    // What the frame says it shows as it asks: `desk`, opened for `board`.
    const shown = {
      screen: opened.screen,
      asked: "board",
      ...(opened.refresh?.appVersion === undefined
        ? {}
        : { appVersion: opened.refresh.appVersion }),
    };
    const still = await answer(chats.previewUpdate(chatId, app, 1, shown));
    await writeDraft(
      builder,
      chatId,
      app,
      { "screens/board.tsx": notesFiles("board")["screens/desk.tsx"] ?? "" },
      1
    );
    const fixed = await chats.previewUpdate(chatId, app, 2, shown);
    const reopened = await chats.preview(chatId, app, "board");
    // Opened for a screen the draft has no longer: its first.
    const elsewhere = await chats.preview(chatId, app, "nowhere");

    expect({
      opened: {
        fallback: opened.fallback,
        screen: opened.screen,
        callsAt: callsAt(opened),
      },
      still,
      fixed,
      reopened: {
        fallback: reopened.fallback,
        screen: reopened.screen,
        callsAt: callsAt(reopened),
      },
      elsewhere: elsewhere.screen,
    }).toStrictEqual({
      opened: { fallback: true, screen: "desk", callsAt: { appVersion: 1 } },
      still: "screen.build_failed",
      fixed: { app, restart: true },
      reopened: { fallback: undefined, screen: "board", callsAt: 2 },
      elsewhere: "board",
    });
  });

  it("starts a frame on the draft's changes afresh on the App's latest version once the draft deletes every screen", async () => {
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
    // Opened with no page named, on the draft's changes of its first.
    const opened = await chats.preview(chatId, app);
    await writeDraft(builder, chatId, app, { "screens/desk.tsx": null }, 1);
    const updated = await answer(
      chats.previewUpdate(chatId, app, 2, { screen: opened.screen })
    );
    const reopened = await chats.preview(chatId, app);
    // Reopened there, the frame stays, until a newer version comes.
    const again = await chats.previewUpdate(chatId, app, 2, {
      screen: reopened.screen,
      appVersion: 1,
    });

    expect({
      opened: { screen: opened.screen, callsAt: callsAt(opened) },
      updated,
      again,
      reopened: {
        fallback: reopened.fallback,
        screen: reopened.screen,
        callsAt: callsAt(reopened),
      },
    }).toStrictEqual({
      opened: { screen: "desk", callsAt: 1 },
      updated: { app, restart: true },
      again: { app, unchanged: true },
      reopened: { fallback: true, screen: "desk", callsAt: { appVersion: 1 } },
    });
  });

  it("says which of its paths a draft deletes, and previews no screen it deleted, its first in place of one asked for", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await newApp(builder, "Invoice desk", released);
    const { chatId } = await chatWithDraft(builder, app, {
      "screens/desk.tsx": null,
      "screens/list.tsx": screen,
    });
    const { chats } = builder.api;

    const [draft] = await chats.drafts(chatId);
    const first = await chats.preview(chatId, app);
    const gone = await chats.preview(chatId, app, "desk");

    expect({
      changed: draft?.changed,
      deleted: draft?.deleted,
      first: { screen: first.screen, screens: first.screens },
      gone: gone.screen,
    }).toStrictEqual({
      changed: ["screens/desk.tsx", "screens/list.tsx"],
      deleted: ["screens/desk.tsx"],
      first: { screen: "list", screens: ["list"] },
      gone: "list",
    });
  });
});
