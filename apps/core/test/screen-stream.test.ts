import type { OperationReference, ReferenceKind } from "@grasp-os/sdk";
import { GraspError } from "@grasp-os/sdk/client";
import { GraspClient } from "@grasp-os/sdk/host";
import type { ClientTransport, StreamLink } from "@grasp-os/sdk/host";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { actionMaxRunning } from "@grasp-os/shared/operation-limits";
import type { Role } from "@grasp-os/shared/roles";
import {
  appFunctionPath,
  screenLeaseHeader,
  screenPersonHeader,
} from "@grasp-os/shared/screens";
import {
  abortAllDurableObjects,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { accessOf, invocationName } from "../src/action-invocation.ts";
import { invokeAppAction } from "../src/app-functions.ts";
import type { FunctionRequest } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { revokeRelease } from "../src/release-retention.ts";
import { published as publishedApp } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { referenceTo } from "./notes-client-app.ts";
import { person } from "./sealed-apps.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { callAuth, routed, signedInApi } from "./sign-in.ts";

// Foreground streaming actions (spec 10.7.6), through core's real routes
// and the invocation's own Durable Object, as a screen's page
// relays them: progress then the validated result; a lost connection
// attached to the same invocation, never run again; a cancelled stream
// that keeps what it committed and commits nothing more; a stream no one
// follows cancelled; another person, a reused key and a revoked build
// refused; progress its schema refuses failing the action; a reference of
// the wrong mode refused both ways.

const idp = mockIdp();

const files: Record<string, string> = {
  "server/schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  notes: defineTable({ title: v.string().min(1).max(500) }).index("by_updated", ["_updatedAt"]).access({ read: "owner", write: "owner" }),
});
`,
  "server/notes.ts": `import { paginationOptionsValidator, paginationResultValidator, v } from "@grasp-os/sdk";
import { action, doc, mutation, query } from "@server/_generated/server";

export const pause = async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms));

export const list = query({
  args: { pagination: paginationOptionsValidator },
  returns: paginationResultValidator(doc("notes")),
  handler: async (ctx, args) =>
    await ctx.db.query("notes").withIndex("by_updated").order("desc").paginate(args.pagination),
});

export const create = mutation({
  args: { title: v.string() },
  returns: v.id("notes"),
  handler: async (ctx, args) => await ctx.db.insert("notes", args),
});

export const echo = action({
  args: { word: v.string().default("hello") },
  returns: v.string(),
  handler: async (_ctx, args) => args.word,
});

export const waits = action({
  args: { pauseMs: v.number().integer().min(0) },
  returns: v.null(),
  handler: async (_ctx, args) => {
    await pause(args.pauseMs);
    return null;
  },
});
`,
  "server/writer.ts": `import { v } from "@grasp-os/sdk";
import { action } from "@server/_generated/server";

import { create, list, pause } from "./notes.ts";

export const draft = action({
  args: { topic: v.string().min(1), pauseMs: v.number().integer().min(0).default(50) },
  returns: v.object({ text: v.string() }),
  stream: v.object({ text: v.string() }),
  uses: [create],
  handler: async (ctx, args) => {
    let text = "";
    for (const word of ["Draft", "about", args.topic]) {
      text = text === "" ? word : text + " " + word;
      await ctx.emit({ text });
      await pause(args.pauseMs);
    }
    await ctx.runMutation(create, { title: text });
    return { text };
  },
});

export const slow = action({
  args: { title: v.string() },
  returns: v.null(),
  stream: v.object({ step: v.number() }),
  uses: [create],
  handler: async (ctx, args) => {
    await ctx.runMutation(create, { title: args.title });
    for (let step = 1; step <= 400; step += 1) {
      await ctx.emit({ step });
      await pause(100);
    }
    await ctx.runMutation(create, { title: args.title + " (done)" });
    return null;
  },
});

export const quiet = action({
  args: { title: v.string(), pauseMs: v.number().integer().min(0) },
  returns: v.null(),
  stream: v.object({ step: v.number() }),
  uses: [create],
  handler: async (ctx, args) => {
    await ctx.emit({ step: 0 });
    await pause(args.pauseMs);
    await ctx.runMutation(create, { title: args.title });
    return null;
  },
});

export const counts = action({
  args: {},
  returns: v.number(),
  stream: v.object({ step: v.number() }),
  uses: [list, create],
  handler: async (ctx) => {
    const before = (await ctx.runQuery(list, { pagination: { pageSize: 50 } })).items.length;
    await ctx.emit({ step: before });
    await ctx.runMutation(create, { title: "Counted" });
    return before;
  },
});

export const wrong = action({
  args: {},
  returns: v.null(),
  stream: v.object({ text: v.string() }),
  handler: async (ctx) => {
    await ctx.emit({ text: 5 } as never);
    return null;
  },
});

export const huge = action({
  args: {},
  returns: v.string(),
  stream: v.object({ text: v.string() }),
  handler: async (ctx) => {
    try {
      await ctx.emit({ text: "x".repeat(300_000) });
    } catch (error) {
      return (error as { code: string }).code;
    }
    return "sent";
  },
});
`,
  "grasp.config.ts": `import { defineApp } from "@grasp-os/sdk";

export default defineApp({
  name: "Writer",
});
`,
  "screens/writer.tsx": `import { useStream } from "@grasp-os/sdk/react";
import { api } from "@server/_generated/api";

