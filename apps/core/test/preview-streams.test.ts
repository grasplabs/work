import { appIdSchema } from "@grasp-os/shared/ids";
import type { AppId, ChatId } from "@grasp-os/shared/ids";
import {
  streamIdleCancelMs,
  streamMaxRunning,
} from "@grasp-os/shared/operation-limits";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { openTestRun } from "./agent-chat.ts";
import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { chatsOf, chatWithDraft, outcome, requestFor } from "./previews.ts";
import { calledAs, failure } from "./sealed-apps.ts";
import { signedInApi } from "./sign-in.ts";

// Streaming actions (spec 10.7.6) in a chat's preview of its draft of an
// App of spec 8's layout (sealed-previews.ts, preview-stream-relay.ts),
// through the page's own connection, as a preview's screen follows one.
// These tests start from the ways it can fail (the threat model on
// GRA-663): the stream reaches the App's data or an outside system,
// outlives its preview or who may follow it, escapes its budgets, or a
// key's run is run again or handed to other input.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** The App's notes, and streaming actions that write them. */
const notesFiles = (marker: string): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(200) }),
});
`,
  "operations/notes.ts": `import { resource, v } from "@grasp-os/sdk";
import { action, mutation, query } from "#grasp/server";

// ${marker}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const writer = resource.model("writer", { maxOutputTokens: 100 });

export const create = mutation({
  args: { title: v.string().min(1).max(200) },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const titles = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => (await ctx.db.query("notes").take(100)).map((note) => note.title).sort(),
});

/** Three snapshots of a growing text, then the text, kept as a note. */
export const draft = action({
  args: { topic: v.string().min(1) },
  returns: v.object({ text: v.string() }),
  stream: v.object({ text: v.string() }),
  uses: [create],
  handler: async (ctx, args) => {
    let text = "";
    for (const word of ["Draft", "about", args.topic]) {
      text = text === "" ? word : text + " " + word;
      await ctx.emit({ text });
      await pause(50);
    }
    await ctx.runMutation(create, { title: text });
    return { text };
  },
});

/** Writes, then steps for a long while, then writes again. */
export const slow = action({
  args: { title: v.string().min(1) },
  returns: v.null(),
  stream: v.object({ step: v.number() }),
  uses: [create],
  handler: async (ctx, args) => {
    await ctx.runMutation(create, { title: args.title });
    for (let step = 1; step <= 300; step += 1) {
      await ctx.emit({ step });
      await pause(100);
    }
    await ctx.runMutation(create, { title: args.title + " (done)" });
    return null;
  },
});

/** A result larger than a receipt keeps. */
export const big = action({
  args: {},
  returns: v.string(),
  stream: v.object({ step: v.number() }),
  handler: async (ctx) => {
    await ctx.emit({ step: 1 });
    return "x".repeat(20000);
  },
});

/** Answers once: never a stream's, so streaming it runs nothing. */
export const once = action({
  args: {},
  returns: v.null(),
  handler: async () => null,
});

