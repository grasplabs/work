import { definitionText } from "@grasp-os/runtime/definition";
import { shownAt } from "@grasp-os/shared/chat";
import type { PreviewAt, PreviewBundle } from "@grasp-os/shared/chat";
import { appIdSchema, chatIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import type { AppVersionPush } from "@grasp-os/shared/pages";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { openTestRun } from "./agent-chat.ts";
import {
  commitApp,
  draftDefinitionOf,
  sourceParts,
  withFiles,
} from "./app-definitions.ts";
import type { TestSource } from "./app-definitions.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { loadFrame, servedAll } from "./page-frames.ts";
import { deskFiles, notesApp, notesFiles } from "./preview-drafts.ts";
import {
  chatsOf,
  chatWithDraft,
  outcome,
  previewCall,
  refreshed,
} from "./previews.ts";
import { followedVersion, signedInApi } from "./sign-in.ts";

// A chat's preview of its draft of an App: the draft's pages and server
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

/** A new App of `builder`'s, released. */
const newApp = async (
  builder: Person,
  name: string,
  files: TestSource
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

/** The notes App's desk page, saying `word` before its titles. */
const deskSaying = (word: string): string =>
  (notesFiles("drafted").files["src/routes/index.tsx"] ?? "").replace(
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
  changes: TestSource,
  revision: number
): Promise<void> => {
  const { files, definition } = sourceParts(changes);
  const saved = await chatsOf(person).saveDraft(
    chatId,
    app,
    1,
    { ...files },
    [],
    revision,
    { runId: await openTestRun(chatsOf(person), chatId) },
    definition === undefined ? undefined : definitionText(definition)
  );
  if (!saved) {
    throw new Error("The draft wasn't written");
  }
};

/**
 * A call of `notes.titles`, as the page of the App's latest version
 * names it: by its path, whatever the draft calls its functions.
 */
const titlesRequest = JSON.stringify({
  reference: { name: "notes.titles", kind: "query" },
  args: {},
});

/**
 * What a call of `notes.titles` in the chat's preview of `app` answers: on
 * the draft as it is, whatever build the frame shows (`at`, kept for what
 * the test reads of the frame).
 */
const titlesAt = async (
  person: Person,
  chatId: ChatId,
  app: AppId,
  _at: PreviewAt
): Promise<unknown> =>
  outcome(await previewCall(person, chatId, app, titlesRequest));

/** What the calls of a frame opened on `bundle` name, as the page has them. */
const callsAt = (bundle: PreviewBundle): PreviewAt =>
  bundle.refresh === undefined ? bundle.revision : shownAt(bundle.refresh);

/** The notes App's server code with `notes.titles` answering `title` alone. */
const titlesSaying = (title: string): string =>
  (notesFiles("drafted").files["server/notes.ts"] ?? "").replace(
    '(await ctx.db.query("notes").take(100)).map((note) => note.title).sort()',
    JSON.stringify([title])
  );

/** The notes App's server code with `notes.titles` renamed `notes.allTitles`. */
const renamedTitles = (
  notesFiles("drafted").files["server/notes.ts"] ?? ""
).replace("export const titles = query(", "export const allTitles = query(");

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
      appVersion: before.refresh?.appVersion,
      titles: await titlesAt(builder, chatId, app, callsAt(before)),
    };
    await writeDraft(
      builder,
      chatId,
      app,
      { "src/routes/index.tsx": deskSaying("Drafted") },
      before.revision
    );
    const [draft] = await chats.drafts(chatId);
    // The frame opened before the write takes it, at the draft's revision.
    const update = refreshed(
      await chats.previewUpdate(chatId, app, 1, {
        appVersion: 1,
      })
    );
    // As the frame imports it: under the token it opened with.
    const served = await servedAll(frame, update);

    expect({
      latest,
      draft: { changed: draft?.changed, revision: draft?.revision },
      update: {
        revision: update.revision,
        appVersion: update.appVersion,
        served: served.status,
        drafted: /["`]Drafted ["`]/u.test(served.code),
      },
    }).toStrictEqual({
      latest: {
        drafts: [],
        revision: 0,
        appVersion: 1,
        titles: [],
      },
      draft: { changed: ["src/routes/index.tsx"], revision: 1 },
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

  it("opens a draft whose page doesn't build on the App's latest version, its calls on the draft as it is and heard by the draft's check, then takes the next write that builds", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { chats } = builder.api;
    const chatId = await appChat(builder, app);
    // The draft renames the function the latest version's page calls.
    await writeDraft(
      builder,
      chatId,
      app,
      {
        "src/routes/index.tsx": "export default function Desk( {",
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
      // It shows that version; its calls run on the draft as it is, which
      // renamed the function.
      callsAt: callsAt(broken),
      titles: await titlesAt(builder, chatId, app, callsAt(broken)),
      // Asked for the draft's page, it still doesn't build.
      update: await answer(
        chats.previewUpdate(chatId, app, 1, { appVersion: 1 })
      ),
    };
    // The draft's call failed through its own fault: the agent's check
    // hears it.
    const reports = await chatsOf(builder).previewReports(chatId, app, 1, 0);
    await writeDraft(
      builder,
      chatId,
      app,
      { "src/routes/index.tsx": deskSaying("Fixed") },
      1
    );
    const refresh = refreshed(
      await chats.previewUpdate(chatId, app, 2, {
        appVersion: 1,
      })
    );
    const fixed = await servedAll(frame, refresh);

    expect({
      opened,
      reports: { seen: reports.seen, problems: reports.problems.length },
      fixed: {
        revision: refresh.revision,
        appVersion: refresh.appVersion,
        served: fixed.status,
        says: /["`]Fixed ["`]/u.test(fixed.code),
      },
    }).toStrictEqual({
      opened: {
        fallback: true,
        loaded: 200,
        revision: 1,
        refresh: { revision: 1, appVersion: 1 },
        callsAt: { appVersion: 1 },
        titles: "function.not_found",
        update: "page.build_failed",
      },
      reports: { seen: true, problems: 1 },
      fixed: { revision: 2, appVersion: undefined, served: 200, says: true },
    });
  });

  it("opens a draft whose server code doesn't build, or that deletes every page, on the App's latest version", async () => {
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
    const { chatId: pageless } = await chatWithDraft(builder, app, {
      "src/routes/index.tsx": null,
    });

    const server = await chats.preview(serverChat, app);
    const deleted = await chats.preview(pageless, app);

    // The draft's pages import references its server code doesn't build:
    // the frame shows the App's latest version, and its calls say why.
    expect({
      server: {
        fallback: server.fallback,
        serverUnbuilt: server.refresh?.serverUnbuilt,
        titles: await titlesAt(builder, serverChat, app, callsAt(server)),
      },
      deleted: { fallback: deleted.fallback },
    }).toStrictEqual({
      server: {
        fallback: true,
        serverUnbuilt: undefined,
        titles: "version.build_failed",
      },
      deleted: { fallback: true },
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
      withFiles(notesFiles("unbuilt"), {
        "src/routes/index.tsx": "export default function Desk( {",
      }).files,
      [],
      0,
      { runId: await openTestRun(chatsOf(builder), chatId) },
      draftDefinitionOf(notesFiles("unbuilt"))
    );

    expect({
      saved,
      broken: await answer(builder.api.chats.preview(chatId, app)),
    }).toStrictEqual({ saved: true, broken: "page.build_failed" });
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
        ...files.files,
        "server/notes.ts": (files.files["server/notes.ts"] ?? "").replace(
          'ctx.db.query("notes").take(100)',
          // A count that isn't a number: it fails its type check.
          'ctx.db.query("notes").take("all")'
        ),
      },
      [],
      0,
      { runId: await openTestRun(chatsOf(builder), chatId) },
      draftDefinitionOf(files)
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

    // The type error says what the count must be.
    expect({
      code: details.code,
      files: details.details.diagnostics.map(({ file }) => file),
      namesType: details.details.diagnostics.some(({ message }) =>
        message.includes("'number'")
      ),
    }).toStrictEqual({
      code: "version.build_failed",
      files: ["server/notes.ts"],
      namesType: true,
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
      { "src/routes/index.tsx": deskSaying("Drafted") },
      0
    );

    await chats.discardDraft(chatId, app);
    const [discarded] = await chats.drafts(chatId);
    const after = await chats.preview(chatId, app);

    expect({
      discarded: { changed: discarded?.changed, revision: discarded?.revision },
      after: {
        revision: after.revision,
        appVersion: after.refresh?.appVersion,
      },
      titles: await titlesAt(builder, chatId, app, callsAt(after)),
    }).toStrictEqual({
      discarded: { changed: [], revision: 2 },
      after: { revision: 2, appVersion: 1 },
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
          await builder.api.pages.watchVersion(app, onVersion)
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
      const answered = await chats.previewUpdate(
        chatId,
        app,
        opened.revision,
        opened.refresh?.appVersion === undefined
          ? {}
          : { appVersion: opened.refresh.appVersion }
      );
      const reopened = await chats.preview(chatId, app);
      // As its frame imports it: under the token it opened with.
      const served = await servedAll(
        await loadFrame(reopened),
        reopened.refresh ?? { modules: {} }
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
    await commitApp(
      builder.api.apps.files,
      app,
      {
        "src/routes/index.tsx":
          deskFiles("Committed").files["src/routes/index.tsx"] ?? "",
      },
      "Elsewhere"
    );
    const committed = await beforeCommit.told();
    await beforeCommit.release();
    const afterCommit = await updated();
    // Another chat's draft, proposed.
    const { chatId: proposing } = await chatWithDraft(builder, app, {
      "src/routes/elsewhere.tsx": `import { createFileRoute } from "@tanstack/react-router";

const Elsewhere = () => <main>Proposed elsewhere</main>;

export const Route = createFileRoute("/elsewhere")({ component: Elsewhere });
`,
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

  it("starts a frame afresh on another version of the App", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { chats } = builder.api;
    const chatId = await appChat(builder, app);
    const opened = await chats.preview(chatId, app);
    const same = await chats.previewUpdate(chatId, app, opened.revision, {
      appVersion: 1,
    });
    // Version 2 names the page `board`.
    await commitApp(
      builder.api.apps.files,
      app,
      {
        "src/routes/index.tsx": null,
        "src/routes/board.tsx":
          notesFiles("board").files["src/routes/index.tsx"] ?? "",
      },
      "Board"
    );
    const moved = await chats.previewUpdate(chatId, app, opened.revision, {
      appVersion: 1,
    });
    const reopened = await chats.preview(chatId, app);

    expect({
      same,
      moved,
      reopened: {
        callsAt: callsAt(reopened),
      },
    }).toStrictEqual({
      same: { app, unchanged: true },
      moved: { app, restart: true },
      reopened: {
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
      { "src/routes/index.tsx": "export default function Desk( {" },
      0
    );
    const broken = await chats.preview(chatId, app);
    // The App's version it shows is still the latest: the draft's own
    // failure, which the frame shows as being fixed.
    const still = await answer(
      chats.previewUpdate(chatId, app, broken.revision, {
        appVersion: 1,
      })
    );
    await commitApp(
      builder.api.apps.files,
      app,
      { "server/notes.ts": titlesSaying("from version 2") },
      "Second"
    );
    const moved = await chats.previewUpdate(chatId, app, broken.revision, {
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
      still: "page.build_failed",
      moved: { app, restart: true },
      reopened: {
        fallback: true,
        callsAt: { appVersion: 2 },
        // Its calls run on the draft, still over version 1.
        titles: [],
      },
    });
  });

  it("has nothing to show of an App with no version before the chat's first write, and shows the first committed elsewhere", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Empty" });
    const app = appIdSchema.parse(id);
    const chatId = await appChat(builder, app);

    const before = await answer(builder.api.chats.preview(chatId, app));
    await commitApp(
      builder.api.apps.files,
      app,
      deskFiles("Committed"),
      "First"
    );
    const after = await builder.api.chats.preview(chatId, app);

    expect({
      before,
      after: { appVersion: after.refresh?.appVersion },
    }).toStrictEqual({
      before: "app.not_running",
      after: { appVersion: 1 },
    });
  });
});