export default function Writer() {
  const draft = useStream(api.writer.draft);
  return <p>{draft.status === "completed" ? draft.output.text : draft.status}</p>;
}
`,
};

/** The operation at `path` of `release`. */
const operationAt = (release: Release, path: string) => {
  const operation = release.app.operations[path];
  if (operation === undefined) {
    throw new Error(`The release has no ${path}`);
  }
  return operation;
};

/**
 * A reference to a function of `release` that answers once, as the App's
 * `@server/_generated/api` has it.
 */
const singleTo = <Args, Return, Kind extends ReferenceKind>(
  release: Release,
  path: string,
  _kind: Kind
): OperationReference<Args, Return, Kind> =>
  referenceTo<Args, Return, Kind>(release, path);

/** A reference to a streaming action of `release`. */
const streamTo = <Args, Return, Progress>(
  release: Release,
  path: string
): OperationReference<Args, Return, "action", "public", Progress> => {
  if (operationAt(release, path).stream === null) {
    throw new Error(`${path} doesn't stream`);
  }
  return referenceTo<Args, Return, "action", Progress>(release, path);
};

/** The App's `api`, typed as its screens get it. */
const apiOf = (release: Release) => ({
  list: singleTo<
    { pagination: { pageSize?: number } },
    { items: { title: string }[] },
    "query"
  >(release, "notes.list", "query"),
  waits: singleTo<{ pauseMs: number }, null, "action">(
    release,
    "notes.waits",
    "action"
  ),
  echo: singleTo<{ word?: string }, string, "action">(
    release,
    "notes.echo",
    "action"
  ),
  draft: streamTo<
    { topic: string; pauseMs?: number },
    { text: string },
    { text: string }
  >(release, "writer.draft"),
  slow: streamTo<{ title: string }, null, { step: number }>(
    release,
    "writer.slow"
  ),
  counts: streamTo<Record<never, never>, number, { step: number }>(
    release,
    "writer.counts"
  ),
  quiet: streamTo<{ title: string; pauseMs: number }, null, { step: number }>(
    release,
    "writer.quiet"
  ),
  wrong: streamTo<Record<never, never>, null, { text: string }>(
    release,
    "writer.wrong"
  ),
  huge: streamTo<Record<never, never>, string, { text: string }>(
    release,
    "writer.huge"
  ),
});

/** A progress callback that only takes snapshots in. */
const ignoreProgress = (progress: unknown): void => {
  void progress;
};

const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

/**
 * A builder's Writer App, current, its screen
 * opened by both: `builder` and `admin` when given, new people otherwise.
 */
const openedApp = async (people: { builder?: Person; admin?: Person } = {}) => {
  const builder = people.builder ?? (await personApi("builder"));
  const admin = people.admin ?? (await personApi("admin"));
  const { id } = await builder.api.apps.create({ name: "Writer" });
  await publishedApp(id);
  const { version } = await builder.api.apps.files.commit(id, files, "First");
  await builder.api.apps.versions.setCurrent(id, version);
  const { lease } = await builder.api.screens.open(id, "writer");
  const { lease: adminLease } = await admin.api.screens.open(id, "writer");
  const release = await loadRelease(env, id, version);
  return {
    app: id,
    release,
    admin,
    builderApi: builder,
    builderId: builder.userId,
    builder: { lease, cookie: builder.session, person: builder.userId },
    other: { lease: adminLease, cookie: admin.session, person: admin.userId },
  };
};

type Opened = Awaited<ReturnType<typeof openedApp>>;

interface Seat {
  readonly lease: string;
  readonly cookie: string;
  /** Who the frame is for, as the page names them (`screenPersonHeader`). */
  readonly person: string;
}

const post = async (
  app: string,
  seat: Seat,
  suffix: string,
  request: string
): Promise<Response> =>
  await routed(`${appFunctionPath}/${app}${suffix}`, {
    method: "POST",
    headers: {
      origin: clientOrigin,
      "content-type": "application/json",
      cookie: seat.cookie,
      [screenLeaseHeader]: seat.lease,
      [screenPersonHeader]: seat.person,
    },
    body: request,
  });

/** A refusal before any call ran, as the page throws it. */
const refusal = async (response: Response): Promise<Error> => {
  const payload = errorPayloadSchema.parse(await response.json());
  return Object.assign(new Error(payload.message), { code: payload.code });
};

/**
 * What the page does for a screen (apps/web's screen-host.ts and
 * screen-stream.ts): calls through core's routes, frames read as lines
 * and handed on, `{ type: "closed" }` once the connection ends without a
 * result. `cut()` drops the connection after the next progress frame.
 */
