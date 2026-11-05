import type { PreviewBundle, PreviewUpdate } from "@grasp-os/shared/chat";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { sealDraftRelease } from "../src/app-releases.ts";
import { frameKey } from "../src/screen-frame.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { livePushes, notesFiles, previewDraftsOf } from "./preview-drafts.ts";
import {
  chatsOf,
  chatWithDraft,
  outcome,
  previewStores,
  requestFor,
  refreshed,
} from "./previews.ts";
import { loadFrame, servedFrom } from "./screen-frames.ts";
import type { LoadedFrame } from "./screen-frames.ts";
import { signedInApi } from "./sign-in.ts";

// A chat's preview taking each write of its draft in the frame it has
// open (chats.previewUpdate, spec 19.2.1): the screen as one module for
// React Fast Refresh, built without staging a frame or sealing anything
// when only screens changed. The ways it can fail, from the threat model
// in core's screen-frame.ts: the frame handed another App's module, or
// another revision's; someone who doesn't build the App getting the
// draft's code; the policy of a production frame loosened to take
// updates; a write of a screen throwing away what the preview's store
// holds, or sealing the draft again; a frame kept on the last version
// that worked losing its server calls and live data; a preview opened
// from someone else's chat; builds started for every ask; and a write
// the seal does read taken for one it doesn't; a frame's live data lost,
// or told the App is gone, as the draft's server code changes; and a
// frame stuck while the draft's server code doesn't build.

const idp = mockIdp();
const { setUp } = previewDraftsOf(idp);

/** `text`, JSON, read without the whole tree's hash wherever it is. */
const withoutTree = (text: string): unknown =>
  JSON.parse(text, (key, value: unknown) =>
    key === "sourceTreeHash" ? undefined : value
  );

/** What the test reads of a sealed draft release's manifest. */
const sealedManifestSchema = z
  .object({
    artifacts: z.array(z.object({ path: z.string(), sha256: z.string() })),
  })
  .loose();

/** An update of `app`'s preview at `revision`, its screen's module `entry`, as a build answers one. */
const builtAt = (
  app: AppId,
  revision: number,
  entry: string
): PreviewUpdate => ({
  app,
  refresh: { revision, screen: "desk", entry, modules: {}, css: "", kit: [] },
});

/** The screen's module of what a build answered, an update. */
const entryBuilt = (built: PreviewBundle | PreviewUpdate): string =>
  "refresh" in built ? (built.refresh?.entry ?? "") : "";

/** What the test reads of a staged frame's manifest. */
const stagedFrameSchema = z.object({ preview: z.boolean() }).loose();

/** The desk screen of the notes App, saying `word` before its titles. */
const deskSaying = (word: string): string =>
  (notesFiles("drafted")["screens/desk.tsx"] ?? "").replace(
    'titles.join(", ")',
    `"${word} " + titles.join(", ")`
  );

/** The code of an error, or what was answered. */
const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    return await promise;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? error.code
      : String(error);
  }
};

/** The notes App's server code with `notes.titles` answering `title` alone. */
const titlesSaying = (title: string): string =>
  (notesFiles("drafted")["server/notes.ts"] ?? "").replace(
    '(await ctx.db.query("notes").take(100)).map((note) => note.title).sort()',
    JSON.stringify([title])
  );

/**
 * The notes App's server code reading past what a query takes at once: it
 * fails its type check, so it doesn't build.
 */
const titlesUnbuilt = (notesFiles("drafted")["server/notes.ts"] ?? "").replace(
  'ctx.db.query("notes").take(100)).map',
  'ctx.db.query("notes").take(1000)).map'
);

/** The error codes among `pushes`. */
const refusedIn = (pushes: readonly { result: unknown }[]): unknown[] =>
  pushes.flatMap(({ result }) =>
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    result.ok === false &&
    "error" in result &&
    typeof result.error === "object" &&
    result.error !== null &&
    "code" in result.error
      ? [result.error.code]
      : []
  );

/** What a frame's policy lets run. */
const scripts = (frame: LoadedFrame | null): string[] =>
  frame?.policy.get("script-src") ?? [];

/** The revision the chat's kept draft release was sealed at. */
const sealedAt = async (
  person: Parameters<typeof chatsOf>[0],
  chatId: string
): Promise<number[]> =>
  await runInDurableObject(chatsOf(person), (_instance, state) =>
    state.storage.sql
      .exec<{ revision: number }>(
        "SELECT revision FROM preview_releases WHERE chat_id = ?",
        chatId
      )
      .toArray()
      .map(({ revision }) => revision)
  );

