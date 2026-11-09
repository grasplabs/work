import type { PreviewBundle, PreviewUpdate } from "@grasp-os/shared/chat";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { sealDraftRelease } from "../src/app-releases.ts";
import { frameAccess, frameKey } from "../src/page-frame.ts";
import { withFiles } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  allowsScript,
  frameDocument,
  loadFrame,
  servedAll,
} from "./page-frames.ts";
import type { LoadedFrame } from "./page-frames.ts";
import { notesFiles, previewDraftsOf } from "./preview-drafts.ts";
import {
  chatsOf,
  chatWithDraft,
  outcome,
  previewCall,
  previewStores,
  requestFor,
  refreshed,
} from "./previews.ts";
import { signedInApi } from "./sign-in.ts";

// A chat's preview taking each write of its draft in the frame it has
// open (chats.previewUpdate, spec 19.2.1): the page as one module for
// React Fast Refresh, built without staging a frame or sealing anything
// when only pages changed. The ways it can fail, from the threat model
// in core's page-frame.ts: the frame handed another App's module, or
// another revision's; someone who doesn't build the App getting the
// draft's code; the policy of a production frame loosened to take
// updates; a write of a page throwing away what the preview's store
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

/** An update of `app`'s preview at `revision`, its page's module `entry`, as a build answers one. */
const builtAt = (
  app: AppId,
  revision: number,
  entry: string
): PreviewUpdate => ({
  app,
  refresh: { revision, entry, modules: {}, css: "", kit: [] },
});

/** The page's module of what a build answered, an update. */
const entryBuilt = (built: PreviewBundle | PreviewUpdate): string =>
  "refresh" in built ? (built.refresh?.entry ?? "") : "";

/** What the test reads of a staged frame's manifest. */
const stagedFrameSchema = z.object({ preview: z.boolean() }).loose();