const pageTransport = (app: string, seat: Seat) => {
  let cutting = false;
  let refusingAttaches = 0;
  const opened: string[] = [];
  const transport: ClientTransport = {
    // Live queries are screen-client-live.test.ts's: these only call and stream.
    watch: async () => {
      await Promise.resolve();
      throw new Error("Nothing here follows a query.");
    },
    call: async (request) => {
      const response = await post(app, seat, "", request);
      if (!response.ok) {
        throw await refusal(response);
      }
      return await response.json();
    },
    stream: async (what, request, onFrame): Promise<StreamLink> => {
      opened.push(what);
      if (what === "attach" && refusingAttaches > 0) {
        refusingAttaches -= 1;
        // As the page refuses past the person's request budget.
        throw Object.assign(new Error("Too many requests."), {
          code: "screen.rate_limited",
          details: { retryAfterMs: 50 },
        });
      }
      const response = await post(app, seat, `/${what}`, request);
      if (!response.ok || response.body === null) {
        throw await refusal(response);
      }
      // SAFETY: a response's body in workerd is a byte stream.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const body = response.body as ReadableStream<Uint8Array>;
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let released = false;
      const relay = async (): Promise<void> => {
        let buffered = "";
        let ended = false;
        try {
          for (;;) {
            // oxlint-disable-next-line no-await-in-loop -- one chunk after another
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            buffered += decoder.decode(value, { stream: true });
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";
            for (const line of lines) {
              const frame = z
                .object({ type: z.string() })
                .loose()
                .parse(JSON.parse(line));
              onFrame(frame);
              ended ||= frame.type === "result" || frame.type === "refused";
              if (frame.type === "progress" && cutting) {
                cutting = false;
                // oxlint-disable-next-line no-await-in-loop -- once, then it returns
                await reader.cancel();
                onFrame({ type: "closed" });
                return;
              }
            }
          }
        } catch {
          // The connection broke.
        }
        if (!(ended || released)) {
          onFrame({ type: "closed" });
        }
      };
      void relay();
      return {
        release: async () => {
          released = true;
          await reader.cancel().catch(() => null);
        },
      };
    },
    cancelStream: async (request) => {
      const response = await post(app, seat, "/cancel", request);
      if (!response.ok) {
        throw await refusal(response);
      }
      return await response.json();
    },
  };
  return {
    transport,
    cut: () => {
      cutting = true;
    },
    /** Refuses the next `count` reconnects for the request budget. */
    refuseAttaches: (count: number) => {
      refusingAttaches = count;
    },
    opened,
  };
};

const clientFor = (opened: Opened, seat: Seat = opened.builder) => {
  const page = pageTransport(opened.app, seat);
  return { client: new GraspClient(page.transport), page };
};

/** Why `promise` rejected: the structured error's code, category and details. */
const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof GraspError)) {
      throw error;
    }
    const { code, category, details } = error;
    return { code, category, details };
  }
  throw new Error("It resolved");
};

/** The titles of the notes the App holds, read through `release`'s `list`. */
const titles = async (
  client: GraspClient,
  opened: Opened,
  release: Release = opened.release
) => {
  const page = await client.query(apiOf(release).list, {
    pagination: { pageSize: 50 },
  });
  return page.items.map(({ title }) => title).toSorted();
};

/** Resolves once `test` holds, polling. */
const until = async (test: () => boolean): Promise<void> => {
  await vi.waitFor(
    () => {
      expect(test()).toBeTruthy();
    },
    { timeout: 10_000, interval: 50 }
  );
};