describe("a preview taking its draft's writes", { timeout: 180_000 }, () => {
  it("answers the screen of the draft now by its module's address, staging only the modules the write changed where the open frame loads them, within the kit it loaded", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const opened = await chats.preview(chatId, app, "desk");
    const frame = await loadFrame(opened);
    const next = await write(
      { "screens/desk.tsx": deskSaying("Hot") },
      revision
    );
    // Warm, as the person's next write finds it: measured each time.
    const started = performance.now();
    const updated = await chats.previewUpdate(chatId, app, next, {
      screen: "desk",
    });
    const updateMs = performance.now() - started;
    const again = await write(
      { "screens/desk.tsx": deskSaying("Again") },
      next
    );
    const secondStarted = performance.now();
    const second = await chats.previewUpdate(chatId, app, again, {
      screen: "desk",
    });
    const secondMs = performance.now() - secondStarted;
    console.info(
      `preview update after a screen write: ${Math.round(updateMs)} ms, then ${Math.round(secondMs)} ms`
    );
    const refresh = refreshed(updated);
    const before = Object.keys(opened.refresh?.modules ?? {});
    const entry = await servedFrom(frame, refresh.entry);
    const secondEntry = await servedFrom(frame, refreshed(second).entry);
    expect({
      app: updated.app,
      revision: refresh.revision,
      screen: refresh.screen,
      says: entry.code.includes('"Hot "'),
      served: entry.status,
      // The screen's module alone changed: its components are where the
      // frame loaded them.
      changed: Object.keys(refresh.modules).filter(
        (address) => !before.includes(address)
      ),
      css: refresh.css.length > 0,
      withinKit: refresh.kit.every((name) =>
        (opened.refresh?.kit ?? []).includes(name)
      ),
      opened: opened.refresh?.revision,
      second: {
        revision: refreshed(second).revision,
        says: secondEntry.code.includes('"Again "'),
      },
    }).toStrictEqual({
      app,
      revision: next,
      screen: "desk",
      says: true,
      served: 200,
      changed: [refresh.entry],
      css: true,
      withinKit: true,
      opened: revision,
      second: { revision: again, says: true },
    });
  });

  it("answers only the person's own chat's draft of an App they build, never another App's", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const other = await builder.api.apps.create({ name: "Other" });
    await release(builder, other.id, notesFiles("other"));
    // Another builder of the organization, who doesn't build this App.
    const colleague = await signedInApi(idp, "builder");
    expect({
      // An App this chat neither changes nor is the chat of.
      otherApp: await codeOf(
        builder.api.chats.previewUpdate(chatId, other.id, revision, {
          screen: "desk",
        })
      ),
      colleague: await codeOf(
        colleague.api.chats.previewUpdate(chatId, app, revision, {
          screen: "desk",
        })
      ),
      // A screen the draft hasn't: the frame opens afresh, on its first.
      noScreen: await codeOf(
        builder.api.chats.previewUpdate(chatId, app, revision, {
          screen: "nowhere",
        })
      ),
    }).toStrictEqual({
      otherApp: "app.not_in_chat",
      colleague: "app.not_found",
      noScreen: { app, restart: true },
    });
  });

  it("keeps what the preview's store holds, and seals nothing again, across writes of its screens", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const call = async (at: number, path: string, input: unknown = {}) =>
      outcome(
        await chats.previewFunction(
          chatId,
          app,
          at,
          await requestFor(builder, { chatId, app, revision: at }, path, input)
        )
      );
    await call(revision, "notes.create", { title: "kept" });
    const sealedBefore = await sealedAt(builder, chatId);
    const storesBefore = await previewStores(builder, chatId, app);
    const next = await write(
      { "screens/desk.tsx": deskSaying("Changed") },
      revision
    );
    await chats.previewUpdate(chatId, app, next, { screen: "desk" });
    const kept = await call(next, "notes.titles");
    const sealedAfter = await sealedAt(builder, chatId);
    const storesAfter = await previewStores(builder, chatId, app);
    // A write of its server code starts afresh, on a new release.
    const server = await write(
      {
        "server/notes.ts": notesFiles("rewritten")["server/notes.ts"] ?? "",
      },
      next
    );
    const fresh = await call(server, "notes.titles");
    expect({
      kept,
      sealed: [sealedBefore, sealedAfter],
      stores: [storesBefore, storesAfter].map((rows) =>
        rows.map(({ store_id: id }) => id)
      ),
      fresh,
    }).toStrictEqual({
      kept: ["kept"],
      sealed: [[revision], [revision]],
      stores: [
        storesBefore.map(({ store_id: id }) => id),
        storesBefore.map(({ store_id: id }) => id),
      ],
      fresh: [],
    });
  });

  it("lets only a preview's frame take updates as modules of its own, the published screen's policy as it was", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Desk" });
    const app = appIdSchema.parse(id);
    const screen = `export default function Desk() {
  return <main>Desk</main>;
}
`;
    await release(builder, app, { "screens/desk.tsx": screen });
    const published = await loadFrame(
      await builder.api.screens.open(app, "desk")
    );
    const { chatId } = await chatWithDraft(builder, app, {
      "screens/desk.tsx": screen.replace("Desk<", "Drafted<"),
    });
    const opened = await builder.api.chats.preview(chatId, app, "desk");
    const preview = await loadFrame(opened);
    // Its first version, opened read-only: the very same build, which
    // takes no updates, so its policy allows none.
    const readOnlyOpened = await builder.api.chats.preview(
      chatId,
      app,
      "desk",
      1
    );
    const readOnly = await loadFrame(readOnlyOpened);
    /** Whether `frame`'s policy runs any module of its own directory. */
    const takesUpdates = (frame: LoadedFrame | null): boolean =>
      scripts(frame).includes(
        new URL("./", frame?.screen.entry ?? "https://core/").href
      );
    expect({
      sameBuild: readOnlyOpened.artifact === opened.artifact,
      published: takesUpdates(published),
      preview: takesUpdates(preview),
      readOnly: takesUpdates(readOnly),
      // Still no network, eval, `data:` or `blob:` in any.
      connect: [published, preview, readOnly].map((frame) =>
        frame?.policy.get("connect-src")
      ),
      eval: [published, preview, readOnly].map((frame) =>
        scripts(frame).some(
          (source) =>
            source.includes("eval") || source === "blob:" || source === "data:"
        )
      ),
    }).toStrictEqual({
      sameBuild: true,
      published: false,
      preview: true,
      readOnly: false,
      connect: [["'none'"], ["'none'"], ["'none'"]],
      eval: [false, false, false],
    });
  });

  it("keeps a frame on the last version that worked calling the draft's code, following its data and reporting, until changed server code builds", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    // What a screen's call sends: its reference, the same for every
    // revision of the same server code.
    const titles = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    await chats.previewFunction(
      chatId,
      app,
      revision,
      await requestFor(builder, { chatId, app, revision }, "notes.create", {
        title: "still here",
      })
    );
    // The agent writes a screen that doesn't build: the frame keeps the
    // version at `revision`, and calls from there.
    const broken = await write(
      { "screens/desk.tsx": "export default function Desk( {" },
      revision
    );
    const calls = outcome(
      await chats.previewFunction(chatId, app, revision, titles)
    );
    const live = livePushes();
    await chats.previewWatchQuery(chatId, app, revision, titles, live.push);
    await live.until((latest) => {
      expect(latest?.result).toStrictEqual({ ok: true, value: ["still here"] });
    });
    // What the frame met trying the broken update is filed under the
    // revision it tried; what the earlier screen it shows meets, nowhere.
    await chats.previewReport(chatId, app, broken, "desk", {
      kind: "error",
      message: "The fix didn't render.",
    });
    await chats.previewReport(chatId, app, revision, "desk", {
      kind: "error",
      message: "The earlier screen failed.",
    });
    const reported = await chatsOf(builder).previewReports(
      chatId,
      app,
      broken,
      0
    );
    // A later revision than the draft's, or changed server code once the
    // preview built it: nothing from the old frame reaches it any more.
    const ahead = await codeOf(
      chats.previewFunction(chatId, app, broken + 1, "{}")
    );
    const server = await write(
      {
        "server/notes.ts": notesFiles("changed")["server/notes.ts"] ?? "",
        "screens/desk.tsx": notesFiles("drafted")["screens/desk.tsx"] ?? "",
      },
      broken
    );
    await chats.previewUpdate(chatId, app, server, { screen: "desk" });
    const afterServer = await codeOf(
      chats.previewFunction(chatId, app, revision, "{}")
    );
    expect({
      calls,
      reported: reported.problems.map(({ message }) => message),
      ahead,
      afterServer,
    }).toStrictEqual({
      calls: ["still here"],
      reported: ["The fix didn't render."],
      ahead: "app.preview_outdated",
      afterServer: "app.preview_outdated",
    });
  });

  it("decides a revision's check only by what that revision's screen ran into, never an earlier screen's", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const object = chatsOf(builder);
    const titles = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    const broken = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.broken"
    );
    // A false pass: the agent writes the screen again, and before the
    // frame takes it, the screen still on `revision` calls fine. The new
    // revision is no more seen than before.
    const next = await write(
      { "screens/desk.tsx": deskSaying("Unseen") },
      revision
    );
    await chats.previewFunction(chatId, app, revision, titles);
    const unseen = await object.previewReports(chatId, app, next, 0);
    // A false failure: the earlier screen's call fails through the
    // draft's code, which the new revision's screen never called.
    await chats.previewFunction(chatId, app, revision, broken);
    const notFailed = await object.previewReports(chatId, app, next, 0);
    // Its own screen's calls decide it, a failure included.
    await chats.previewFunction(chatId, app, next, broken);
    const own = await object.previewReports(chatId, app, next, 0);
    expect({
      unseen: { seen: unseen.seen, problems: unseen.problems },
      notFailed: { seen: notFailed.seen, problems: notFailed.problems },
      own: {
        seen: own.seen,
        problems: own.problems.map(({ source, at }) => ({ source, at })),
      },
    }).toStrictEqual({
      unseen: { seen: false, problems: [] },
      notFailed: { seen: false, problems: [] },
      own: {
        seen: true,
        problems: [{ source: "server", at: "notes.broken" }],
      },
    });
  });

  it("stages a build again whose manifest was staged in an earlier format, and opens it at once", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Desk" });
    const app = appIdSchema.parse(id);
    await release(builder, app, {
      "screens/desk.tsx": `export default function Desk() {
  return <main>Desk</main>;
}
`,
    });
    const opened = await builder.api.screens.open(app, "desk");
    const staged = await env.FILES.get(frameKey(opened.artifact));
    const current = stagedFrameSchema.parse(await staged?.json());
    // As a deploy before this format left it: no `preview`, at the key of
    // its own format, and none of this one's.
    const { preview: _preview, ...earlier } = current;
    await env.FILES.delete(frameKey(opened.artifact));
    await env.FILES.put(
      `screen-frames/${opened.artifact}.json`,
      JSON.stringify(earlier)
    );
    const again = await builder.api.screens.open(app, "desk");
    const frame = await loadFrame(again);
    expect({
      sameBuild: again.artifact === opened.artifact,
      status: frame?.status,
    }).toStrictEqual({ sameBuild: true, status: 200 });
  });

  it("builds a preview's revision for its own person alone, and never one the draft moved past", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const object = chatsOf(builder);
    const built: number[] = [];
    const building = (at: number) => async (): Promise<PreviewUpdate> => {
      built.push(at);
      return await Promise.resolve(builtAt(app, at, String(at)));
    };
    const next = await write(
      { "screens/desk.tsx": deskSaying("Newer") },
      revision
    );
    const newer = await object.previewBuild(
      chatId,
      builder.userId,
      app,
      "update:desk",
      next,
      building(next)
    );
    // A preview that still knows only the revision before asks for it.
    const older = await codeOf(
      object.previewBuild(
        chatId,
        builder.userId,
        app,
        "update:desk",
        revision,
        building(revision)
      )
    );
    // Someone else's chat builds nothing of it, nor shares its build.
    const elsewhere = await codeOf(
      object.previewBuild(
        chatId,
        "someone-else",
        app,
        "update:desk",
        next,
        building(next)
      )
    );
    expect({
      newer: entryBuilt(newer),
      older,
      elsewhere,
      built,
    }).toStrictEqual({
      newer: String(next),
      older: "app.preview_outdated",
      elsewhere: "agent.chat_not_found",
      built: [next],
    });
  });

  it("takes the draft's new server code in place: a live query of the revision before is told it is out of date, never that the App is gone, and the next revision's reads the new code", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const titles = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    const before = livePushes();
    await chats.previewWatchQuery(chatId, app, revision, titles, before.push);
    await before.until((latest) => {
      expect(latest?.result).toStrictEqual({ ok: true, value: [] });
    });
    // Past the second a live query's look at its access holds
    // (query-subscriptions.ts), as on a page open a while: the change is
    // met by that look first.
    await scheduler.wait(1100);
    // The agent changes the server code alone: the frame takes the build
    // of the next revision, its screen as it was.
    const next = await write(
      { "server/notes.ts": titlesSaying("new code") },
      revision
    );
    const update = refreshed(
      await chats.previewUpdate(chatId, app, next, { screen: "desk" })
    );
    await before.until((latest) => {
      expect(latest?.result).toMatchObject({ ok: false });
    });
    const after = livePushes();
    await chats.previewWatchQuery(chatId, app, next, titles, after.push);
    await after.until((latest) => {
      expect(latest?.result).toStrictEqual({ ok: true, value: ["new code"] });
    });
    expect({
      revision: update.revision,
      serverUnbuilt: update.serverUnbuilt,
      refused: refusedIn(before.pushed),
    }).toStrictEqual({
      revision: next,
      serverUnbuilt: undefined,
      refused: ["app.preview_outdated"],
    });
  });

  it("shows the draft's screens on the last server code that built while its own doesn't, keeping what the preview's store holds, then takes its server code once it builds", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const titles = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    await chats.previewFunction(
      chatId,
      app,
      revision,
      await requestFor(builder, { chatId, app, revision }, "notes.create", {
        title: "kept",
      })
    );
    // Server code that fails its type check, then a write of the screen.
    const broken = await write({ "server/notes.ts": titlesUnbuilt }, revision);
    const atBroken = refreshed(
      await chats.previewUpdate(chatId, app, broken, { screen: "desk" })
    );
    const page = await write(
      { "screens/desk.tsx": deskSaying("Changed") },
      broken
    );
    const atPage = refreshed(
      await chats.previewUpdate(chatId, app, page, { screen: "desk" })
    );
    const onPage = outcome(
      await chats.previewFunction(chatId, app, page, titles)
    );
    const live = livePushes();
    await chats.previewWatchQuery(chatId, app, page, titles, live.push);
    await live.until((latest) => {
      expect(latest?.result).toStrictEqual({ ok: true, value: ["kept"] });
    });
    // The agent fixes the server code: the frame takes it as any write.
    const fixed = await write(
      { "server/notes.ts": titlesSaying("fixed") },
      page
    );
    const atFixed = refreshed(
      await chats.previewUpdate(chatId, app, fixed, { screen: "desk" })
    );
    const onFixed = outcome(
      await chats.previewFunction(chatId, app, fixed, titles)
    );
    const pageAfter = await codeOf(
      chats.previewFunction(chatId, app, page, titles)
    );
    expect({
      broken: atBroken.serverUnbuilt,
      page: {
        serverUnbuilt: atPage.serverUnbuilt,
        changed: atPage.entry !== atBroken.entry,
        titles: onPage,
      },
      fixed: { serverUnbuilt: atFixed.serverUnbuilt, titles: onFixed },
      pageAfter,
    }).toStrictEqual({
      broken: true,
      page: { serverUnbuilt: true, changed: true, titles: ["kept"] },
      fixed: { serverUnbuilt: undefined, titles: ["fixed"] },
      pageAfter: "app.preview_outdated",
    });
  });

  it("seals the same release whatever the draft's screens and components hold, but not its server code", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Notes" });
    const app = appIdSchema.parse(id);
    const base = {
      ...notesFiles("sealed"),
      "components/badge.tsx": `export const Badge = () => <span>One</span>;
`,
    };
    /**
     * What a seal of `files` holds, with the whole tree's hash taken out
     * wherever it is recorded (the manifest's identity, which its
     * verification report repeats), and the hashes that cover it.
     */
    const sealedOf = async (files: Record<string, string>) => {
      const sealed = await sealDraftRelease(
        env,
        { app, version: 1 },
        new Map(Object.entries(files))
      );
      const decoder = new TextDecoder();
      const bySha = new Map(
        sealed.artifacts.map(({ sha256, bytes }) => [
          sha256,
          decoder.decode(bytes),
        ])
      );
      const manifest = sealedManifestSchema.parse(JSON.parse(sealed.manifest));
      return {
        identity: withoutTree(
          JSON.stringify({
            ...manifest,
            artifacts: undefined,
            verificationReportHash: undefined,
          })
        ),
        contents: Object.fromEntries(
          manifest.artifacts.map(({ path, sha256 }) => [
            path,
            path.endsWith(".json")
              ? withoutTree(bySha.get(sha256) ?? "")
              : bySha.get(sha256),
          ])
        ),
      };
    };
    const [before, screensOnly, server] = await Promise.all([
      sealedOf(base),
      sealedOf({
        ...base,
        "components/badge.tsx": `export const Badge = () => <span>Two</span>;
`,
        "screens/desk.tsx": "export default function Desk( {",
      }),
      sealedOf({
        ...base,
        "server/notes.ts": notesFiles("changed")["server/notes.ts"] ?? "",
      }),
    ]);
    // Only the whole tree's hash, provenance, tells the first two apart:
    // every module, generated file and the rest of the identity are one.
    expect({
      screensOnly,
      server:
        JSON.stringify(server.contents) === JSON.stringify(before.contents),
    }).toStrictEqual({ screensOnly: before, server: false });
  });
});
