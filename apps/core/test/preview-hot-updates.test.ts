import { sha256Hex } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { sealDraftRelease } from "../src/app-releases.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { livePushes, notesFiles, previewDraftsOf } from "./preview-drafts.ts";
import {
  chatsOf,
  chatWithDraft,
  outcome,
  previewStores,
  requestFor,
} from "./previews.ts";
import { loadFrame } from "./screen-frames.ts";
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
// the seal does read taken for one it doesn't.

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
  it("answers the screen of the draft now as one module, its size and SHA-256 for the frame to check, within the kit the frame loaded", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const opened = await chats.preview(chatId, app, "desk");
    const next = await write(
      { "screens/desk.tsx": deskSaying("Hot") },
      revision
    );
    // Warm, as the person's next write finds it: measured each time.
    const started = performance.now();
    const updated = await chats.previewUpdate(chatId, app, "desk");
    const updateMs = performance.now() - started;
    const again = await write(
      { "screens/desk.tsx": deskSaying("Again") },
      next
    );
    const secondStarted = performance.now();
    const second = await chats.previewUpdate(chatId, app, "desk");
    const secondMs = performance.now() - secondStarted;
    // What the frame checks before it evaluates anything.
    const { refresh } = updated;
    const bytes = new TextEncoder().encode(refresh.code).byteLength;
    console.info(
      `preview update after a screen write: ${Math.round(updateMs)} ms, then ${Math.round(secondMs)} ms`
    );
    expect({
      app: updated.app,
      revision: refresh.revision,
      screen: refresh.screen,
      says: refresh.code.includes('"Hot "'),
      bytes: refresh.bytes === bytes,
      sha256: refresh.sha256 === (await sha256Hex(refresh.code)),
      css: refresh.css.length > 0,
      withinKit: refresh.kit.every((name) =>
        (opened.refresh?.kit ?? []).includes(name)
      ),
      opened: opened.refresh?.revision,
      second: {
        revision: second.refresh.revision,
        says: second.refresh.code.includes('"Again "'),
      },
    }).toStrictEqual({
      app,
      revision: next,
      screen: "desk",
      says: true,
      bytes: true,
      sha256: true,
      css: true,
      withinKit: true,
      opened: revision,
      second: { revision: again, says: true },
    });
  });

  it("answers only the person's own chat's draft of an App they build, never another App's", async () => {
    const { builder, app, chatId } = await setUp();
    const other = await builder.api.apps.create({ name: "Other" });
    await release(builder, other.id, notesFiles("other"));
    // Another builder of the organization, who doesn't build this App.
    const colleague = await signedInApi(idp, "builder");
    expect({
      // An App this chat builds no draft of.
      otherApp: await codeOf(
        builder.api.chats.previewUpdate(chatId, other.id, "desk")
      ),
      colleague: await codeOf(
        colleague.api.chats.previewUpdate(chatId, app, "desk")
      ),
      // A screen the draft hasn't.
      noScreen: await codeOf(
        builder.api.chats.previewUpdate(chatId, app, "nowhere")
      ),
    }).toStrictEqual({
      otherApp: "app.no_draft",
      colleague: "app.not_found",
      noScreen: "screen.not_found",
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
    await chats.previewUpdate(chatId, app, "desk");
    const kept = await call(next, "notes.titles");
    const sealedAfter = await sealedAt(builder, chatId);
    const storesAfter = await previewStores(builder, chatId, app);
    // A write of its server code starts afresh, on a new release.
    const server = await write(
      {
        "operations/notes.ts":
          notesFiles("rewritten")["operations/notes.ts"] ?? "",
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
    expect({
      sameBuild: readOnlyOpened.artifact === opened.artifact,
      published: scripts(published).includes("data:"),
      preview: scripts(preview).includes("data:"),
      readOnly: scripts(readOnly).includes("data:"),
      // Still no network, eval or `blob:` in any.
      connect: [published, preview, readOnly].map((frame) =>
        frame?.policy.get("connect-src")
      ),
      eval: [published, preview, readOnly].map((frame) =>
        scripts(frame).some(
          (source) => source.includes("eval") || source === "blob:"
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

  it("keeps a frame on the last version that worked calling the draft's code, following its data and reporting, until the server code changes", async () => {
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
    await chats.previewReport(chatId, app, revision, "desk", {
      kind: "error",
      message: "The fix didn't render.",
    });
    const reported = await chatsOf(builder).previewReports(
      chatId,
      app,
      broken,
      0
    );
    // A later revision than the draft's, or the server code changing:
    // nothing from the old frame reaches it any more.
    const ahead = await codeOf(
      chats.previewFunction(chatId, app, broken + 1, "{}")
    );
    await write(
      {
        "operations/notes.ts":
          notesFiles("changed")["operations/notes.ts"] ?? "",
      },
      broken
    );
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

  it("opens a version of the App only from the person's own chat", async () => {
    const { builder, app } = await setUp();
    const other = await signedInApi(idp, "builder");
    const othersChat = await other.api.chats.create("Theirs");
    expect({
      othersChat: await codeOf(
        builder.api.chats.preview(othersChat.id, app, "desk", undefined, 1)
      ),
      unknown: await codeOf(
        builder.api.chats.preview(
          crypto.randomUUID(),
          app,
          "desk",
          undefined,
          1
        )
      ),
    }).toStrictEqual({
      othersChat: "agent.chat_not_found",
      unknown: "agent.chat_not_found",
    });
  });

  it("builds one preview of a chat's App at a time, the newest ask waiting and the one it replaced refused, freeing the place however a build ends", async () => {
    const { builder, app, chatId } = await setUp();
    const object = chatsOf(builder);
    const order: string[] = [];
    let running = 0;
    let most = 0;
    const gate = Promise.withResolvers<null>();
    const build =
      (name: string, held?: Promise<null>, fails = false) =>
      async (): Promise<void> => {
        running += 1;
        most = Math.max(most, running);
        order.push(`${name} builds`);
        await held;
        running -= 1;
        if (fails) {
          throw new Error(`${name} failed`);
        }
      };
    const first = codeOf(
      object.previewBuild(
        chatId,
        builder.userId,
        app,
        build("first", gate.promise, true)
      )
    );
    // The first holds its place: the next two wait, the newer replacing
    // the older.
    await vi.waitFor(() => {
      expect(order).toStrictEqual(["first builds"]);
    });
    const second = codeOf(
      object.previewBuild(chatId, builder.userId, app, build("second"))
    );
    const third = codeOf(
      object.previewBuild(chatId, builder.userId, app, build("third"))
    );
    const replaced = await second;
    gate.resolve(null);
    const outcomes = {
      // A build that failed gives its place up all the same.
      first: String(await first).includes("first failed"),
      replaced,
      third: await third,
    };
    // Someone else's chat holds no place in it.
    const elsewhere = await codeOf(
      object.previewBuild(chatId, "someone-else", app, build("elsewhere"))
    );
    expect({ order, most, outcomes, elsewhere }).toStrictEqual({
      order: ["first builds", "third builds"],
      most: 1,
      outcomes: {
        first: true,
        replaced: "app.preview_superseded",
        third: undefined,
      },
      elsewhere: "agent.chat_not_found",
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
        "operations/notes.ts":
          notesFiles("changed")["operations/notes.ts"] ?? "",
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