/** The desk page of the notes App, saying `word` before its titles. */
const deskSaying = (word: string): string =>
  (notesFiles("drafted").files["src/routes/index.tsx"] ?? "").replace(
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
  (notesFiles("drafted").files["server/notes.ts"] ?? "").replace(
    '(await ctx.db.query("notes").take(100)).map((note) => note.title).sort()',
    JSON.stringify([title])
  );

/**
 * The notes App's server code reading past what a query takes at once: it
 * fails its type check, so it doesn't build.
 */
const titlesUnbuilt = (
  notesFiles("drafted").files["server/notes.ts"] ?? ""
).replace(
  'ctx.db.query("notes").take(100)).map',
  'ctx.db.query("notes").take(1000)).map'
);

/** What a frame's policy lets run. */
const scripts = (frame: LoadedFrame | null): string[] =>
  frame?.policy.get("script-src") ?? [];

describe("a preview taking its draft's writes", { timeout: 180_000 }, () => {
  it("answers the page of the draft now by its module's address, staging only the modules the write changed where the open frame loads them, within the kit it loaded", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const opened = await chats.preview(chatId, app);
    const frame = await loadFrame(opened);
    const next = await write(
      { "src/routes/index.tsx": deskSaying("Hot") },
      revision
    );
    // Warm, as the person's next write finds it: measured each time.
    const started = performance.now();
    const updated = await chats.previewUpdate(chatId, app, next, {});
    const updateMs = performance.now() - started;
    const again = await write(
      { "src/routes/index.tsx": deskSaying("Again") },
      next
    );
    const secondStarted = performance.now();
    const second = await chats.previewUpdate(chatId, app, again, {});
    const secondMs = performance.now() - secondStarted;
    console.info(
      `preview update after a page write: ${Math.round(updateMs)} ms, then ${Math.round(secondMs)} ms`
    );
    const refresh = refreshed(updated);
    const before = Object.keys(opened.refresh?.modules ?? {});
    const entry = await servedAll(frame, refresh);
    const secondEntry = await servedAll(frame, refreshed(second));
    expect({
      app: updated.app,
      revision: refresh.revision,
      says: /["`]Hot ["`]/u.test(entry.code),
      served: entry.status,
      // The page's module changed, and the route tree, which imports it
      // at its address: the other components are where the frame loaded
      // them.
      changed: Object.keys(refresh.modules).filter(
        (address) => !before.includes(address)
      ).length,
      treeChanged: !before.includes(refresh.entry),
      css: refresh.css.length > 0,
      withinKit: refresh.kit.every((name) =>
        (opened.refresh?.kit ?? []).includes(name)
      ),
      opened: opened.refresh?.revision,
      second: {
        revision: refreshed(second).revision,
        says: /["`]Again ["`]/u.test(secondEntry.code),
      },
    }).toStrictEqual({
      app,
      revision: next,
      says: true,
      served: 200,
      changed: 2,
      treeChanged: true,
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
        builder.api.chats.previewUpdate(chatId, other.id, revision, {})
      ),
      colleague: await codeOf(
        colleague.api.chats.previewUpdate(chatId, app, revision, {})
      ),
    }).toStrictEqual({
      otherApp: "app.not_in_chat",
      colleague: "app.not_found",
    });
  });

  it("keeps what the preview's store holds across writes of its pages and its server code, while its schema stays", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const call = async (at: number, path: string, input: unknown = {}) =>
      outcome(
        await previewCall(
          builder,
          chatId,
          app,
          await requestFor(builder, { chatId, app, revision: at }, path, input)
        )
      );
    await call(revision, "notes.create", { title: "kept" });
    const storesBefore = await previewStores(builder, chatId, app);
    const next = await write(
      { "src/routes/index.tsx": deskSaying("Changed") },
      revision
    );
    await chats.previewUpdate(chatId, app, next, {});
    const kept = await call(next, "notes.titles");
    const server = await write(
      {
        "server/notes.ts":
          notesFiles("rewritten").files["server/notes.ts"] ?? "",
      },
      next
    );
    const rewritten = await call(server, "notes.titles");
    const storesAfter = await previewStores(builder, chatId, app);
    expect({
      kept,
      rewritten,
      stores: [storesBefore, storesAfter].map((rows) =>
        rows.map(({ store_id: id }) => id)
      ),
    }).toStrictEqual({
      kept: ["kept"],
      rewritten: ["kept"],
      stores: [
        storesBefore.map(({ store_id: id }) => id),
        storesBefore.map(({ store_id: id }) => id),
      ],
    });
  });

  it("lets only a preview's frame take updates as modules of its own, the published page's policy as it was", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Desk" });
    const app = appIdSchema.parse(id);
    const page = `import { createFileRoute } from "@tanstack/react-router";

function Desk() {
  return <main>Desk</main>;
}
export const Route = createFileRoute("/")({ component: Desk });
`;
    await release(builder, app, { "src/routes/index.tsx": page });
    const published = await loadFrame(await builder.api.pages.open(app));
    const { chatId, revision, write } = await chatWithDraft(builder, app, {
      "src/routes/index.tsx": page.replace("Desk<", "Drafted<"),
    });
    const opened = await builder.api.chats.preview(chatId, app);
    const preview = await loadFrame(opened);
    // Its first version, opened read-only: the same code, which takes no
    // updates, so it is staged apart from the draft's writes.
    const readOnlyOpened = await builder.api.chats.preview(chatId, app, 1);
    const readOnly = await loadFrame(readOnlyOpened);
    // The draft's next write, staged where the open preview loads it.
    const next = await write(
      { "src/routes/index.tsx": page.replace("Desk<", "Written<") },
      revision
    );
    const { entry } = refreshed(
      await builder.api.chats.previewUpdate(chatId, app, next, {})
    );
    const written = new URL(`${entry}.js`, preview?.page.entry).href;
    /** Whether `frame`'s policy runs the module the write staged. */
    const takesUpdates = (frame: LoadedFrame | null): boolean =>
      frame !== null && allowsScript(frame, written);
    // The draft's shared scope framed with a token that takes no updates,
    // which core never hands out: it would name every write's modules.
    const sharedAsIs = await frameDocument({
      artifact: opened.artifact,
      frameToken: await frameAccess(env, opened.artifact),
    });
    expect({
      sharedAsIs: sharedAsIs.status,
      // Its own build's directory, a scope of its own.
      readOnlyDirectory: new URL("./", readOnly?.page.entry).pathname,
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
      sharedAsIs: 403,
      readOnlyDirectory: `/page-modules/${readOnlyOpened.artifact}/`,
      published: false,
      preview: true,
      readOnly: false,
      connect: [["'none'"], ["'none'"], ["'none'"]],
      eval: [false, false, false],
    });
  });

  it("stages a build again whose manifest was staged in an earlier format, and opens it at once", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Desk" });
    const app = appIdSchema.parse(id);
    await release(builder, app, {
      "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

function Desk() {
  return <main>Desk</main>;
}
export const Route = createFileRoute("/")({ component: Desk });
`,
    });
    const opened = await builder.api.pages.open(app);
    const staged = await env.FILES.get(frameKey(opened.artifact));
    const current = stagedFrameSchema.parse(await staged?.json());
    // As a deploy before this format left it: no `preview`, at the key of
    // its own format, and none of this one's.
    const { preview: _preview, ...earlier } = current;
    await env.FILES.delete(frameKey(opened.artifact));
    await env.FILES.put(
      `page-frames/${opened.artifact}.json`,
      JSON.stringify(earlier)
    );
    const again = await builder.api.pages.open(app);
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
      { "src/routes/index.tsx": deskSaying("Newer") },
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

  it("says the draft's server code doesn't build even of a page that calls none of it", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const broken = await write(
      {
        "server/notes.ts": titlesUnbuilt,
        "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";

function Desk() {
  return <main>Static</main>;
}

export const Route = createFileRoute("/")({ component: Desk });
`,
      },
      revision
    );
    const update = refreshed(
      await chats.previewUpdate(chatId, app, broken, {})
    );
    const fixed = await write(
      { "server/notes.ts": titlesSaying("fixed") },
      broken
    );
    const afterFix = refreshed(
      await chats.previewUpdate(chatId, app, fixed, {})
    );
    expect({
      broken: update.serverUnbuilt,
      fixed: afterFix.serverUnbuilt,
    }).toStrictEqual({ broken: true, fixed: undefined });
  });

  it("seals the same release whatever the draft's pages and components hold, but not its server code", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Notes" });
    const app = appIdSchema.parse(id);
    const base = withFiles(notesFiles("sealed"), {
      "src/components/badge.tsx": `export const Badge = () => <span>One</span>;
`,
    });
    /**
     * What a seal of `files` holds, with the whole tree's hash taken out
     * wherever it is recorded (the manifest's identity, which its
     * verification report repeats), and the hashes that cover it.
     */
    const sealedOf = async (files: TestApp) => {
      const sealed = await sealDraftRelease(
        env,
        { app, version: 1 },
        new Map(Object.entries(files.files)),
        files.definition
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
    const [before, pagesOnly, server] = await Promise.all([
      sealedOf(base),
      sealedOf(
        withFiles(base, {
          "src/components/badge.tsx": `export const Badge = () => <span>Two</span>;
`,
          "src/routes/index.tsx": "export default function Desk( {",
        })
      ),
      sealedOf(
        withFiles(base, {
          "server/notes.ts":
            notesFiles("changed").files["server/notes.ts"] ?? "",
        })
      ),
    ]);
    // Only the whole tree's hash, provenance, tells the first two apart:
    // every module, generated file and the rest of the identity are one.
    expect({
      pagesOnly,
      server:
        JSON.stringify(server.contents) === JSON.stringify(before.contents),
    }).toStrictEqual({ pagesOnly: before, server: false });
  });
});
