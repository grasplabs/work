import { sha256Hex } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";

import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { notesFiles, previewDraftsOf } from "./preview-drafts.ts";
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
// updates; and a write of a screen throwing away what the preview's store
// holds, or sealing the draft again.

const idp = mockIdp();
const { setUp } = previewDraftsOf(idp);

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
    const preview = await loadFrame(
      await builder.api.chats.preview(chatId, app, "desk")
    );
    expect({
      published: scripts(published).includes("data:"),
      preview: scripts(preview).includes("data:"),
      // Still no network, eval or `blob:` in either.
      connect: [published, preview].map((frame) =>
        frame?.policy.get("connect-src")
      ),
      eval: [published, preview].map((frame) =>
        scripts(frame).some(
          (source) => source.includes("eval") || source === "blob:"
        )
      ),
    }).toStrictEqual({
      published: false,
      preview: true,
      connect: [["'none'"], ["'none'"]],
      eval: [false, false],
    });
  });
});