describe("a streaming action", { timeout: 120_000 }, () => {
  it("streams whole progress snapshots, then resolves its validated result", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const seen: { text: string }[] = [];
    const result = await client.stream(
      api.draft,
      { topic: "launch" },
      {
        onProgress: (progress) => {
          seen.push(progress);
        },
      }
    );
    // Snapshots, never deltas: the newest last, each frozen.
    expect({
      result,
      last: seen.at(-1),
      frozen: seen.every((progress) => Object.isFrozen(progress)),
      notes: await titles(client, opened),
    }).toStrictEqual({
      result: { text: "Draft about launch" },
      last: { text: "Draft about launch" },
      frozen: true,
      notes: ["Draft about launch"],
    });
  });

  it("goes on when its progress callback throws", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    let calls = 0;
    await expect(
      client.stream(
        api.draft,
        { topic: "again" },
        {
          onProgress: () => {
            calls += 1;
            throw new Error("The screen's bug");
          },
        }
      )
    ).resolves.toStrictEqual({ text: "Draft about again" });
    expect(calls).toBe(1);
  });

  it("attaches to the same invocation after a lost connection, running it once", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, page } = clientFor(opened);
    page.cut();
    const result = await client.stream(
      api.draft,
      { topic: "once", pauseMs: 400 },
      { onProgress: ignoreProgress }
    );
    // Started once, then only ever attached to; its effect made once.
    expect({
      result,
      opened: [...new Set(page.opened)],
      notes: await titles(client, opened),
    }).toStrictEqual({
      result: { text: "Draft about once" },
      opened: ["stream", "attach"],
      notes: ["Draft about once"],
    });
  });

  it("answers a finished invocation's receipt to the same key, without running it again", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = {
      idempotencyKey: "draft-receipt",
      onProgress: ignoreProgress,
    };
    const first = await client.stream(
      api.draft,
      { topic: "kept", pauseMs: 0 },
      keyed
    );
    const again = await client.stream(
      api.draft,
      { topic: "kept", pauseMs: 0 },
      keyed
    );
    expect({ first, again, notes: await titles(client, opened) }).toStrictEqual(
      {
        first: { text: "Draft about kept" },
        again: { text: "Draft about kept" },
        notes: ["Draft about kept"],
      }
    );
  });

  it("refuses a key reused with other input, and another person's attach", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = { idempotencyKey: "mine", onProgress: ignoreProgress };
    await client.stream(api.draft, { topic: "a", pauseMs: 0 }, keyed);
    await expect(
      failureOf(client.stream(api.draft, { topic: "b", pauseMs: 0 }, keyed))
    ).resolves.toMatchObject({ code: "submission.key_conflict" });
    // The same reference, key and input, from another person's screen:
    // no invocation of theirs has it.
    const request = JSON.stringify({
      reference: { name: api.draft.name, kind: "action" },
      input: { topic: "a", pauseMs: 0 },
      idempotencyKey: "mine",
    });
    const attached = await post(opened.app, opened.other, "/attach", request);
    expect(attached.ok).toBeTruthy();
    await expect(attached.text()).resolves.toContain(
      '"code":"submission.expired"'
    );
    const cancelled = await post(opened.app, opened.other, "/cancel", request);
    await expect(cancelled.json()).resolves.toStrictEqual({
      requested: false,
    });
  });

  it("stops at an explicit cancel, keeping what it committed and committing nothing more", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, page } = clientFor(opened);
    let steps = 0;
    const keyed = {
      idempotencyKey: "cancel-me",
      onProgress: () => {
        steps += 1;
      },
    };
    const running = client.stream(api.slow, { title: "Started" }, keyed);
    await until(() => steps >= 2);
    const request = JSON.stringify({
      reference: { name: api.slow.name, kind: "action" },
      input: { title: "Started" },
      idempotencyKey: "cancel-me",
    });
    await expect(page.transport.cancelStream?.(request)).resolves.toStrictEqual(
      { requested: true }
    );
    await expect(failureOf(running)).resolves.toMatchObject({
      code: "operation.cancelled",
      category: "operational",
    });
    await expect(titles(client, opened)).resolves.toStrictEqual(["Started"]);
    // Its receipt answers the same key again: cancelled, not run anew.
    await expect(
      failureOf(client.stream(api.slow, { title: "Started" }, keyed))
    ).resolves.toMatchObject({ code: "operation.cancelled" });
    await expect(titles(client, opened)).resolves.toStrictEqual(["Started"]);
  });

  it("is cancelled once no screen follows it", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    let steps = 0;
    const controller = new AbortController();
    const keyed = {
      idempotencyKey: "left-alone",
      onProgress: () => {
        steps += 1;
      },
    };
    const running = client.stream(
      api.slow,
      { title: "Alone" },
      { ...keyed, signal: controller.signal }
    );
    await until(() => steps >= 1);
    controller.abort();
    await expect(failureOf(running)).resolves.toMatchObject({
      code: "stream.cancelled",
    });
    // Past the wait for a reconnect (`streamIdleCancelMs`), the host
    // cancels it, saying why; attaching again answers that, and runs
    // nothing.
    await scheduler.wait(11_000);
    await expect(
      failureOf(client.stream(api.slow, { title: "Alone" }, keyed))
    ).resolves.toMatchObject({
      code: "operation.cancelled",
      details: { reason: "unfollowed" },
    });
    await expect(titles(client, opened)).resolves.toStrictEqual(["Alone"]);
  });

  it("fails on progress its schema refuses, and refuses oversized progress to the handler", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    await expect(
      failureOf(client.stream(api.wrong, {}, { onProgress: ignoreProgress }))
    ).resolves.toMatchObject({ code: "contract.invalid_progress" });
    await expect(
      client.stream(api.huge, {}, { onProgress: ignoreProgress })
    ).resolves.toBe("contract.progress_too_large");
  });

  it("refuses a reference of the wrong mode, by its type and in core", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    // A reference is a name: core, which knows the function, refuses it.
    await expect(
      // @ts-expect-error -- a streaming action isn't a single answer's
      failureOf(client.action(api.draft, { topic: "x" }))
    ).resolves.toMatchObject({ code: "operation.mode_mismatch" });
    await expect(
      // @ts-expect-error -- an action that answers once doesn't stream
      failureOf(client.stream(api.echo, {}, { onProgress: ignoreProgress }))
    ).resolves.toMatchObject({ code: "operation.mode_mismatch" });
    const reference = { name: api.draft.name, kind: "action" };
    const single = await post(
      opened.app,
      opened.builder,
      "",
      JSON.stringify({ reference, input: { topic: "x" } })
    );
    await expect(single.json()).resolves.toMatchObject({
      result: { ok: false, error: { code: "operation.mode_mismatch" } },
    });
    const echo = { ...reference, name: api.echo.name };
    const streamed = await post(
      opened.app,
      opened.builder,
      "/stream",
      JSON.stringify({ reference: echo, input: {}, idempotencyKey: "k" })
    );
    await expect(streamed.text()).resolves.toContain(
      '"code":"operation.mode_mismatch"'
    );
  });

  it("refuses a stream sent with a paginated list's window, before it runs", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const key = crypto.randomUUID();
    const reference = { name: api.counts.name, kind: "action" };
    const windowed = await post(
      opened.app,
      opened.builder,
      "/stream",
      JSON.stringify({
        reference,
        input: {},
        idempotencyKey: key,
        window: { extent: 10 },
      })
    );
    // Nothing started under the key: attaching to it finds no invocation.
    const attached = await post(
      opened.app,
      opened.builder,
      "/attach",
      JSON.stringify({ reference, input: {}, idempotencyKey: key })
    );
    const [windowedText, attachedText] = [
      await windowed.text(),
      await attached.text(),
    ];
    expect({
      refused: windowedText.includes('"code":"contract.invalid_request"'),
      ran: [windowedText, attachedText].some((text) =>
        text.includes('"ok":true')
      ),
    }).toStrictEqual({ refused: true, ran: false });
  });
});

/** The request of a call of `reference` with `input` under `key`, as the client sends it. */
const requestFor = (
  reference: { name: string },
  input: Json,
  key: string
): FunctionRequest => ({
  reference: { name: reference.name, kind: "action" },
  input,
  idempotencyKey: key,
});

/** What the invocation of `call` keeps in its object's storage, as text. */
const storedOf = async (
  opened: Opened,
  call: FunctionRequest,
  key: string
): Promise<string> => {
  const name = await invocationName(
    opened.builderId,
    opened.app,
    call,
    key,
    true
  );
  return await runInDurableObject(
    env.ACTION_INVOCATIONS.getByName(name),
    (_instance, state) => JSON.stringify([...state.storage.kv.list()])
  );
};

