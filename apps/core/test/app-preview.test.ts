import { definitionText } from "@grasp-os/runtime/definition";
import { shownAt } from "@grasp-os/shared/chat";
import type { PreviewAt, PreviewBundle } from "@grasp-os/shared/chat";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import type { AppVersionPush } from "@grasp-os/shared/pages";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { readDraft, saveDraft } from "../src/app-drafts.ts";
import { commitApp, sourceParts, withFiles } from "./app-definitions.ts";
import type { TestSource } from "./app-definitions.ts";
import { release } from "./apps.ts";
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
 * Writes `changes` into the draft of `app` over version `base`, at
 * `revision`, as the agent of `person`'s chat for the App writes it.
 */
const writeDraft = async (
  person: Person,
  app: AppId,
  changes: TestSource,
  revision: number,
  base: number | null = 1
): Promise<void> => {
  const { id: chatId } = await person.api.chats.forApp(app);
  const { files, definition } = sourceParts(changes);
  const now = await readDraft(env, app);
  await saveDraft(
    env,
    app,
    { ...now, base, revision },
    {
      changes: { ...files },
      unchanged: [],
      ...(definition === undefined
        ? {}
        : { definition: definitionText(definition) }),
    },
    await agentWriting(person, chatId)
  );
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
    const { drafts } = builder.api.apps;

    const before = await drafts.preview(app);
    const frame = await loadFrame(before);
    const unwritten = await drafts.get(app);
    const latest = {
      changed: unwritten.changed,
      revision: before.revision,
      appVersion: before.refresh?.appVersion,
      titles: await titlesOf(builder, app),
    };
    await writeDraft(
      builder,
      app,
      { "src/routes/index.tsx": deskSaying("Drafted") },
      before.revision
    );
    const draft = await drafts.get(app);
    // The frame opened before the write takes it, at the draft's revision.
    const update = refreshed(
      await drafts.previewUpdate(app, 1, {
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

  it("previews the draft for every builder of the App, and for nobody else", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const colleague = await signedInApi(idp, "builder");
    await writeDraft(
      builder,
      app,
      { "src/routes/index.tsx": deskSaying("Drafted") },
      0
    );
    const outside = await answer(colleague.api.apps.drafts.preview(app));
    await builder.api.apps.members.add(app, {
      type: "person",
      id: colleague.userId,
      role: "builder",
    });
    const shared = await colleague.api.apps.drafts.preview(app);
    const served = await servedAll(
      await loadFrame(shared),
      shared.refresh ?? { modules: {} }
    );

    expect({
      outside,
      shared: shared.revision,
      drafted: /["`]Drafted ["`]/u.test(served.code),
    }).toStrictEqual({ outside: "app.not_found", shared: 1, drafted: true });
  });

  it("tells every builder's pages of each write, one builder's newest pages at most, so nobody crowds out the others", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const preview = previewOf(app);
    const heard = new Map<string, number[]>();
    const follow = async (personId: string, page: string): Promise<void> => {
      await preview.watch(personId, async (revision: number) => {
        heard.set(page, [...(heard.get(page) ?? []), revision]);
        await Promise.resolve();
      });
    };
    // One builder opens a page more than they may follow at once.
    for (let page = 1; page <= 21; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- opened one after the other
      await follow(builder.userId, `mine-${page}`);
    }
    await follow("another-builder", "theirs");

    await writeDraft(
      builder,
      app,
      { "src/routes/index.tsx": deskSaying("Drafted") },
      0
    );

    expect({
      oldest: heard.get("mine-1"),
      newest: heard.get("mine-21"),
      following: [...heard.keys()].filter((page) => page.startsWith("mine-"))
        .length,
      theirs: heard.get("theirs"),
    }).toStrictEqual({
      oldest: undefined,
      newest: [1],
      following: 20,
      theirs: [1],
    });
  });

  it("opens a draft whose page doesn't build on the App's latest version, its calls on the draft as it is and heard by the draft's check, then takes the next write that builds", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { drafts } = builder.api.apps;
    // The draft renames the function the latest version's page calls.
    await writeDraft(
      builder,
      app,
      {
        "src/routes/index.tsx": "export default function Desk( {",
        "server/notes.ts": renamedTitles,
      },
      0
    );

    const broken = await drafts.preview(app);
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
      update: await answer(drafts.previewUpdate(app, 1, { appVersion: 1 })),
    };
    // The draft's call failed through its own fault: the draft's check
    // hears it.
    const reports = await previewOf(app).reports(1, 0);
    await writeDraft(
      builder,
      app,
      { "src/routes/index.tsx": deskSaying("Fixed") },
      1
    );
    const refresh = refreshed(
      await drafts.previewUpdate(app, 2, {
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
    const { drafts } = builder.api.apps;
    await writeDraft(
      builder,
      app,
      { "server/notes.ts": "export const titles = query({ (" },
      0
    );
    const server = await drafts.preview(app);
    const serverTitles = await titlesOf(builder, app);
    await writeDraft(
      builder,
      app,
      {
        // The released server code back, every page gone.
        "server/notes.ts":
          notesFiles("released").files["server/notes.ts"] ?? "",
        "src/routes/index.tsx": null,
      },
      1
    );
    const deleted = await drafts.preview(app);

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
      0,
      null
    );

    await expect(answer(builder.api.apps.drafts.preview(app))).resolves.toBe(
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
      0,
      null
    );
    let refused: unknown;
    try {
      await builder.api.apps.drafts.preview(app);
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
    const { drafts } = builder.api.apps;
    await writeDraft(
      builder,
      app,
      { "src/routes/index.tsx": deskSaying("Drafted") },
      0
    );

    await drafts.discard(app, 1);
    const discarded = await drafts.get(app);
    const after = await drafts.preview(app);

    expect({
      discarded: { changed: discarded.changed, revision: discarded.revision },
      after: {
        revision: after.revision,
        appVersion: after.refresh?.appVersion,
      },
      titles: await titlesOf(builder, app),
    }).toStrictEqual({
      discarded: { changed: [], revision: 2 },
      after: { revision: 2, appVersion: 1 },
      titles: [],
    });
  });

  it("keeps the open preview of a draft that changes nothing on the live version while another is committed elsewhere, and opens on the version published from the draft", async () => {
    const builder = await signedInApi(idp, "builder");
    // An App whose drafts pass their checks to be published.
    const app = await newApp(builder, "Desk", deskFiles("Released"));
    const { drafts } = builder.api.apps;
    const opened = await drafts.preview(app);
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
      const answered = await drafts.previewUpdate(
        app,
        opened.revision,
        opened.refresh?.appVersion === undefined
          ? {}
          : { appVersion: opened.refresh.appVersion }
      );
      const reopened = await drafts.preview(app);
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

    // A commit from the App's code, not published: nobody uses it, so the
    // preview stays on the live version.
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
    // A chat's agent writes the draft, over the version live (a draft is
    // published only over that one), and it is published.
    await writeDraft(
      builder,
      app,
      {
        "src/routes/elsewhere.tsx": `import { createFileRoute } from "@tanstack/react-router";

const Elsewhere = () => <main>Published elsewhere</main>;

export const Route = createFileRoute("/elsewhere")({ component: Elsewhere });
`,
      },
      0
    );
    const beforePublish = await follow();
    await drafts.publish(app, 1, "Published elsewhere");
    const published = await beforePublish.told();
    await beforePublish.release();
    const afterPublish = await drafts.preview(app);

    expect({
      opened: {
        revision: opened.revision,
        appVersion: opened.refresh?.appVersion,
      },
      pushes: [committed.type, published.type],
      afterCommit,
      afterPublish: afterPublish.refresh?.appVersion,
    }).toStrictEqual({
      opened: { revision: 0, appVersion: 1 },
      pushes: ["current", "current"],
      afterCommit: {
        answered: { app, unchanged: true },
        revision: 0,
        appVersion: 1,
        served: 200,
        says: false,
      },
      afterPublish: 3,
    });
  });

  it("starts a frame afresh on another version of the App", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { drafts } = builder.api.apps;
    const opened = await drafts.preview(app);
    const same = await drafts.previewUpdate(app, opened.revision, {
      appVersion: 1,
    });
    // Version 2, published, names the page `board`: the draft, changing
    // nothing, is over it.
    await release(builder, app, {
      "src/routes/index.tsx": null,
      "src/routes/board.tsx":
        notesFiles("board").files["src/routes/index.tsx"] ?? "",
    });
    const { revision } = await drafts.get(app);
    const moved = await drafts.previewUpdate(app, revision, {
      appVersion: 1,
    });
    const reopened = await drafts.preview(app);

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

  it("keeps a frame shown in place of a draft that doesn't build on the version the draft is over, whatever is committed elsewhere", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { drafts } = builder.api.apps;
    await writeDraft(
      builder,
      app,
      { "src/routes/index.tsx": "export default function Desk( {" },
      0
    );
    const broken = await drafts.preview(app);
    // A version nobody uses: never what the preview shows in the draft's
    // place.
    await commitApp(
      builder.api.apps.files,
      app,
      { "server/notes.ts": titlesSaying("from version 2") },
      "Second"
    );
    const still = await answer(
      drafts.previewUpdate(app, broken.revision, {
        appVersion: 1,
      })
    );
    const reopened = await drafts.preview(app);

    expect({
      opened: { fallback: broken.fallback, callsAt: callsAt(broken) },
      // The draft's own failure, which the frame shows as being fixed.
      still,
      reopened: {
        fallback: reopened.fallback,
        callsAt: callsAt(reopened),
        // Its calls run on the draft, over version 1.
        titles: await titlesOf(builder, app),
      },
    }).toStrictEqual({
      opened: { fallback: true, callsAt: { appVersion: 1 } },
      still: "page.build_failed",
      reopened: {
        fallback: true,
        callsAt: { appVersion: 1 },
        titles: [],
      },
    });
  });

  it("shows the version rolled back to, never the newer one, and in place of a draft over it that doesn't build", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { drafts } = builder.api.apps;
    await release(builder, app, {
      "server/notes.ts": titlesSaying("from version 2"),
    });

    await builder.api.apps.versions.publish(app, 1);
    const rolledBack = await drafts.preview(app);
    const rolledBackTitles = await titlesOf(builder, app);
    const { revision } = await drafts.get(app);
    await writeDraft(
      builder,
      app,
      { "src/routes/index.tsx": "export default function Desk( {" },
      revision
    );
    const broken = await drafts.preview(app);

    expect({
      rolledBack: { callsAt: callsAt(rolledBack), titles: rolledBackTitles },
      broken: { fallback: broken.fallback, callsAt: callsAt(broken) },
    }).toStrictEqual({
      rolledBack: { callsAt: { appVersion: 1 }, titles: [] },
      broken: { fallback: true, callsAt: { appVersion: 1 } },
    });
  });

  it("has nothing to show of an App with no version before the draft's first write, and shows the first committed elsewhere", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Empty" });
    const app = appIdSchema.parse(id);

    const before = await answer(builder.api.apps.drafts.preview(app));
    await commitApp(
      builder.api.apps.files,
      app,
      deskFiles("Committed"),
      "First"
    );
    const after = await builder.api.apps.drafts.preview(app);

    expect({
      before,
      after: { appVersion: after.refresh?.appVersion },
    }).toStrictEqual({
      before: "app.not_running",
      after: { appVersion: 1 },
    });
  });
});