/** Asks the App's model: an outside system. */
export const consult = action({
  args: {},
  returns: v.string(),
  stream: v.object({ step: v.number() }),
  uses: [writer],
  handler: async (ctx) => {
    await ctx.emit({ step: 1 });
    return await ctx.resources.writer.generate({ prompt: "Hi" });
  },
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { big, consult, create, draft, once, slow, titles, writer } from "./operations/notes.ts";
import schema from "./schema.ts";

export default app({
  name: "Notes",
  schema,
  access: { tables: { notes: { read: "appMembers", write: "appMembers" } } },
  operations: { notes: { create, titles, draft, slow, consult, big, once } },
  internalOperations: {},
  screens: [],
  uses: [writer],
});
`,
});

/** A new App of `builder`'s, its notes released, sealed and current. */
const notesApp = async (builder: Person): Promise<AppId> => {
  const { id } = await builder.api.apps.create({ name: "Notes" });
  await release(builder, id, notesFiles("released"));
  return appIdSchema.parse(id);
};

/** The draft of a new App in a chat of its builder's. */
const setUp = async (builder?: Person) => {
  const owner = builder ?? (await signedInApi(idp, "builder"));
  const app = await notesApp(owner);
  const drafted = await chatWithDraft(owner, app, {
    "operations/notes.ts": notesFiles("drafted")["operations/notes.ts"] ?? "",
  });
  return { builder: owner, app, ...drafted };
};

const frameSchema = z.union([
  z.object({ type: z.literal("progress"), seq: z.int(), value: z.unknown() }),
  z.object({
    type: z.literal("result"),
    result: z.union([
      z.object({ ok: z.literal(true), value: z.unknown() }),
      z.object({
        ok: z.literal(false),
        error: z.object({ code: z.string(), details: z.unknown().optional() }),
      }),
    ]),
  }),
  z.object({
    type: z.literal("refused"),
    error: z.object({ code: z.string() }),
  }),
  z.object({ type: z.literal("closed") }),
]);
type Frame = z.infer<typeof frameSchema>;

/** How `frame` ended its stream, or undefined for progress. */
const endOf = (frame: Frame): string | undefined => {
  if (frame.type === "progress") {
    return undefined;
  }
  if (frame.type === "result") {
    return frame.result.ok ? "ok" : frame.result.error.code;
  }
  return frame.type === "refused" ? `refused:${frame.error.code}` : "closed";
};

/** Where one preview stream goes: its chat, App and revision. */
interface Seat {
  readonly chatId: ChatId;
  readonly app: AppId;
  readonly revision: number;
}

/** The streaming action `path`'s request with `input`, under `key`. */
const streamRequest = async (
  person: Person,
  seat: Seat,
  path: string,
  input: unknown,
  key: string
): Promise<string> => {
  const request: unknown = JSON.parse(
    await requestFor(person, seat, path, input)
  );
  return JSON.stringify({
    ...z.record(z.string(), z.unknown()).parse(request),
    idempotencyKey: key,
  });
};

/** Follows a preview stream as a preview's screen does: its frames, and its end. */
const follow = async (
  person: Person,
  { chatId, app, revision }: Seat,
  what: "stream" | "attach",
  request: string
) => {
  const frames: Frame[] = [];
  const ended = Promise.withResolvers<string>();
  const subscription = await person.api.chats.previewStream(
    chatId,
    app,
    revision,
    what,
    request,
    async (frame: unknown) => {
      const parsed = frameSchema.parse(frame);
      frames.push(parsed);
      const end = endOf(parsed);
      if (end !== undefined) {
        ended.resolve(end);
      }
      return await Promise.resolve(null);
    }
  );
  return { frames, ended: ended.promise, subscription };
};

/** What the chat's object answers `person`'s attach of `request` with, past core's checks. */
const attachedInObject = async (
  person: Person,
  { chatId, app, revision }: Seat,
  request: string
): Promise<string | undefined> => {
  const frames = await chatsOf(person).previewStream(
    chatId,
    person.userId,
    app,
    revision,
    request,
    true
  );
  const text = await new Response(frames).text();
  const lines = text.split("\n").filter((line) => line !== "");
  const last = lines.at(-1);
  return last === undefined
    ? undefined
    : endOf(frameSchema.parse(JSON.parse(last)));
};

/** The preview's notes at `seat`'s revision. */
const previewTitles = async (person: Person, seat: Seat): Promise<unknown> =>
  outcome(
    await person.api.chats.previewFunction(
      seat.chatId,
      seat.app,
      seat.revision,
      await requestFor(person, seat, "notes.titles")
    )
  );

/** Waits until a stream of `follow`'s has sent progress. */
const progressed = async (frames: readonly Frame[]): Promise<void> => {
  await vi.waitFor(
    () => {
      expect(frames.some(({ type }) => type === "progress")).toBeTruthy();
    },
    { timeout: 30_000, interval: 50 }
  );
};

describe(
  "a streaming action in a draft's preview",
  { timeout: 180_000 },
  () => {
    it("refuses a streaming action of someone no longer a member before any store is made for them", async () => {
      const { builder, app, chatId, revision } = await setUp();
      const seat = { chatId, app, revision };
      const request = await streamRequest(
        builder,
        seat,
        "notes.draft",
        { title: "after removal" },
        "removed"
      );
      // No longer an active member, as just after a removal while a
      // session is still cached: straight to the chat's object.
      await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
        .bind(builder.userId)
        .run();
      const frames = await chatsOf(builder).previewStream(
        chatId,
        builder.userId,
        app,
        revision,
        request,
        false
      );
      const text = await new Response(frames).text();
      const lines = text.split("\n").filter((line) => line !== "");
      const last = lines.at(-1);
      const stores = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM preview_fixture_stores WHERE person_id = ?"
      )
        .bind(builder.userId)
        .first<{ n: number }>();
      expect({
        ended:
          last === undefined
            ? undefined
            : endOf(frameSchema.parse(JSON.parse(last))),
        stores: stores?.n,
      }).toStrictEqual({
        ended: "permission.person_inactive",
        stores: 0,
      });
    });

    it("streams whole progress, then its result, on the draft release and the preview's store, changing none of the App's data", async () => {
      const { builder, app, chatId, revision } = await setUp();
      const seat = { chatId, app, revision };
      const followed = await follow(
        builder,
        seat,
        "stream",
        await streamRequest(
          builder,
          seat,
          "notes.draft",
          { topic: "tea" },
          crypto.randomUUID()
        )
      );
      const end = await followed.ended;
      const progress = followed.frames.flatMap((frame) =>
        frame.type === "progress" ? [frame.value] : []
      );
      const result = followed.frames.at(-1);
      expect({
        end,
        // Only the newest snapshots get through: each is whole.
        progress: progress.every(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "text" in value &&
            typeof value.text === "string" &&
            value.text.startsWith("Draft")
        ),
        last: progress.at(-1),
        result: result?.type === "result" ? result.result : undefined,
        preview: await previewTitles(builder, seat),
        app: await calledAs(
          { userId: builder.userId, role: "builder", teams: [] },
          app,
          { contractId: "notes.titles", kind: "query" }
        ),
      }).toStrictEqual({
        end: "ok",
        progress: true,
        last: { text: "Draft about tea" },
        result: { ok: true, value: { text: "Draft about tea" } },
        preview: ["Draft about tea"],
        app: { ok: true, value: [] },
      });
    });

    it("reaches no outside system: its resource requests are refused", async () => {
      const { builder, app, chatId, revision } = await setUp();
      const seat = { chatId, app, revision };
      const followed = await follow(
        builder,
        seat,
        "stream",
        await streamRequest(
          builder,
          seat,
          "notes.consult",
          {},
          crypto.randomUUID()
        )
      );
      await expect(followed.ended).resolves.toBe("resource.unavailable");
    });

    it("joins or reads again a key's run, never running it again, and refuses other input under it", async () => {
      const { builder, app, chatId, revision } = await setUp();
      const seat = { chatId, app, revision };
      const key = crypto.randomUUID();
      const request = await streamRequest(
        builder,
        seat,
        "notes.draft",
        { topic: "jam" },
        key
      );
      const first = await follow(builder, seat, "stream", request);
      // Joined while it runs, then read again once it ended.
      const joined = await follow(builder, seat, "stream", request);
      const firstEnd = await first.ended;
      const joinedEnd = await joined.ended;
      const attached = await follow(builder, seat, "attach", request);
      const other = await follow(
        builder,
        seat,
        "stream",
        await streamRequest(
          builder,
          seat,
          "notes.draft",
          { topic: "honey" },
          key
        )
      );
      // Another action under the same key, with the same input: never the
      // run under way.
      const otherAction = await follow(
        builder,
        seat,
        "attach",
        await streamRequest(builder, seat, "notes.slow", { topic: "jam" }, key)
      );
      // Input deeper than a value reads is refused, never taken for none.
      let deep: unknown = "bottom";
      for (let level = 0; level < 40; level += 1) {
        deep = { deeper: deep };
      }
      const tooDeep = await failure(
        async () =>
          await follow(
            builder,
            seat,
            "stream",
            await streamRequest(builder, seat, "notes.draft", deep, key)
          )
      );
      const unknown = await follow(
        builder,
        seat,
        "attach",
        await streamRequest(
          builder,
          seat,
          "notes.draft",
          { topic: "jam" },
          crypto.randomUUID()
        )
      );
      expect({
        ends: [firstEnd, joinedEnd, await attached.ended],
        other: await other.ended,
        tooDeep,
        otherAction: await otherAction.ended,
        unknown: await unknown.ended,
        // Run once, whoever followed it.
        preview: await previewTitles(builder, seat),
      }).toStrictEqual({
        ends: ["ok", "ok", "ok"],
        other: "submission.key_conflict",
        tooDeep: "contract.invalid_request",
        otherAction: "submission.expired",
        unknown: "submission.expired",
        preview: ["Draft about jam"],
      });
    });

    it("stops once cancelled, keeping what it committed and committing nothing more", async () => {
      const { builder, app, chatId, revision } = await setUp();
      const seat = { chatId, app, revision };
      const request = await streamRequest(
        builder,
        seat,
        "notes.slow",
        { title: "cut" },
        crypto.randomUUID()
      );
      const followed = await follow(builder, seat, "stream", request);
      await progressed(followed.frames);
      const cancelled = await builder.api.chats.previewCancelStream(
        chatId,
        app,
        revision,
        request
      );
      const end = await followed.ended;
      const again = await builder.api.chats.previewCancelStream(
        chatId,
        app,
        revision,
        request
      );
      expect({
        cancelled,
        end: ["operation.cancelled", "operation.outcome_unknown"].includes(end),
        again,
        preview: await previewTitles(builder, seat),
      }).toStrictEqual({
        cancelled: { requested: true },
        end: true,
        again: { requested: false },
        preview: ["cut"],
      });
    });

    it("ends once its draft changes, committing nothing more, and can't be read again", async () => {
      const { builder, app, chatId, revision, write } = await setUp();
      const seat = { chatId, app, revision };
      const request = await streamRequest(
        builder,
        seat,
        "notes.slow",
        { title: "old" },
        crypto.randomUUID()
      );
      const followed = await follow(builder, seat, "stream", request);
      await progressed(followed.frames);
      await write(
        {
          "operations/notes.ts":
            notesFiles("again")["operations/notes.ts"] ?? "",
        },
        revision
      );
      const end = await followed.ended;
      const reread = await failure(
        async () => await follow(builder, seat, "attach", request)
      );
      expect({ end, reread }).toStrictEqual({
        end: "refused:app.preview_outdated",
        reread: "app.preview_outdated",
      });
      // The invocation stopped: it reads its own revision's store no more,
      // and the store is gone with its preview.
      const ran = await attachedInObject(builder, seat, request).catch(
        (error: unknown) =>
          typeof error === "object" && error !== null && "code" in error
            ? error.code
            : String(error)
      );
      expect(ran).toBe("app.preview_outdated");
    });

    it("stops its run at once when its draft changes, rather than letting it run on", async () => {
      const { builder, app, chatId, revision, write } = await setUp();
      const seat = { chatId, app, revision };
      const request = await streamRequest(
        builder,
        seat,
        "notes.slow",
        { title: "dropped" },
        crypto.randomUUID()
      );
      // Read in the chat's object, past the relay: what the run itself did.
      const frames = await chatsOf(builder).previewStream(
        chatId,
        builder.userId,
        app,
        revision,
        request,
        false
      );
      const reader = frames.pipeThrough(new TextDecoderStream()).getReader();
      const first = await reader.read();
      await write(
        {
          "operations/notes.ts":
            notesFiles("again")["operations/notes.ts"] ?? "",
        },
        revision
      );
      const changedAt = Date.now();
      let rest = "";
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- until the result
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        rest += value;
      }
      const lines = rest.split("\n").filter((line) => line !== "");
      const last = lines.at(-1);
      const end =
        last === undefined
          ? undefined
          : endOf(frameSchema.parse(JSON.parse(last)));
      expect({
        started: first.value?.includes('"progress"'),
        stopped: ["operation.cancelled", "operation.outcome_unknown"].includes(
          end ?? ""
        ),
        // Far sooner than its 30 seconds of steps.
        soon: Date.now() - changedAt < 10_000,
      }).toStrictEqual({ started: true, stopped: true, soon: true });
    });

    it("is relayed only while its person builds the App, and is cancelled once they don't", async () => {
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
        "operations/notes.ts":
          notesFiles("drafted")["operations/notes.ts"] ?? "",
      });
      const seat = { chatId, app, revision };
      const request = await streamRequest(
        other,
        seat,
        "notes.slow",
        { title: "theirs" },
        crypto.randomUUID()
      );
      const theirs = await failure(
        async () => await follow(stranger, seat, "stream", request)
      );
      const followed = await follow(other, seat, "stream", request);
      await progressed(followed.frames);
      // No longer a builder: the relay refuses what follows, and the run is
      // cancelled at once.
      await owner.api.apps.members.add(app, {
        type: "person",
        id: other.userId,
        role: "user",
      });
      const end = await followed.ended;
      // Read past core's checks, in the chat's object: the run was stopped.
      const stopped = await vi.waitFor(
        async () => {
          const read = await attachedInObject(other, seat, request);
          expect(read).toBeDefined();
          return read;
        },
        { timeout: 30_000, interval: 200 }
      );
      expect({
        theirs,
        end,
        stopped: ["operation.cancelled", "operation.outcome_unknown"].includes(
          stopped ?? ""
        ),
      }).toStrictEqual({
        theirs: "agent.chat_not_found",
        end: "refused:role.forbidden",
        stopped: true,
      });
    });

    it("runs no more than its share at once, and cancels a run nobody follows", async () => {
      const { builder, app, chatId, revision } = await setUp();
      const seat = { chatId, app, revision };
      const requests = await Promise.all(
        Array.from(
          { length: streamMaxRunning + 1 },
          async (_unused, index) =>
            await streamRequest(
              builder,
              seat,
              "notes.slow",
              { title: `run ${String(index)}` },
              crypto.randomUUID()
            )
        )
      );
      const running = [];
      for (const request of requests.slice(0, streamMaxRunning)) {
        // oxlint-disable-next-line no-await-in-loop -- one start after the other
        running.push(await follow(builder, seat, "stream", request));
      }
      const past = await follow(builder, seat, "stream", requests.at(-1) ?? "");
      const pastEnd = await past.ended;
      // Each let go of: nobody follows them, so each is cancelled once its
      // idle time is over.
      for (const followed of running) {
        // oxlint-disable-next-line no-await-in-loop -- one after the other
        await followed.subscription.release();
      }
      await scheduler.wait(streamIdleCancelMs + 3000);
      const unfollowed = await attachedInObject(
        builder,
        seat,
        requests[0] ?? ""
      );
      expect({
        pastEnd,
        unfollowed: [
          "operation.cancelled",
          "operation.outcome_unknown",
        ].includes(unfollowed ?? ""),
      }).toStrictEqual({ pastEnd: "operation.stream_limit", unfollowed: true });
    });

    it("keeps a few small receipts of all its previews, and none of a large result", async () => {
      const { builder, app, chatId, revision } = await setUp();
      const seat = { chatId, app, revision };
      const keys = Array.from({ length: 9 }, () => crypto.randomUUID());
      const requests = await Promise.all(
        keys.map(
          async (key, index) =>
            await streamRequest(
              builder,
              seat,
              "notes.draft",
              { topic: `t${String(index)}` },
              key
            )
        )
      );
      for (const request of requests) {
        // oxlint-disable-next-line no-await-in-loop -- one run after the other
        const followed = await follow(builder, seat, "stream", request);
        // oxlint-disable-next-line no-await-in-loop -- see above
        await followed.ended;
        // Let go of, as a page lets go of a stream that ended.
        // oxlint-disable-next-line no-await-in-loop -- see above
        await followed.subscription.release();
      }
      const bigRequest = await streamRequest(
        builder,
        seat,
        "notes.big",
        {},
        crypto.randomUUID()
      );
      const large = await follow(builder, seat, "stream", bigRequest);
      const largeEnd = await large.ended;
      await large.subscription.release();
      const reread = async (request: string): Promise<string> => {
        const followed = await follow(builder, seat, "attach", request);
        const end = await followed.ended;
        await followed.subscription.release();
        return end;
      };
      expect({
        largeEnd,
        large: await reread(bigRequest),
        oldest: await reread(requests[0] ?? ""),
        newest: await reread(requests.at(-1) ?? ""),
      }).toStrictEqual({
        largeEnd: "ok",
        // Answered once, never kept.
        large: "submission.expired",
        // Past the receipts the object keeps.
        oldest: "submission.expired",
        newest: "ok",
      });
    });

    it("keeps no receipt of a run that ran nothing of the App's, so its key may run again", async () => {
      const { builder, app, chatId, revision } = await setUp();
      const seat = { chatId, app, revision };
      // An action that answers once, streamed: refused before it runs.
      const request = await streamRequest(
        builder,
        seat,
        "notes.once",
        {},
        crypto.randomUUID()
      );
      const first = await follow(builder, seat, "stream", request);
      const firstEnd = await first.ended;
      await first.subscription.release();
      expect({
        firstEnd,
        attached: await attachedInObject(builder, seat, request),
      }).toStrictEqual({
        firstEnd: "operation.mode_mismatch",
        attached: "submission.expired",
      });
    });

    it("refuses a stream whose draft is saved while it opens, never bringing back the preview it read", async () => {
      const { builder, app, chatId, revision } = await setUp();
      const seat = { chatId, app, revision };
      const request = await streamRequest(
        builder,
        seat,
        "notes.draft",
        { topic: "stale" },
        crypto.randomUUID()
      );
      const runId = await openTestRun(chatsOf(builder), chatId);
      const changed =
        notesFiles("saved meanwhile")["operations/notes.ts"] ?? "";
      const opened = await runInDurableObject(
        chatsOf(builder),
        async (instance) => {
          // Opened at the draft's revision, then, before it is decided,
          // the draft is saved: the agent's write lands in between.
          const opening = instance.previewStream(
            chatId,
            builder.userId,
            app,
            revision,
            request,
            false
          );
          instance.saveDraft(
            chatId,
            app,
            1,
            { "operations/notes.ts": changed },
            [],
            revision,
            runId
          );
          try {
            await opening;
            return "opened";
          } catch (error) {
            return typeof error === "object" &&
              error !== null &&
              "code" in error
              ? error.code
              : "failed";
          }
        }
      );
      const next = { ...seat, revision: revision + 1 };
      const fresh = await follow(
        builder,
        next,
        "stream",
        await streamRequest(
          builder,
          next,
          "notes.draft",
          { topic: "fresh" },
          crypto.randomUUID()
        )
      );
      expect({ opened, fresh: await fresh.ended }).toStrictEqual({
        opened: "app.preview_outdated",
        fresh: "ok",
      });
    });

    it("keeps no receipt of a dropped preview's runs, which would push out a current one's", async () => {
      const { builder, app, chatId, revision } = await setUp();
      const kept = { chatId, app, revision };
      const other = await chatWithDraft(builder, app, {
        "operations/notes.ts": notesFiles("other")["operations/notes.ts"] ?? "",
      });
      const dropped = { chatId: other.chatId, app, revision: other.revision };
      // Five receipts of one chat's preview.
      const requests: string[] = [];
      for (let at = 0; at < 5; at += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one run after the other
        const request = await streamRequest(
          builder,
          kept,
          "notes.draft",
          { topic: `kept ${String(at)}` },
          crypto.randomUUID()
        );
        requests.push(request);
        // oxlint-disable-next-line no-await-in-loop -- see above
        const followed = await follow(builder, kept, "stream", request);
        // oxlint-disable-next-line no-await-in-loop -- see above
        await followed.ended;
        // oxlint-disable-next-line no-await-in-loop -- see above
        await followed.subscription.release();
      }
      // The other chat's preview runs as many as the object runs at once,
      // then its draft changes under them.
      const running = [];
      for (let at = 0; at < streamMaxRunning; at += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one start after the other
        const request = await streamRequest(
          builder,
          dropped,
          "notes.slow",
          { title: `dropped ${String(at)}` },
          crypto.randomUUID()
        );
        // oxlint-disable-next-line no-await-in-loop -- see above
        running.push(await follow(builder, dropped, "stream", request));
      }
      await other.write(
        {
          "operations/notes.ts":
            notesFiles("changed")["operations/notes.ts"] ?? "",
        },
        other.revision
      );
      for (const followed of running) {
        // oxlint-disable-next-line no-await-in-loop -- each ends
        await followed.ended;
        // oxlint-disable-next-line no-await-in-loop -- see above
        await followed.subscription.release();
      }
      // Their runs settle once stopped, keeping nothing.
      await scheduler.wait(2000);
      const reread = await follow(builder, kept, "attach", requests[0] ?? "");
      await expect(reread.ended).resolves.toBe("ok");
    });

    it("reads again only what runs: an attach or a cancel of a preview not running seals nothing", async () => {
      const { builder, app, chatId, revision } = await setUp();
      const seat = { chatId, app, revision };
      const request = JSON.stringify({
        reference: {
          resourceId: app,
          resourceVersion: 2,
          contractId: "notes.draft",
          fingerprint: "0".repeat(64),
          kind: "action",
        },
        input: { topic: "none" },
        idempotencyKey: crypto.randomUUID(),
      });
      const attached = await follow(builder, seat, "attach", request);
      const cancelled = await builder.api.chats.previewCancelStream(
        chatId,
        app,
        revision,
        request
      );
      const sealed = await runInDurableObject(
        chatsOf(builder),
        (_instance, state) =>
          state.storage.sql
            .exec(
              "SELECT revision FROM preview_releases WHERE chat_id = ?",
              chatId
            )
            .toArray().length
      );
      expect({
        attached: await attached.ended,
        cancelled,
        sealed,
      }).toStrictEqual({
        attached: "submission.expired",
        cancelled: { requested: false },
        sealed: 0,
      });
    });

    it("holds the connection's watches to their limit, however many start at once", async () => {
      const { builder, app, chatId, revision } = await setUp();
      const seat = { chatId, app, revision };
      const request = await streamRequest(
        builder,
        seat,
        "notes.draft",
        { topic: "crowd" },
        crypto.randomUUID()
      );
      const started = await Promise.allSettled(
        Array.from(
          { length: 14 },
          async () => await follow(builder, seat, "attach", request)
        )
      );
      const refused = started.flatMap((settled): unknown[] => {
        const reason: unknown =
          settled.status === "rejected" ? settled.reason : undefined;
        return typeof reason === "object" && reason !== null && "code" in reason
          ? [reason.code]
          : [];
      });
      expect({
        held: started.filter(({ status }) => status === "fulfilled").length,
        refused: refused.includes("agent.too_many_watches"),
      }).toStrictEqual({ held: 10, refused: true });
    });
  }
);
