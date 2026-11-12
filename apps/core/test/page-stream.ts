import type { FunctionReference, ReferenceKind } from "@grasp-os/runtime/app";
import { GraspClient } from "@grasp-os/runtime/host";
import type { ClientTransport, StreamLink } from "@grasp-os/runtime/host";
import { GraspError } from "@grasp-os/runtime/page";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import {
  appFunctionPath,
  pageLeaseHeader,
  pagePersonHeader,
} from "@grasp-os/shared/pages";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, vi } from "vite-plus/test";
import { z } from "zod";

import { accessOf, invocationName } from "../src/action-invocation.ts";
import type { FunctionRequest } from "../src/app-functions.ts";
import { loadRelease } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import { commitApp, testApp, withFiles } from "./app-definitions.ts";
import type { TestApp } from "./app-definitions.ts";
import { published as publishedApp } from "./apps.ts";
import { referenceTo } from "./notes-client-app.ts";
import { personApi } from "./page-client.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed } from "./sign-in.ts";

// Foreground streaming actions' tests' App and how they reach it
// (page-stream.test.ts, page-stream-invocation.test.ts): the Writer
// App, a page's transport to core's real routes, and the invocation's
// own Durable Object.

export const files: TestApp = testApp(
  {
    name: "Writer",
    tables: {
      notes: {
        fields: { title: "v.string().min(1).max(500)" },
        access: { read: "owner", write: "owner" },
        indexes: { by_updated: ["_updatedAt"] },
      },
    },
  },
  {
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
    "src/routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
import { useStream } from "@grasp-os/sdk/react";
import { api } from "@server/_generated/api";

function Writer() {
  const draft = useStream(api.writer.draft);
  return <p>{draft.status === "completed" ? draft.output.text : draft.status}</p>;
}
export const Route = createFileRoute("/")({ component: Writer });
`,
  }
);

/** The function at `path` of `release`. */
export const functionAt = (release: Release, path: string) => {
  const fn = release.app.functions[path];
  if (fn === undefined) {
    throw new Error(`The release has no ${path}`);
  }
  return fn;
};

/**
 * A reference to a function of `release` that answers once, as the App's
 * `@server/_generated/api` has it.
 */
export const singleTo = <Args, Return, Kind extends ReferenceKind>(
  release: Release,
  path: string,
  _kind: Kind
): FunctionReference<Kind, "public", Args, Return> =>
  referenceTo<Args, Return, Kind>(release, path);

/** A reference to a streaming action of `release`. */
export const streamTo = <Args, Return, Progress>(
  release: Release,
  path: string
): FunctionReference<"action", "public", Args, Return, Progress> => {
  if (functionAt(release, path).stream === null) {
    throw new Error(`${path} doesn't stream`);
  }
  return referenceTo<Args, Return, "action", Progress>(release, path);
};

