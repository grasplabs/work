import { definitionText } from "@grasp-os/runtime/definition";
import { shownAt } from "@grasp-os/shared/chat";
import type { PreviewAt, PreviewBundle } from "@grasp-os/shared/chat";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { AppVersionPush } from "@grasp-os/shared/pages";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { appKind } from "../src/apps.ts";
import { readDraft, saveDraft } from "../src/drafts.ts";
import { draftWatch } from "../src/durable-objects.ts";
import { sourceParts, withFiles } from "./app-definitions.ts";
import type { TestSource } from "./app-definitions.ts";
import { commitApp, release } from "./apps.ts";
import { agentWriting } from "./draft-writers.ts";
import { mockIdp } from "./idp.ts";
import { loadFrame, servedAll } from "./page-frames.ts";
import { deskFiles, notesApp, notesFiles } from "./preview-drafts.ts";
import { outcome, previewCall, previewOf, refreshed } from "./previews.ts";
import { followedVersion, signedInApi } from "./sign-in.ts";

// The preview of an App's one shared draft: the draft's pages and server
// code, run for whichever builder of the App calls, with no side effects.
// These tests start from the ways it can fail: the draft's code writes to
// the App's real storage or Knowledge, calls a connection or another App,
// records a statistic, reaches the network, or reads real data it could
// show; a name a permission asked for and not granted gives the preview
// reaches what only a grant allows; a preview keeps what an earlier draft
// wrote; someone who doesn't build the App previews it; and a preview with
// nothing to show while the App has a version: before the draft's first
// write, or once its changes went.

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

/**
 * Writes `changes` into the draft of `app` over version `base`, at its
 * revision now, as the agent of `person`'s chat for the App writes it.
 * Answers the revision written.
 */
const writeDraft = async (
  person: Person,
  app: AppId,
  changes: TestSource,
  base: number | null = 1
): Promise<number> => {
  const { id: chatId } = await person.api.chats.create("App changes");
  const { files, definition } = sourceParts(changes);
  const now = await readDraft(env, { kind: "app", id: app });
  await saveDraft(
    env,
    appKind,
    app,
    { ...now, base },
    {
      changes: { ...files },
      unchanged: [],
      ...(definition === undefined
        ? {}
        : { definition: definitionText(definition) }),
    },
    await agentWriting(person, chatId)
  );
  return now.revision + 1;
};