/** The code of the result `call`'s invocation settled with, once it has. */
const settledCodeOf = async (
  opened: Opened,
  call: FunctionRequest,
  key: string
): Promise<string> => {
  let code = "";
  await vi.waitFor(
    async () => {
      const stored = z
        .array(
          z.tuple([
            z.string(),
            z
              .object({
                state: z.literal("settled"),
                result: z.union([
                  z.object({ ok: z.literal(true) }).loose(),
                  z.object({
                    ok: z.literal(false),
                    error: z.object({ code: z.string() }).loose(),
                  }),
                ]),
              })
              .loose(),
          ])
        )
        .parse(JSON.parse(await storedOf(opened, call, key)));
      const [, record] = stored[0] ?? [];
      code =
        record === undefined || record.result.ok
          ? "ok"
          : record.result.error.code;
    },
    { timeout: 2000, interval: 100 }
  );
  return code;
};

describe("a streaming action's bounds and access", { timeout: 120_000 }, () => {
  it("runs at most four streams at once for a person in one App", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, page } = clientFor(opened);
    const steps = [0, 0, 0, 0];
    const slots = steps.map((_, slot) => ({
      input: { title: `Slot ${slot}` },
      key: `slot-${slot}`,
    }));
    const running = slots.map(async ({ input, key }, slot) => {
      try {
        return await client.stream(api.slow, input, {
          idempotencyKey: key,
          onProgress: () => {
            steps[slot] = (steps[slot] ?? 0) + 1;
          },
        });
      } catch (error) {
        return error instanceof GraspError ? error.code : "thrown";
      }
    });
    await until(() => steps.every((count) => count >= 1));
    const fifth = await failureOf(
      client.stream(
        api.draft,
        { topic: "fifth", pauseMs: 0 },
        { onProgress: ignoreProgress }
      )
    );
    for (const { input, key } of slots) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await page.transport.cancelStream?.(
        JSON.stringify(requestFor(api.slow, input, key))
      );
    }
    const ended = await Promise.all(running);
    // Its places come back as its streams end.
    const after = await client.stream(
      api.draft,
      { topic: "after", pauseMs: 0 },
      { onProgress: ignoreProgress }
    );
    expect({ fifth: fifth.code, ended, after }).toStrictEqual({
      fifth: "operation.stream_limit",
      ended: steps.map(() => "operation.cancelled"),
      after: { text: "Draft about after" },
    });
  });

  it("keeps a hash of the input and the result alone, never the input or its progress", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client, page } = clientFor(opened);
    const input = { title: "Salary review for Ada" };
    const call = requestFor(api.slow, input, "kept-small");
    let steps = 0;
    const running = failureOf(
      client.stream(api.slow, input, {
        idempotencyKey: "kept-small",
        onProgress: () => {
          steps += 1;
        },
      })
    );
    await until(() => steps >= 1);
    await page.transport.cancelStream?.(JSON.stringify(call));
    await running;
    const stored = await storedOf(opened, call, "kept-small");
    expect({
      input: stored.includes("Salary review"),
      progress: stored.includes('"step"'),
      settled: stored.includes('"settled"'),
    }).toStrictEqual({ input: false, progress: false, settled: true });
  });

  it("cancels a stream that emits nothing at once when its person signs out", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const input = { title: "Late", pauseMs: 9000 };
    let steps = 0;
    const running = failureOf(
      client.stream(api.quiet, input, {
        idempotencyKey: "signed-out",
        onProgress: () => {
          steps += 1;
        },
      })
    );
    await until(() => steps >= 1);
    await callAuth("/sign-out", opened.builder.cookie, {});
    const failed = await running;
    // Cancelled when the relay saw it, well before it would have ended.
    expect({
      failed: failed.code,
      settled: await settledCodeOf(
        opened,
        requestFor(api.quiet, input, "signed-out"),
        "signed-out"
      ),
    }).toStrictEqual({
      failed: "auth.unauthenticated",
      settled: "operation.cancelled",
    });
  });

  it("cancels a stream that emits nothing at once when its person's role narrows", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const input = { title: "Late", pauseMs: 9000 };
    let steps = 0;
    const running = failureOf(
      client.stream(api.quiet, input, {
        idempotencyKey: "narrowed",
        onProgress: () => {
          steps += 1;
        },
      })
    );
    await until(() => steps >= 1);
    await opened.admin.api.members.setRole(opened.builderId, "user");
    const failed = await running;
    expect({
      failed: failed.code,
      settled: await settledCodeOf(
        opened,
        requestFor(api.quiet, input, "narrowed"),
        "narrowed"
      ),
    }).toStrictEqual({
      failed: "operation.access_changed",
      settled: "operation.cancelled",
    });
  });

  it("withholds a finished stream's receipt from its person once their role narrowed", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const keyed = {
      idempotencyKey: "before-demotion",
      onProgress: ignoreProgress,
    };
    const input = { topic: "budget", pauseMs: 0 };
    await client.stream(api.draft, input, keyed);
    await opened.admin.api.members.setRole(opened.builderId, "user");
    await expect(
      failureOf(client.stream(api.draft, input, keyed))
    ).resolves.toMatchObject({
      code: "operation.access_changed",
    });
  });

  it("keeps one App's stream from another App's path, under the same key", async () => {
    const opened = await openedApp();
    const other = await openedApp({
      builder: opened.builderApi,
      admin: opened.admin,
    });
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const input = { topic: "mine", pauseMs: 0 };
    await client.stream(api.draft, input, {
      idempotencyKey: "one-app",
      onProgress: ignoreProgress,
    });
    const attached = await post(
      other.app,
      other.builder,
      "/attach",
      JSON.stringify(requestFor(api.draft, input, "one-app"))
    );
    await expect(attached.text()).resolves.toContain(
      '"code":"submission.expired"'
    );
  });

  it("refuses a stream to a frame without a lease, as code core didn't serve", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const response = await post(
      opened.app,
      { ...opened.builder, lease: "" },
      "/stream",
      JSON.stringify(
        requestFor(api.draft, { topic: "x", pauseMs: 0 }, "no-lease")
      )
    );
    const refused: unknown = Reflect.get(await refusal(response), "code");
    expect({ status: response.status, code: refused }).toStrictEqual({
      status: 403,
      code: "screen.unreviewed",
    });
  });

  it("refuses a stream to a frame that names someone other than the person signed in, or no one", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const request = JSON.stringify(
      requestFor(api.draft, { topic: "x", pauseMs: 0 }, "someone-else")
    );
    const codeOf = async (named: string) => {
      const response = await post(
        opened.app,
        { ...opened.builder, person: named },
        "/stream",
        request
      );
      const code: unknown = Reflect.get(await refusal(response), "code");
      return { status: response.status, code };
    };
    expect({
      someoneElse: await codeOf(opened.other.person),
      noOne: await codeOf(""),
    }).toStrictEqual({
      someoneElse: { status: 401, code: "auth.principal_changed" },
      noOne: { status: 401, code: "auth.principal_changed" },
    });
  });
});