/** The App's `api`, typed as its pages get it. */
export const apiOf = (release: Release) => ({
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
export const ignoreProgress = (progress: unknown): void => {
  void progress;
};

export type Person = Awaited<ReturnType<typeof personApi>>;

/**
 * A builder's Writer App, current, its page
 * opened by both: `builder` and `admin` when given, new people otherwise.
 */
export const openedApp = async (
  people: { builder?: Person; admin?: Person } = {}
) => {
  const builder = people.builder ?? (await personApi("builder"));
  const admin = people.admin ?? (await personApi("admin"));
  const { id } = await builder.api.apps.create({ name: "Writer" });
  await publishedApp(id);
  const { version } = await commitApp(
    builder.api.apps.files,
    id,
    files,
    "First"
  );
  await builder.api.apps.versions.publish(id, version);
  const { lease } = await builder.api.pages.open(id);
  const { lease: adminLease } = await admin.api.pages.open(id);
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

export type Opened = Awaited<ReturnType<typeof openedApp>>;

export interface Seat {
  readonly lease: string;
  readonly cookie: string;
  /** Who the frame is for, as the page names them (`pagePersonHeader`). */
  readonly person: string;
}

export const post = async (
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
      [pageLeaseHeader]: seat.lease,
      [pagePersonHeader]: seat.person,
    },
    body: request,
  });

/** A refusal before any call ran, as the page throws it. */
export const refusal = async (response: Response): Promise<Error> => {
  const payload = errorPayloadSchema.parse(await response.json());
  return Object.assign(new Error(payload.message), { code: payload.code });
};

/**
 * What the page does for a page (apps/web's page-host.ts and
 * page-stream.ts): calls through core's routes, frames read as lines
 * and handed on, `{ type: "closed" }` once the connection ends without a
 * result. `cut()` drops the connection after the next progress frame.
 */
export const pageTransport = (app: string, seat: Seat) => {
  let cutting = false;
  let refusingAttaches = 0;
  const opened: string[] = [];
  const transport: ClientTransport = {
    // Live queries are page-client-live.test.ts's: these only call and stream.
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
          code: "page.rate_limited",
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

export const clientFor = (opened: Opened, seat: Seat = opened.builder) => {
  const page = pageTransport(opened.app, seat);
  return { client: new GraspClient(page.transport), page };
};

/** Why `promise` rejected: the structured error's code, category and details. */
export const failureOf = async (promise: Promise<unknown>) => {
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
export const titles = async (
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
export const until = async (test: () => boolean): Promise<void> => {
  await vi.waitFor(
    () => {
      expect(test()).toBeTruthy();
    },
    { timeout: 10_000, interval: 50 }
  );
};

/** The request of a call of `reference` with `input` under `key`, as the client sends it. */
export const requestFor = (
  reference: { name: string },
  input: Json,
  key: string
): FunctionRequest => ({
  reference: { name: reference.name, kind: "action" },
  args: input,
  idempotencyKey: key,
});

/** What the invocation of `call` keeps in its object's storage, as text. */
export const storedOf = async (
  opened: Opened,
  call: FunctionRequest,
  key: string
): Promise<string> => {
  const name = await invocationName(opened.builderId, opened.app, call, key, {
    streaming: true,
  });
  return await runInDurableObject(
    env.ACTION_INVOCATIONS.getByName(name),
    (_instance, state) => JSON.stringify([...state.storage.kv.list()])
  );
};

/** The code of the result `call`'s invocation settled with, once it has. */
export const settledCodeOf = async (
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

/** "resolved", or the code `promise` was refused with. */
export const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof GraspError ? error.code : "thrown";
  }
};

/**
 * The invocation object of `call` under `key`, for `opened`'s builder, and
 * how to open it as core's route does: for a streaming action or a plain one.
 */
export const invocationOf = async (
  opened: Opened,
  call: FunctionRequest,
  key: string,
  streaming: boolean
) => {
  const by = { userId: opened.builderId, role: "builder" as const, teams: [] };
  const app = appIdSchema.parse(opened.app);
  const name = await invocationName(opened.builderId, app, call, key, {
    streaming,
  });
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
export const tooDeep = (bottom: string, levels: number): Json => {
  let value: Json = bottom;
  for (let level = 0; level < levels; level += 1) {
    value = [value];
  }
  return value;
};

/** The code a stream of frames ends with, or "ok". */
export const endOf = async (
  frames: ReadableStream<Uint8Array>
): Promise<string> => {
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
export const published = async (opened: Opened): Promise<Release> => {
  const changed = withFiles(files, {
    "server/notes.ts": `${files.files["server/notes.ts"] ?? ""}\n// The second version.\n`,
  });
  const { version } = await commitApp(
    opened.builderApi.api.apps.files,
    opened.app,
    changed,
    "Second"
  );
  await opened.builderApi.api.apps.versions.publish(opened.app, version);
  return await loadRelease(env, opened.app, version);
};
