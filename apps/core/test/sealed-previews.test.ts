import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalText } from "@grasp-os/shared/json";
import { screenLimits } from "@grasp-os/shared/screens";
import type { QuerySnapshotPush } from "@grasp-os/shared/screens";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { loadRelease } from "../src/app-releases.ts";
import { ChatsRpc } from "../src/chats-rpc.ts";
import { openStore } from "../src/data-stores.ts";
import { openTestRun } from "./agent-chat.ts";
import { mockIdp } from "./idp.ts";
import {
  answerHashOf,
  livePushes,
  notesApp,
  notesFiles,
  previewDraftsOf,
} from "./preview-drafts.ts";
import {
  chatsOf,
  chatWithDraft,
  keptManifestSchema,
  outcome,
  outcomeOfText,
  previewStores,
  requestFor,
} from "./previews.ts";
import { appModulesOf, loadFrame } from "./screen-frames.ts";
import { calledAs, failure } from "./sealed-apps.ts";
import { auditedDuring, signedInApi } from "./sign-in.ts";

// A chat's preview of its draft of an App of spec 8's layout
// (sealed-previews.ts): the draft sealed into a draft release, and every
// call of its screens, its live queries and the chat's agent run on it
// through the operation host, on a store of the preview's own. These
// tests start from the ways it can fail (the threat model on GRA-652):
// the draft reads or writes the App's data, reaches an outside system,
// runs code that wasn't sealed or changed since, is taken for a version's
// release, is used by someone else or once its person no longer builds
// the App, outlives its draft or its use, or leaks one preview's data into
// another's.

const idp = mockIdp();
const { setUp } = previewDraftsOf(idp);