/** "resolved", or the code `promise` was refused with. */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof GraspError ? error.code : "thrown";
  }
};

describe(
  "a streaming action under concurrent and changing access",
  { timeout: 120_000 },
  () => {
    it("runs once for two starts under one key at the same time, and refuses one with other input", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const { client } = clientFor(opened);
      const keyed = {
        idempotencyKey: "twice-at-once",
        onProgress: ignoreProgress,
      };
      const input = { topic: "once", pauseMs: 200 };
      const both = await Promise.all([
        client.stream(api.draft, input, keyed),
        client.stream(api.draft, input, keyed),
      ]);
      const other = {
        idempotencyKey: "other-input",
        onProgress: ignoreProgress,
      };
      const raced = await Promise.all([
        outcome(client.stream(api.draft, { topic: "a", pauseMs: 200 }, other)),
        outcome(client.stream(api.draft, { topic: "b", pauseMs: 200 }, other)),
      ]);
      const notes = await titles(client, opened);
      expect({
        both,
        raced: raced.toSorted(),
        notes: notes.length,
      }).toStrictEqual({
        both: [{ text: "Draft about once" }, { text: "Draft about once" }],
        raced: ["resolved", "submission.key_conflict"],
        // One for the first key, one for the start that won the second.
        notes: 2,
      });
    });

    it("withholds a finished stream's receipt from someone whose role in the App narrowed", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const shared = await personApi("builder");
      await opened.builderApi.api.apps.members.add(opened.app, {
        type: "person",
        id: shared.userId,
        role: "builder",
      });
      const { lease } = await shared.api.screens.open(opened.app, "writer");
      const { client } = clientFor(opened, {
        lease,
        cookie: shared.session,
        person: shared.userId,
      });
      const keyed = {
        idempotencyKey: "app-builder",
        onProgress: ignoreProgress,
      };
      const input = { topic: "builders", pauseMs: 0 };
      await client.stream(api.draft, input, keyed);
      // Their organization role and teams stay; their role in the App narrows.
      await opened.builderApi.api.apps.members.add(opened.app, {
        type: "person",
        id: shared.userId,
        role: "user",
      });
      await expect(
        failureOf(client.stream(api.draft, input, keyed))
      ).resolves.toMatchObject({
        code: "operation.access_changed",
      });
    });

    it("keeps recovering when a reconnect is refused for the request budget", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const { client, page } = clientFor(opened);
      page.cut();
      page.refuseAttaches(1);
      await expect(
        client.stream(
          api.draft,
          { topic: "budget", pauseMs: 400 },
          { onProgress: ignoreProgress }
        )
      ).resolves.toStrictEqual({ text: "Draft about budget" });
    });

    it("keeps a person's places for running streams through a restart of the App's object", async () => {
      const opened = await openedApp();
      const api = apiOf(opened.release);
      const { client } = clientFor(opened);
      const steps = [0, 0, 0, 0];
      const running = steps.map(
        async (_, slot) =>
          await failureOf(
            client.stream(
              api.slow,
              { title: `Kept ${slot}` },
              {
                idempotencyKey: `kept-${slot}`,
                onProgress: () => {
                  steps[slot] = (steps[slot] ?? 0) + 1;
                },
              }
            )
          ).catch(() => null)
      );
      await until(() => steps.every((count) => count >= 1));
      // Every object starts afresh, the App's among them; what they stored stays.
      await abortAllDurableObjects();
      const fifth = await failureOf(
        client.stream(
          api.draft,
          { topic: "fifth", pauseMs: 0 },
          { onProgress: ignoreProgress }
        )
      );
      await Promise.all(running);
      expect(fifth.code).toBe("operation.stream_limit");
    });
  }
);

/**
 * The invocation object of `call` under `key`, for `opened`'s builder, and
 * how to open it as core's route does: for a streaming action or a plain one.
 */
const invocationOf = async (
  opened: Opened,
  call: FunctionRequest,
  key: string,
  streaming: boolean
) => {
  const by = { userId: opened.builderId, role: "builder" as const, teams: [] };
  const app = appIdSchema.parse(opened.app);
  const name = await invocationName(
    opened.builderId,
    app,
    call,
    key,
    streaming
  );
  const stub = env.ACTION_INVOCATIONS.getByName(name);
  const access = await accessOf(env, by, app);
  return {
    stub,
    open: async () =>
      await stub.open({
        by,
        access,
        app,
        name,
        call,
        streaming,
        attach: false,
      }),
  };
};