/** The revision of `app`'s draft now. */
const revisionOf = async (person: Person, app: AppId): Promise<number> => {
  const { revision } = await person.api.drafts.get({ kind: "app", id: app });
  return revision;
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
 * What a call of `notes.titles` in the preview of `app` answers: on the
 * draft as it is, whatever build the frame shows.
 */
const titlesOf = async (person: Person, app: AppId): Promise<unknown> =>
  outcome(await previewCall(person, app, titlesRequest));

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

describe("previewing an App's draft", { timeout: 120_000 }, () => {
  it("shows the App's latest version, its functions running, while nobody has written the draft, then takes its first write", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { apps, drafts } = builder.api;

    const before = await apps.preview.open(app);
    const frame = await loadFrame(before);
    const unwritten = await drafts.get({ kind: "app", id: app });
    const latest = {
      changed: unwritten.changed,
      revision: before.revision,
      appVersion: before.refresh?.appVersion,
      titles: await titlesOf(builder, app),
    };
    const written = await writeDraft(builder, app, {
      "src/routes/index.tsx": deskSaying("Drafted"),
    });
    const draft = await drafts.get({ kind: "app", id: app });
    // The frame opened before the write takes it, at the draft's revision.
    const update = refreshed(
      await apps.preview.update(app, written, {
        appVersion: 1,
      })
    );
    // As the frame imports it: under the token it opened with.
    const served = await servedAll(frame, update);

    expect({
      latest,
      draft: { changed: draft.changed, revision: draft.revision },
      update: {
        revision: update.revision,
        appVersion: update.appVersion,
        served: served.status,
        drafted: /["`]Drafted ["`]/u.test(served.code),
      },
    }).toStrictEqual({
      latest: {
        changed: [],
        revision: unwritten.revision,
        appVersion: 1,
        titles: [],
      },
      draft: {
        changed: ["src/routes/index.tsx"],
        revision: unwritten.revision + 1,
      },
      update: {
        revision: unwritten.revision + 1,
        appVersion: undefined,
        served: 200,
        drafted: true,
      },
    });
  });

  it("previews the draft for every builder of the App, and for nobody else", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const colleague = await signedInApi(idp, "builder");
    const written = await writeDraft(builder, app, {
      "src/routes/index.tsx": deskSaying("Drafted"),
    });
    const outside = await answer(colleague.api.apps.preview.open(app));
    await builder.api.apps.members.add(app, {
      type: "person",
      id: colleague.userId,
      role: "builder",
    });
    const shared = await colleague.api.apps.preview.open(app);
    const served = await servedAll(
      await loadFrame(shared),
      shared.refresh ?? { modules: {} }
    );

    expect({
      outside,
      shared: shared.revision,
      drafted: /["`]Drafted ["`]/u.test(served.code),
    }).toStrictEqual({
      outside: "app.not_found",
      shared: written,
      drafted: true,
    });
  });

  it("tells every page that follows the draft of each write, whoever made it", async () => {
    const builder = await signedInApi(idp, "builder");
    const colleague = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const watched = draftWatch(env, { kind: "app", id: app });
    const heard = new Map<string, number[]>();
    const follow = async (page: string, person: string): Promise<void> => {
      await watched.watch(person, async (revision: number) => {
        heard.set(page, [...(heard.get(page) ?? []), revision]);
        await Promise.resolve();
      });
    };
    await follow("mine", builder.userId);
    await follow("theirs", colleague.userId);

    const written = await writeDraft(builder, app, {
      "src/routes/index.tsx": deskSaying("Drafted"),
    });

    await vi.waitFor(() => {
      expect(Object.fromEntries(heard)).toStrictEqual({
        mine: [written],
        theirs: [written],
      });
    });
  });

  it("saves a write while a page that follows the draft never answers, and tells the others", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const watched = draftWatch(env, { kind: "app", id: app });
    const heard: number[] = [];
    await watched.watch(
      builder.userId,
      async () => await Promise.withResolvers<never>().promise
    );
    await watched.watch(builder.userId, async (revision: number) => {
      heard.push(revision);
      await Promise.resolve();
    });

    const written = await writeDraft(builder, app, {
      "src/routes/index.tsx": deskSaying("Drafted"),
    });
    const saved = await revisionOf(builder, app);

    await vi.waitFor(() => {
      expect({ saved, heard }).toStrictEqual({
        saved: written,
        heard: [written],
      });
    });
  });

  it("tells the builders' pages when a version goes live under a draft that changes nothing, so they show the App live", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Desk" });
    const app = appIdSchema.parse(id);
    const { version } = await commitApp(builder.api, app, deskFiles());
    await commitApp(builder.api, app, {
      "src/routes/index.tsx": deskSaying("Later"),
    });
    const heard: number[] = [];
    await draftWatch(env, { kind: "app", id: app }).watch(
      builder.userId,
      async (revision: number) => {
        heard.push(revision);
        await Promise.resolve();
      }
    );
    const before = await builder.api.drafts.get({ kind: "app", id: app });

    // Back to the first: the draft, changing nothing, is over it then.
    await builder.api.versions.rollback({ kind: "app", id: app }, version);
    const after = await builder.api.drafts.get({ kind: "app", id: app });

    await vi.waitFor(() => {
      expect({
        told: heard.length > 0,
        draft: { changed: before.changed, base: after.base },
      }).toStrictEqual({
        told: true,
        draft: { changed: [], base: version },
      });
    });
  });

  it("opens a draft whose page doesn't build on the App's latest version, its calls on the draft as it is and heard by the draft's check, then takes the next write that builds", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { apps } = builder.api;
    // The draft renames the function the latest version's page calls.
    const written = await writeDraft(builder, app, {
      "src/routes/index.tsx": "export default function Desk( {",
      "server/notes.ts": renamedTitles,
    });

    const broken = await apps.preview.open(app);
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
      titles: await titlesOf(builder, app),
      // Asked for the draft's page, it still doesn't build.
      update: await answer(
        apps.preview.update(app, written, { appVersion: 1 })
      ),
    };
    // The draft's call failed through its own fault: the draft's check
    // hears it.
    const reports = await previewOf(app).reports(written, 0);
    const fixedAt = await writeDraft(builder, app, {
      "src/routes/index.tsx": deskSaying("Fixed"),
    });
    const refresh = refreshed(
      await apps.preview.update(app, fixedAt, {
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
        revision: written,
        refresh: { revision: written, appVersion: 1 },
        callsAt: { appVersion: 1 },
        titles: "function.not_found",
        update: "page.build_failed",
      },
      reports: { seen: true, problems: 1 },
      fixed: {
        revision: fixedAt,
        appVersion: undefined,
        served: 200,
        says: true,
      },
    });
  });

  it("opens a draft whose server code doesn't build, or that deletes every page, on the App's latest version", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { apps } = builder.api;
    await writeDraft(builder, app, {
      "server/notes.ts": "export const titles = query({ (",
    });
    const server = await apps.preview.open(app);
    const serverTitles = await titlesOf(builder, app);
    await writeDraft(builder, app, {
      // The released server code back, every page gone.
      "server/notes.ts": notesFiles("released").files["server/notes.ts"] ?? "",
      "src/routes/index.tsx": null,
    });
    const deleted = await apps.preview.open(app);

    // The draft's pages import references its server code doesn't build:
    // the frame shows the App's latest version, and its calls say why.
    expect({
      server: {
        fallback: server.fallback,
        serverUnbuilt: server.refresh?.serverUnbuilt,
        titles: serverTitles,
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
    await writeDraft(
      builder,
      app,
      withFiles(notesFiles("unbuilt"), {
        "src/routes/index.tsx": "export default function Desk( {",
      }),
      null
    );

    await expect(answer(builder.api.apps.preview.open(app))).resolves.toBe(
      "page.build_failed"
    );
  });

  it("says the server code doesn't build, and where, when no server code of the App's builds, never that it has none", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Unbuilt" });
    const app = appIdSchema.parse(id);
    const files = notesFiles("unbuilt");
    await writeDraft(
      builder,
      app,
      withFiles(files, {
        "server/notes.ts": (files.files["server/notes.ts"] ?? "").replace(
          'ctx.db.query("notes").take(100)',
          // A count that isn't a number: it fails its type check.
          'ctx.db.query("notes").take("all")'
        ),
      }),
      null
    );
    let refused: unknown;
    try {
      await builder.api.apps.preview.open(app);
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

  it("shows the App's latest version again once the draft is discarded", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { apps, drafts } = builder.api;
    const written = await writeDraft(builder, app, {
      "src/routes/index.tsx": deskSaying("Drafted"),
    });

    await drafts.discard({ kind: "app", id: app }, written);
    const discarded = await drafts.get({ kind: "app", id: app });
    const after = await apps.preview.open(app);

    expect({
      discarded: { changed: discarded.changed, revision: discarded.revision },
      after: {
        revision: after.revision,
        appVersion: after.refresh?.appVersion,
      },
      titles: await titlesOf(builder, app),
    }).toStrictEqual({
      discarded: { changed: [], revision: written + 1 },
      after: { revision: written + 1, appVersion: 1 },
      titles: [],
    });
  });

  it("tells the open preview of the version published from the draft, and opens on it", async () => {
    const builder = await signedInApi(idp, "builder");
    // An App whose drafts pass their checks to be published.
    const app = await newApp(builder, "Desk", deskFiles("Released"));
    const { apps, drafts } = builder.api;
    const opened = await apps.preview.open(app);
    // A chat's agent writes the draft, over the version live (a draft is
    // published only over that one), and it is published.
    const written = await writeDraft(builder, app, {
      "src/routes/elsewhere.tsx": `import { createFileRoute } from "@tanstack/react-router";

const Elsewhere = () => <main>Published elsewhere</main>;

export const Route = createFileRoute("/elsewhere")({ component: Elsewhere });
`,
    });
    // Followed as the open frame follows the App's version, past its first
    // push and those that only ask the page to check its access again.
    const followed = await followedVersion(
      async (onVersion) => await builder.api.pages.watchVersion(app, onVersion)
    );
    await followed.next();
    await drafts.publish({ kind: "app", id: app }, written);
    let published: AppVersionPush = await followed.next();
    while (published.type === "current" && published.recheck) {
      // oxlint-disable-next-line no-await-in-loop -- one push after the other
      published = await followed.next();
    }
    await followed.release();
    const afterPublish = await apps.preview.open(app);

    expect({
      opened: opened.refresh?.appVersion,
      pushed: published.type,
      afterPublish: afterPublish.refresh?.appVersion,
    }).toStrictEqual({ opened: 1, pushed: "current", afterPublish: 2 });
  });

  it("starts a frame afresh on another version of the App", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { apps, drafts } = builder.api;
    const opened = await apps.preview.open(app);
    const same = await apps.preview.update(app, opened.revision, {
      appVersion: 1,
    });
    // Version 2, published, names the page `board`: the draft, changing
    // nothing, is over it.
    await release(builder, app, {
      "src/routes/index.tsx": null,
      "src/routes/board.tsx":
        notesFiles("board").files["src/routes/index.tsx"] ?? "",
    });
    const { revision } = await drafts.get({ kind: "app", id: app });
    const moved = await apps.preview.update(app, revision, {
      appVersion: 1,
    });
    const reopened = await apps.preview.open(app);

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

  it("shows the version rolled back to, never the newer one, and in place of a draft over it that doesn't build", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { apps } = builder.api;
    await release(builder, app, {
      "server/notes.ts": titlesSaying("from version 2"),
    });

    await builder.api.versions.rollback({ kind: "app", id: app }, 1);
    const rolledBack = await apps.preview.open(app);
    const rolledBackTitles = await titlesOf(builder, app);
    await writeDraft(builder, app, {
      "src/routes/index.tsx": "export default function Desk( {",
    });
    const broken = await apps.preview.open(app);

    expect({
      rolledBack: { callsAt: callsAt(rolledBack), titles: rolledBackTitles },
      broken: { fallback: broken.fallback, callsAt: callsAt(broken) },
    }).toStrictEqual({
      rolledBack: { callsAt: { appVersion: 1 }, titles: [] },
      broken: { fallback: true, callsAt: { appVersion: 1 } },
    });
  });

  it("has nothing to show of an App with no version before the draft's first write, and shows its first version once there is one", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Empty" });
    const app = appIdSchema.parse(id);

    const before = await answer(builder.api.apps.preview.open(app));
    await commitApp(builder.api, app, deskFiles("Committed"));
    const after = await builder.api.apps.preview.open(app);

    expect({
      before,
      after: { appVersion: after.refresh?.appVersion },
    }).toStrictEqual({
      before: "app.not_running",
      after: { appVersion: 1 },
    });
  });
});