describe("previewing a draft of spec 8's layout", { timeout: 180_000 }, () => {
  it("runs the draft's functions on its draft release, on a store of its own, and changes none of the App's data", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const asBuilder = {
      userId: builder.userId,
      role: "builder" as const,
      teams: [],
    };
    await calledAs(
      asBuilder,
      app,
      { contractId: "notes.create", kind: "mutation" },
      {
        title: "live",
      }
    );

    const call = async (at: number, path: string, input: unknown = {}) =>
      outcome(
        await chats.previewFunction(
          chatId,
          app,
          at,
          await requestFor(builder, { chatId, app, revision: at }, path, input)
        )
      );
    // The screen builds with the references its draft release generates.
    const bundle = await chats.preview(chatId, app);
    const first = {
      created: typeof (await call(revision, "notes.create", {
        title: "draft",
      })),
      // It reads the preview's notes, none of the App's.
      preview: await call(revision, "notes.titles"),
      app: await calledAs(asBuilder, app, {
        contractId: "notes.titles",
        kind: "query",
      }),
    };
    const [kept] = await previewStores(builder, chatId, app);
    // The preview's store is no store of the inventory's.
    const opened = await failure(
      async () => await openStore(env, kept?.store_id ?? "")
    );
    // The draft release is the release of no version of the App's.
    const sealed = await failure(async () => await loadRelease(env, app, 2));

    // A write starts the next revision on a new, empty store; a call of
    // the revision before is out of date.
    const stale = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    const next = await write(
      {
        "operations/notes.ts": notesFiles("again")["operations/notes.ts"] ?? "",
      },
      revision
    );
    const changed = {
      earlier: await failure(
        async () => await chats.previewFunction(chatId, app, revision, stale)
      ),
      notes: await call(next, "notes.titles"),
    };
    await vi.waitFor(async () => {
      // The store of the revision before is discarded and forgotten.
      const stores = await previewStores(builder, chatId, app);
      expect(stores.map((row) => row.revision)).toStrictEqual([next]);
    });

    expect({
      modules: appModulesOf(
        (await loadFrame(bundle)) ?? { modules: {} }
      ).includes("app~screens~desk.js"),
      first,
      opened,
      sealed,
      changed,
    }).toStrictEqual({
      modules: true,
      first: {
        created: "string",
        preview: ["draft"],
        app: { ok: true, value: ["live"] },
      },
      opened: "data.store_unavailable",
      sealed: "version.not_sealed",
      changed: { earlier: "app.preview_outdated", notes: [] },
    });
  });

  it("reaches no outside system: every resource request is refused, and nothing is audited", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const request = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.consult"
    );
    let answer: unknown;
    const events = await auditedDuring(async () => {
      answer = await builder.api.chats.previewFunction(
        chatId,
        app,
        revision,
        request
      );
    });
    expect({ consulted: outcome(answer), events }).toStrictEqual({
      consulted: "resource.unavailable",
      events: [],
    });
  });

  it("refuses a screen's workflow requests: a preview starts, controls and follows no run", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const workflow = {
      resourceId: app,
      resourceVersion: 1,
      contractId: "workflows.followUp",
      fingerprint: "0".repeat(64),
      kind: "workflow",
    };
    const live = livePushes();
    const { pushed } = live;
    const page = Object.assign(
      (push: QuerySnapshotPush): void => {
        live.push(push);
      },
      {
        [Symbol.dispose]: (): void => {
          // Let go of: nothing more arrives.
        },
      }
    );
    const started = outcome(
      await builder.api.chats.previewFunction(
        chatId,
        app,
        revision,
        JSON.stringify({
          workflow,
          command: "start",
          input: {},
          idempotencyKey: "0".repeat(32),
        })
      )
    );
    const watched = await builder.api.chats.previewWatchQuery(
      chatId,
      app,
      revision,
      JSON.stringify({ workflow, watch: "binding" }),
      page
    );
    await live.until((latest) => {
      expect(latest).toBeDefined();
    });
    await watched.release();
    expect({
      started,
      watched: pushed.map(({ result }) => outcome({ result })),
    }).toStrictEqual({
      started: "contract.invalid_request",
      watched: ["contract.invalid_request"],
    });
  });

  it("runs only what was sealed: a kept artifact changed since is refused", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const request = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    const before = outcome(
      await builder.api.chats.previewFunction(chatId, app, revision, request)
    );
    // Someone changes a kept module, and the object starts again, so the
    // release is loaded back from what is kept.
    await runInDurableObject(chatsOf(builder), (_instance, state) => {
      // One of the App's own modules, not the contracts, which are
      // checked against the manifest anyway.
      const [kept] = state.storage.sql
        .exec<{ manifest: string }>(
          "SELECT manifest FROM preview_releases WHERE chat_id = ?",
          chatId
        )
        .toArray();
      const module = keptManifestSchema
        .parse(JSON.parse(kept?.manifest ?? "null"))
        .artifacts.find(({ path }) => path.startsWith("modules/"));
      state.storage.sql.exec(
        "UPDATE preview_release_artifacts SET content = content || ' ' WHERE chat_id = ? AND sha256 = ?",
        chatId,
        module?.sha256 ?? ""
      );
    });
    await runInDurableObject(chatsOf(builder), (_instance, state) => {
      state.abort("Restarted by the test");
    }).catch(() => {
      // Aborting fails the call that aborted: that is the restart.
    });
    const after = outcome(
      await builder.api.chats.previewFunction(chatId, app, revision, request)
    );
    expect({ before, after }).toStrictEqual({
      before: [],
      after: "version.artifact_corrupt",
    });
  });

  it("never runs a draft's server code, whatever server code it has", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await notesApp(builder);
    const { chatId } = await chatWithDraft(builder, app, {
      "app/server.ts": `import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  ran(): string {
    return "ran as v1";
  }
}
`,
    });
    const asAgent = await failure(
      async () =>
        await chatsOf(builder).callDraftFunction(
          chatId,
          builder.userId,
          app,
          "ran",
          {}
        )
    );
    expect({
      // No page reaches a draft's server code: there is no such call.
      called: "previewCall" in ChatsRpc.prototype,
      asAgent,
    }).toStrictEqual({ called: false, asAgent: "operation.not_found" });
  });

  it("commits nothing once its draft changed under a call already running", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const request = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.late"
    );
    const late = builder.api.chats.previewFunction(
      chatId,
      app,
      revision,
      request
    );
    // The call is under way, waiting to write.
    await scheduler.wait(1000);
    const next = await write(
      {
        "operations/notes.ts": notesFiles("again")["operations/notes.ts"] ?? "",
      },
      revision
    );
    expect({
      late: outcome(await late),
      notes: outcome(
        await builder.api.chats.previewFunction(
          chatId,
          app,
          next,
          await requestFor(
            builder,
            { chatId, app, revision: next },
            "notes.titles"
          )
        )
      ),
    }).toStrictEqual({ late: "app.preview_outdated", notes: [] });
  });

  it("is only for the chat's person while they build the App, checked again at every call", async () => {
    const owner = await signedInApi(idp, "builder");
    const app = await notesApp(owner);
    const [other, stranger] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
    ]);
    for (const person of [other, stranger]) {
      // oxlint-disable-next-line no-await-in-loop -- one member after the other
      await owner.api.apps.members.add(app, {
        type: "person",
        id: person.userId,
        role: "builder",
      });
    }
    const { chatId, revision } = await chatWithDraft(other, app, {
      "operations/notes.ts": notesFiles("drafted")["operations/notes.ts"] ?? "",
    });
    const request = await requestFor(
      other,
      { chatId, app, revision },
      "notes.create",
      { title: "kept" }
    );
    const theirs = await failure(
      async () =>
        await stranger.api.chats.previewFunction(chatId, app, revision, request)
    );
    // No longer a builder, they call the chat's object straight away, past
    // core's check of the role: its own gate refuses the call.
    await owner.api.apps.members.add(app, {
      type: "person",
      id: other.userId,
      role: "user",
    });
    const demoted = outcomeOfText(
      await chatsOf(other).previewFunction(
        chatId,
        other.userId,
        app,
        revision,
        request
      )
    );
    expect({ theirs, demoted }).toStrictEqual({
      theirs: "agent.chat_not_found",
      demoted: "role.forbidden",
    });
  });

  it("keeps a live query of the preview fresh, and ends it once the draft changes", async () => {
    const { builder, app, chatId, revision, write } = await setUp();
    const { chats } = builder.api;
    const live = livePushes();
    await chats.previewWatchQuery(
      chatId,
      app,
      revision,
      await requestFor(builder, { chatId, app, revision }, "notes.titles"),
      live.push
    );
    await live.until((latest) => {
      expect(latest?.result).toStrictEqual({ ok: true, value: [] });
    });
    await chats.previewFunction(
      chatId,
      app,
      revision,
      await requestFor(builder, { chatId, app, revision }, "notes.create", {
        title: "fresh",
      })
    );
    await live.until((latest) => {
      expect(latest?.result).toStrictEqual({
        ok: true,
        value: ["fresh"],
      });
    });
    const next = await write(
      {
        "operations/notes.ts": notesFiles("again")["operations/notes.ts"] ?? "",
      },
      revision
    );
    // The query of the revision before is let go of: nothing of the next
    // revision's store reaches it.
    await chats.previewFunction(
      chatId,
      app,
      next,
      await requestFor(
        builder,
        { chatId, app, revision: next },
        "notes.create",
        { title: "newer" }
      )
    );
    await scheduler.wait(2000);
    expect(
      live.pushed.filter(({ result }) =>
        JSON.stringify(result).includes("newer")
      )
    ).toStrictEqual([]);
  });

  it("seals a revision once for calls made together, and counts each call against the person's requests", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const { chats } = builder.api;
    // A request of this revision names the next one's functions too: a
    // write of a comment changes no contract.
    const request = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    await chatsOf(builder).saveDraft(
      chatId,
      app,
      1,
      {
        "operations/notes.ts": notesFiles("third")["operations/notes.ts"] ?? "",
      },
      [],
      revision,
      await openTestRun(chatsOf(builder), chatId)
    );
    // The next revision isn't sealed yet: the calls arrive together, each
    // runs, and none drops the seal another started.
    const together = await Promise.all(
      Array.from({ length: 3 }, async () =>
        answerHashOf(
          await chats.previewFunction(chatId, app, revision + 1, request)
        )
      )
    );
    expect(new Set(together).size).toBe(1);
    expect(together[0]).toMatch(/^[0-9a-f]{64}$/u);

    // The bucket fills again with time, so the clock is stopped.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    try {
      const other = await signedInApi(idp, "builder");
      await builder.api.apps.members.add(app, {
        type: "person",
        id: other.userId,
        role: "builder",
      });
      const theirs = await chatWithDraft(other, app, {
        "operations/notes.ts":
          notesFiles("drafted")["operations/notes.ts"] ?? "",
      });
      const codes: string[] = [];
      for (let count = 0; count <= screenLimits.requests.burst; count += 1) {
        codes.push(
          // oxlint-disable-next-line no-await-in-loop -- one request after another
          await failure(
            async () =>
              await other.api.chats.previewFunction(
                theirs.chatId,
                app,
                theirs.revision,
                "{}"
              )
          )
        );
      }
      expect(codes.at(-1)).toBe("screen.rate_limited");
      expect(codes.slice(0, -1).every((code) => code === "ok")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a kept draft release whose manifest changed, or that binds a store", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const request = await requestFor(
      builder,
      { chatId, app, revision },
      "notes.titles"
    );
    /** Rewrites the kept manifest with `change`, its hash too if `rehash`. */
    const tampered = async (
      change: (manifest: Record<string, unknown>) => Record<string, unknown>,
      rehash: boolean
    ): Promise<unknown> => {
      const kept = await runInDurableObject(
        chatsOf(builder),
        (_instance, state) =>
          state.storage.sql
            .exec<{ manifest: string; manifest_hash: string }>(
              "SELECT manifest, manifest_hash FROM preview_releases WHERE chat_id = ?",
              chatId
            )
            .toArray()
      );
      const [row] = kept;
      const parsed = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(row?.manifest ?? "null"));
      const text = canonicalText(change(parsed));
      const hash = rehash ? await sha256Hex(text) : (row?.manifest_hash ?? "");
      await runInDurableObject(chatsOf(builder), (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE preview_releases SET manifest = ?, manifest_hash = ? WHERE chat_id = ?",
          text,
          hash,
          chatId
        );
      });
      await runInDurableObject(chatsOf(builder), (_instance, state) => {
        state.abort("Restarted by the test");
      }).catch(() => {
        // Aborting fails the call that aborted: that is the restart.
      });
      const answer = outcome(
        await builder.api.chats.previewFunction(chatId, app, revision, request)
      );
      // Put back for the next case.
      await runInDurableObject(chatsOf(builder), (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE preview_releases SET manifest = ?, manifest_hash = ? WHERE chat_id = ?",
          row?.manifest ?? "",
          row?.manifest_hash ?? "",
          chatId
        );
      });
      await runInDurableObject(chatsOf(builder), (_instance, state) => {
        state.abort("Restarted by the test");
      }).catch(() => {
        // As above.
      });
      return answer;
    };
    const sha = "0".repeat(64);
    expect({
      // A manifest changed, still canonical and valid, under its old hash.
      changed: await tampered(
        (manifest) => ({ ...manifest, sdkVersion: "0.0.0-elsewhere" }),
        false
      ),
      // A manifest that binds a store, its hash made again to match.
      bound: await tampered(
        (manifest) => ({
          ...manifest,
          dataStoreBindings: [
            {
              alias: "default",
              storeId: crypto.randomUUID(),
              schemaVersion: 1,
              schemaHash: sha,
              operationManifestHash: sha,
            },
          ],
        }),
        true
      ),
      intact: outcome(
        await builder.api.chats.previewFunction(chatId, app, revision, request)
      ),
    }).toStrictEqual({
      changed: "version.manifest_corrupt",
      bound: "version.manifest_corrupt",
      intact: [],
    });
  });

  it("follows only a query live: a mutation's reference is refused, and runs nothing", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const { chats } = builder.api;
    const live = livePushes();
    const { pushed } = live;
    await chats.previewWatchQuery(
      chatId,
      app,
      revision,
      await requestFor(builder, { chatId, app, revision }, "notes.create", {
        title: "written live",
      }),
      live.push
    );
    await live.until((latest) => {
      expect(latest).toBeDefined();
    });
    const titles = outcome(
      await chats.previewFunction(
        chatId,
        app,
        revision,
        await requestFor(builder, { chatId, app, revision }, "notes.titles")
      )
    );
    expect({ first: outcome(pushed[0]), titles }).toStrictEqual({
      first: "contract.invalid_request",
      titles: [],
    });
  });

  it("reads a paginated list's window on the preview's store, then the larger window a Load More asks for", async () => {
    const { builder, app, chatId, revision } = await setUp();
    const { chats } = builder.api;
    for (const title of ["one", "two", "three"]) {
      // oxlint-disable-next-line no-await-in-loop -- one note after the other
      const create = await requestFor(
        builder,
        { chatId, app, revision },
        "notes.create",
        { title }
      );
      // oxlint-disable-next-line no-await-in-loop -- see above
      await chats.previewFunction(chatId, app, revision, create);
    }
    const windowOf = async (extent: number): Promise<unknown> => {
      const request = z
        .record(z.string(), z.unknown())
        .parse(
          JSON.parse(
            await requestFor(builder, { chatId, app, revision }, "notes.list")
          )
        );
      const answer = outcome(
        await chats.previewFunction(
          chatId,
          app,
          revision,
          JSON.stringify({ ...request, window: { extent } })
        )
      );
      const read = z
        .object({
          items: z.array(z.object({ title: z.string() })),
          hasMore: z.boolean(),
        })
        .safeParse(answer);
      return read.success
        ? {
            titles: read.data.items.map((note) => note.title),
            hasMore: read.data.hasMore,
          }
        : answer;
    };
    expect({
      first: await windowOf(2),
      more: await windowOf(4),
    }).toStrictEqual({
      first: { titles: ["one", "two"], hasMore: true },
      more: { titles: ["one", "two", "three"], hasMore: false },
    });
  });
});