/** `bottom` inside `levels` arrays: past `levels` 32, deeper than a value reads. */
const tooDeep = (bottom: string, levels: number): Json => {
  let value: Json = bottom;
  for (let level = 0; level < levels; level += 1) {
    value = [value];
  }
  return value;
};

/** The code a stream of frames ends with, or "ok". */
const endOf = async (frames: ReadableStream<Uint8Array>): Promise<string> => {
  const text = await new Response(frames).text();
  const lines = text.trim().split("\n");
  const last = z
    .object({
      result: z.union([
        z.object({ ok: z.literal(true) }).loose(),
        z.object({
          ok: z.literal(false),
          error: z.object({ code: z.string() }).loose(),
        }),
      ]),
    })
    .loose()
    .parse(JSON.parse(lines.at(-1) ?? "{}"));
  return last.result.ok ? "ok" : last.result.error.code;
};

/** Publishes a second version of `opened`'s App, its contracts unchanged. */
const published = async (opened: Opened): Promise<Release> => {
  const changed = {
    ...files,
    "grasp.config.ts": `${files["grasp.config.ts"] ?? ""}\n// The second version.\n`,
  };
  const { version } = await opened.builderApi.api.apps.files.commit(
    opened.app,
    changed,
    "Second"
  );
  await opened.builderApi.api.apps.versions.setCurrent(opened.app, version);
  return await loadRelease(env, opened.app, version);
};

describe("an action's invocation object", { timeout: 120_000 }, () => {
  it("decides a cancel sent while a start is being decided after it, and cancels the run", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const call = requestFor(
      api.draft,
      { topic: "stop", pauseMs: 300 },
      "cancel-at-start"
    );
    const { stub, open } = await invocationOf(
      opened,
      call,
      "cancel-at-start",
      true
    );
    const [frames, requested] = await Promise.all([
      open(),
      stub.cancel(opened.builderId),
    ]);
    expect({ requested, end: await endOf(frames) }).toStrictEqual({
      requested: true,
      end: "operation.cancelled",
    });
  });

  it("holds at most sixteen plain runs at once for a person in one App, recording nothing past them", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const runs = await Promise.all(
      Array.from({ length: actionMaxRunning }, async (_, slot) => {
        const call = requestFor(api.waits, { pauseMs: 5000 }, `plain-${slot}`);
        const invocation = await invocationOf(
          opened,
          call,
          `plain-${slot}`,
          false
        );
        return { ...invocation, frames: await invocation.open() };
      })
    );
    const past = requestFor(api.waits, { pauseMs: 0 }, "plain-past");
    const pastRun = await invocationOf(opened, past, "plain-past", false);
    const refused = await pastRun.open();
    const end = await endOf(refused);
    for (const { stub } of runs) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await stub.cancel(opened.builderId);
    }
    const ended = await Promise.all(
      runs.map(async ({ frames }) => await endOf(frames))
    );
    // Nothing was recorded: the same key starts once there is room.
    const again = await endOf(await pastRun.open());
    expect({ end, ended: new Set(ended), again }).toStrictEqual({
      end: "operation.action_limit",
      ended: new Set(["operation.cancelled"]),
      again: "ok",
    });
  });

  it("refuses input too deep to read, so two such inputs never share a key's run", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const ends = async (
      reference: typeof api.draft | typeof api.echo,
      key: string,
      streaming: boolean,
      readable: Json
    ) => {
      const endFor = async (input: Json): Promise<string> => {
        const call = requestFor(reference, input, key);
        const { open } = await invocationOf(opened, call, key, streaming);
        return await endOf(await open());
      };
      return [
        await endFor({ topic: tooDeep("a", 40) }),
        await endFor({ topic: tooDeep("b", 40) }),
        // Nothing was recorded under the key: readable input runs.
        await endFor(readable),
      ];
    };
    expect({
      streaming: await ends(api.draft, "deep-stream", true, {
        topic: "readable",
        pauseMs: 0,
      }),
      plain: await ends(api.echo, "deep-plain", false, { word: "readable" }),
    }).toStrictEqual({
      streaming: ["contract.invalid_request", "contract.invalid_request", "ok"],
      plain: ["contract.invalid_request", "contract.invalid_request", "ok"],
    });
  });

  it("keeps no receipt of a refusal that ran nothing of the App's", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    // A plain action through the streaming path: refused before it runs.
    const call = requestFor(api.echo, {}, "ran-nothing");
    const { stub, open } = await invocationOf(
      opened,
      call,
      "ran-nothing",
      true
    );
    const end = await endOf(await open());
    const stored = await runInDurableObject(stub, (_instance, state) =>
      JSON.stringify([...state.storage.kv.list()])
    );
    expect({ end, stored }).toStrictEqual({
      end: "operation.mode_mismatch",
      stored: "[]",
    });
  });

  it("answers a receipt across a publish that keeps the contract, running nothing again", async () => {
    const opened = await openedApp();
    const { client } = clientFor(opened);
    const keyed = {
      idempotencyKey: "across-publish",
      onProgress: ignoreProgress,
    };
    // How many notes there were before it ran: run again, it would say one.
    const first = await client.stream(apiOf(opened.release).counts, {}, keyed);
    const second = await published(opened);
    const again = await client.stream(apiOf(second).counts, {}, keyed);
    expect({ first, again }).toStrictEqual({ first: 0, again: 0 });
  });

  it("runs an action only in the version its invocation recorded, refused once another is current", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const by = {
      userId: opened.builderId,
      role: "builder" as const,
      teams: [],
    };
    const app = appIdSchema.parse(opened.app);
    // As the invocation object runs it, after recording `version`: a
    // publish in between never runs code its record doesn't name, so
    // revoking what ran stops its result.
    const runIn = async (version: number) => {
      const { result } = await invokeAppAction(
        env,
        by,
        app,
        requestFor(api.echo, { word: "recorded" }, `in-${version}`),
        {
          version,
          cancelled: new AbortController().signal,
          deadline: Date.now() + 30_000,
        }
      );
      return result.ok ? result.value : result.error.code;
    };
    const current = await runIn(1);
    await published(opened);
    expect({
      current,
      passed: await runIn(1),
      now: await runIn(2),
    }).toStrictEqual({
      current: "recorded",
      passed: "version.mismatch",
      now: "recorded",
    });
  });

  it("refuses a receipt of a release revoked since", async () => {
    const opened = await openedApp();
    const { client } = clientFor(opened);
    const api = apiOf(opened.release);
    const input = { topic: "revoked", pauseMs: 0 };
    const keyed = {
      idempotencyKey: "revoked-receipt",
      onProgress: ignoreProgress,
    };
    await client.stream(api.draft, input, keyed);
    await published(opened);
    await revokeRelease(
      env,
      await person("admin"),
      { app: appIdSchema.parse(opened.app), version: 1 },
      "Leaks data"
    );
    // The frame was opened on version 1: its build is revoked with it.
    await expect(
      failureOf(client.stream(api.draft, input, keyed))
    ).resolves.toMatchObject({
      code: "screen.revoked",
    });
  });

  it("stops relaying a stream whose release is revoked while it runs, after a later one is published", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    let steps = 0;
    const running = client.stream(
      api.slow,
      { title: "Made under one" },
      {
        onProgress: () => {
          steps += 1;
        },
      }
    );
    await until(() => steps >= 1);
    await published(opened);
    await revokeRelease(
      env,
      await person("admin"),
      { app: appIdSchema.parse(opened.app), version: 1 },
      "Leaks data"
    );
    const revokedAt = Date.now();
    // The frame was opened on version 1: its build is revoked with it.
    await expect(failureOf(running)).resolves.toMatchObject({
      code: "screen.revoked",
    });
    // Stopped at the relay's next check, not once the run ends (40 s on).
    expect(Date.now() - revokedAt).toBeLessThan(15_000);
  });

  it("refuses a receipt made under a release revoked since, to a caller of a later one", async () => {
    const opened = await openedApp();
    const { client } = clientFor(opened);
    const input = { topic: "made under one", pauseMs: 0 };
    const keyed = {
      idempotencyKey: "made-under-v1",
      onProgress: ignoreProgress,
    };
    await client.stream(apiOf(opened.release).draft, input, keyed);
    const second = await published(opened);
    await revokeRelease(
      env,
      await person("admin"),
      { app: appIdSchema.parse(opened.app), version: 1 },
      "Leaks data"
    );
    // A screen opened on version 2, with its own lease: the same contract,
    // the same invocation, made under 1.
    const { lease } = await opened.builderApi.api.screens.open(
      opened.app,
      "writer"
    );
    const later = clientFor(opened, { ...opened.builder, lease });
    await expect(
      failureOf(later.client.stream(apiOf(second).draft, input, keyed))
    ).resolves.toMatchObject({ code: "version.revoked" });
  });

  it("settles a run stuck past its deadline as unknown, with the key", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    const input = { title: "Stuck", pauseMs: 2000 };
    let steps = 0;
    const running = failureOf(
      client.stream(api.quiet, input, {
        onProgress: () => {
          steps += 1;
        },
        idempotencyKey: "stuck",
      })
    );
    await until(() => steps >= 1);
    const call = requestFor(api.quiet, input, "stuck");
    const { stub } = await invocationOf(opened, call, "stuck", true);
    // As if its run ignored its deadline: the deadline long past.
    await runInDurableObject(stub, (_instance, state) => {
      const record = z
        .object({ deadline: z.number() })
        .loose()
        .parse(state.storage.kv.get("invocation"));
      state.storage.kv.put("invocation", {
        ...record,
        deadline: Date.now() - 120_000,
      });
    });
    await runDurableObjectAlarm(stub);
    await expect(running).resolves.toMatchObject({
      code: "operation.outcome_unknown",
      details: { idempotencyKey: "stuck" },
    });
    // Its run ends later after all: what was said of it stands.
    await scheduler.wait(2500);
    await expect(
      failureOf(
        client.stream(api.quiet, input, {
          onProgress: ignoreProgress,
          idempotencyKey: "stuck",
        })
      )
    ).resolves.toMatchObject({ code: "operation.outcome_unknown" });
  });

  it("carries the key on an uncertain outcome its caller didn't choose a key for", async () => {
    const opened = await openedApp();
    const api = apiOf(opened.release);
    const { client } = clientFor(opened);
    let steps = 0;
    const running = failureOf(
      client.stream(
        api.slow,
        { title: "Restarted" },
        {
          onProgress: () => {
            steps += 1;
          },
        }
      )
    );
    await until(() => steps >= 1);
    // Its object restarts while it runs: whether it finished is unknown.
    await abortAllDurableObjects();
    const failed = await running;
    expect({
      code: failed.code,
      key: z.object({ idempotencyKey: z.string() }).safeParse(failed.details)
        .success,
    }).toStrictEqual({ code: "operation.outcome_unknown", key: true });
  });
});
