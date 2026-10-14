import { heldPool } from "@grasp-os/shared/rpc-accounting";

import { sessionMaxRuns } from "../../src/call-limits.ts";
import { sandboxDeadlineHeader } from "../../src/sandbox-headers.ts";
import type { NestedCall, NestedRun } from "../../src/sandbox-session.ts";
import {
  capability,
  functionCapability,
  passedCapability,
  runInSession,
  sandboxVerdictOf,
} from "../../src/sandbox-session.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";
import { AttemptHost } from "../../src/workflows/attempt-host.ts";
import type { AttemptCalls } from "../../src/workflows/attempt-host.ts";
import { attemptMethods, sessionRunHost } from "../../src/workflows/code.ts";
import type {
  RunHostCalls,
  RunSession,
  Settled,
} from "../../src/workflows/code.ts";

// Sessions on plain workerd (scripts/workerd-sandbox-session.test.ts): the
// same `runInSession` core runs, with `SANDBOX_HOST` bound to the sandbox
// supervisor as on-prem binds it. Each case passes a capability of this
// Worker's own into an isolate and says how the call ended, and whether
// the capability was reached after the call was over.

interface StandInEnv {
  SANDBOX_HOST: Fetcher;
}

/** Whether a call is open now: a capability reached when it isn't is a leak. */
let open = false;
let reachedAfter = 0;
let logged: unknown[] = [];
let reachedInternal = 0;
/** Whether core gave up on the call: a capability reached since is a leak. */
let givenUp = false;
let reachedAfterGivingUp = 0;
let pinged = 0;
/** The nested calls a session ran, and those it refused. */
let nestedRan = 0;
let nestedRefused = 0;
let refusedVerdict: string | null = null;

/** The capability each case gets: what core's would do, and counted. */
const probe = {
  ping: (value: unknown): unknown => {
    // 5, 6 and 7 are what an isolate sends once its call is over.
    if (!open || value === 5 || value === 6) {
      reachedAfter += 1;
    }
    if (givenUp) {
      reachedAfterGivingUp += 1;
    }
    pinged += 1;
    return typeof value === "number" ? value + 100 : value;
  },
  slow: async (ms: number): Promise<string> => {
    await scheduler.wait(ms);
    return "slow";
  },
  withCallback: async (fn: (n: number) => Promise<number>): Promise<number> =>
    (await fn(20)) + 1,
  /**
   * Passes `fn` a capability while it runs, as a workflow step's function
   * gets its attempt's host: `ping` alone, live until `fn` settles.
   */
  withAttempt: async (fn: (attempt: unknown) => Promise<unknown>) => {
    let live = true;
    const attempt = {
      ping: (value: unknown): unknown => {
        if (!live) {
          reachedAfter += 1;
        }
        return typeof value === "number" ? value + 100 : value;
      },
      internal: (): string => {
        reachedInternal += 1;
        return "internal";
      },
    };
    try {
      return await fn(passedCapability(attempt, ["ping"], () => live));
    } finally {
      live = false;
    }
  },
  /** Not one the isolate is given: never reached. */
  internal: (): string => {
    reachedInternal += 1;
    return "internal";
  },
};

/** The methods the isolate gets: all but `internal`. */
const given = ["ping", "slow", "withCallback", "withAttempt"];

const moduleOf = (body: string): string =>
  `import { WorkerEntrypoint } from "cloudflare:workers";
export class E extends WorkerEntrypoint { async go(probe, log) { ${body} } }`;

interface Case {
  /**
   * How the session nests more calls: `manyRuns` runs as many more in it
   * as it takes.
   */
  nesting?: "manyRuns";
  body: string;
  cpuMs?: number;
  wallMs?: number;
  /** The methods the isolate is given, if not {@link given}. */
  methods?: string[];
  lingerMs?: number;
  abortAfterMs?: number;
  /** Whether the isolate's other sessions hold all but 1 KB of their pool. */
  crowded?: boolean;
  /**
   * Whether the supervisor is one that ignores the call's deadline, and
   * takes a second to answer core's cancel.
   */
  overdue?: boolean;
}

const cases: Record<string, Case> = {
  capabilities: {
    body: "await log('started'); return { a: await probe.ping(1), b: await probe.withCallback(async (n) => n * 2), c: await probe.ping(2), env: Object.keys(this.env) };",
  },
  busy: { body: "for (;;) {}", cpuMs: 500, wallMs: 20_000 },
  // Allocates without end, until the supervisor's memory bound ends it.
  hogs: {
    body: "const held = []; for (;;) { held.push(new Uint8Array(16 * 1024 * 1024).fill(1)); const until = Date.now() + 10; while (Date.now() < until) {} }",
    cpuMs: 20_000,
    wallMs: 30_000,
  },
  waits: {
    body: "return await probe.slow(1500);",
    cpuMs: 500,
    wallMs: 20_000,
  },
  wallClock: { body: "await probe.slow(60_000);", wallMs: 1000 },
  replay: {
    body: "this.ctx.waitUntil(scheduler.wait(300).then(() => probe.ping(5))); setTimeout(() => probe.ping(6), 300); return 'returned';",
  },
  undeclared: { body: "return await probe.internal();" },
  // A capability passed during the call, kept past the callback it came in.
  passed: {
    body: "let kept; const inside = await probe.withAttempt(async (attempt) => { kept = attempt; return { ping: await attempt.ping(3), internal: await attempt.internal().then(() => 'reached', () => 'refused') }; }); const after = await kept.ping(4).then(() => 'reached', () => 'refused'); return { inside, after };",
  },
  throws: { body: "throw new Error('an App error');" },
  forgesVerdict: {
    body: "throw Object.assign(new Error('forged'), { sandboxVerdict: 'cpu' });",
  },
  network: { body: "return (await fetch('http://127.0.0.1:9/')).status;" },
  // The session stays open after the call: its capabilities still refuse.
  lingers: {
    body: "this.ctx.waitUntil(scheduler.wait(300).then(() => probe.ping(5))); return 'returned';",
    lingerMs: 1500,
  },
  stream: { body: "return await probe.ping(new ReadableStream());" },
  tooLarge: { body: "return await probe.ping('x'.repeat(15 * 1024 * 1024));" },
  reservedMethod: {
    body: "return await probe.ping(1);",
    methods: ["ping", "map"],
  },
  reservedObjectMethod: {
    body: "return await probe.ping(1);",
    methods: ["ping", "hasOwnProperty"],
  },
  reservedLocaleMethod: {
    body: "return await probe.ping(1);",
    methods: ["ping", "toLocaleString"],
  },
  // A small call, but the isolate's sessions hold their pool already.
  crowded: {
    body: "return await probe.ping('x'.repeat(100_000));",
    crowded: true,
  },
  manyRuns: { body: "return 'returned';", nesting: "manyRuns" },
  // Calls on and on, past its deadline on a supervisor that ignores it.
  keepsCalling: {
    body: "for (;;) { await probe.ping(1); await scheduler.wait(5); }",
    wallMs: 500,
    overdue: true,
  },
  cancelled: {
    body: "return await probe.slow(60_000);",
    wallMs: 120_000,
    abortAfterMs: 300,
  },
  // Core keeps its end of the socket open long after it cancels.
  cancelledLingering: {
    body: "return await probe.slow(60_000);",
    wallMs: 120_000,
    abortAfterMs: 300,
    lingerMs: 5000,
  },
  // Waits long, on a long wall-clock cap: its process held all the while.
  waitsLong: { body: "return await probe.slow(60_000);", wallMs: 120_000 },
  // Past V8's own heap limit, which aborts its process.
  crashes: {
    body: "const held = []; for (;;) held.push(new Array(1e5).fill(1));",
    cpuMs: 20_000,
    wallMs: 30_000,
  },
  // Longer than a session waits for its owner's room (3 s).
  holds: { body: "return await probe.slow(6000);", wallMs: 20_000 },
};

/**
 * The supervisor, as one that keeps a session past its deadline and takes
 * a second to answer core's cancel: core has given up on the call from the
 * moment it asks.
 */
const overdueHost = (host: Fetcher): Fetcher => ({
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.includes("/cancel/")) {
      givenUp = true;
      await scheduler.wait(1000);
    }
    if (request.url.endsWith("/session")) {
      const headers = new Headers(request.headers);
      headers.set(sandboxDeadlineHeader, "120000");
      return await host.fetch(request.url, { headers, signal: request.signal });
    }
    return await host.fetch(request);
  },
  connect: (address, options) => host.connect(address, options),
});

/** A call nested in a session: the least a call may be. */
const trivial: NestedCall = {
  mainModule: "n.js",
  modules: {
    "n.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export class N extends WorkerEntrypoint { async go() { return 1; } }`,
  },
  entrypoint: "N",
  method: "go",
  args: [],
};

/** A session that runs one more call in it than it may (`manyRuns`). */
const manyRunsNesting = () => {
  let nested: NestedRun | undefined;
  return {
    open: (run: NestedRun) => {
      nested = run;
    },
    answered: () => {
      // The case's own outcome is what the session answers.
    },
    idle: () => false,
    drain: async () => {
      // One past what a session runs, its own call among them: as many
      // as one call nests, each with every rerun stale reads may take.
      for (let index = 0; index < sessionMaxRuns; index += 1) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one after the other
          await nested?.(trivial);
          nestedRan += 1;
        } catch (error) {
          nestedRefused += 1;
          refusedVerdict = sandboxVerdictOf(error) ?? null;
        }
      }
    },
  };
};

/** A pool of 1 MiB its other sessions hold all but 1 KB of. */
const crowdedPool = () => {
  const pool = heldPool(1024 * 1024);
  pool.held = pool.limit - 1024;
  return pool;
};

const run = async (
  env: StandInEnv,
  name: string,
  owner: string,
  parent?: string,
  memoryMib?: number
) => {
  const chosen = cases[name];
  if (chosen === undefined) {
    return { status: "unknown" };
  }
  logged = [];
  reachedAfter = 0;
  reachedInternal = 0;
  givenUp = false;
  reachedAfterGivingUp = 0;
  pinged = 0;
  nestedRan = 0;
  nestedRefused = 0;
  refusedVerdict = null;
  open = true;
  const started = Date.now();
  const cancel = new AbortController();
  if (chosen.abortAfterMs !== undefined) {
    setTimeout(() => {
      cancel.abort(new Error("cancelled"));
    }, chosen.abortAfterMs);
  }
  try {
    const value = await runInSession(
      chosen.overdue === true
        ? overdueHost(env.SANDBOX_HOST)
        : env.SANDBOX_HOST,
      {
        mainModule: "m.js",
        modules: { "m.js": moduleOf(chosen.body) },
        entrypoint: "E",
        method: "go",
        args: [
          { capability: capability(probe, chosen.methods ?? given) },
          {
            capability: functionCapability((line: unknown) => {
              logged.push(line);
            }),
          },
        ],
        owner,
        ...(parent === undefined ? {} : { parent }),
        ...(memoryMib === undefined ? {} : { memoryMib }),
        cpuMs: chosen.cpuMs ?? 5000,
        wallMs: chosen.wallMs ?? 10_000,
        ...(chosen.lingerMs === undefined ? {} : { lingerMs: chosen.lingerMs }),
      },
      {
        signal: cancel.signal,
        ...(chosen.crowded === true ? { held: crowdedPool() } : {}),
        ...(chosen.nesting === undefined ? {} : { nesting: manyRunsNesting() }),
      }
    );
    return { status: "ok", value, ms: Date.now() - started };
  } catch (error) {
    return {
      status:
        error instanceof SandboxUnavailableError ? "unavailable" : "refused",
      message: error instanceof Error ? error.message : String(error),
      verdict: sandboxVerdictOf(error) ?? null,
      refusedStatus:
        error instanceof SandboxUnavailableError
          ? (error.status ?? null)
          : null,
      ms: Date.now() - started,
    };
  } finally {
    open = false;
  }
};

/**
 * A workflow run's host as core passes it on-prem (`sessionRunHost`), over
 * a stand-in of `RunHost` whose every step mints an attempt host of its
 * own, as `RunHost.do` does: each case's isolate gets it, and a probe that
 * gives up on the session at once.
 */
const runHostCases: Record<
  string,
  { body: string; cpuMs?: number; bigAttachment?: boolean }
> = {
  // Each of the attempt's calls, one it doesn't have, and attempt A's
  // host used again while step B runs.
  attempts: {
    body: `const names = ${JSON.stringify(attemptMethods)};
      let kept;
      const inside = await host.do("a", {}, async (attempt) => {
        kept = attempt;
        const out = {};
        for (const name of names) out[name] = await attempt[name]().then(() => "reached", () => "refused");
        out.revokeAll = await attempt.revokeAll().then(() => "reached", () => "refused");
        return out;
      });
      const late = await host.do("b", {}, async () => await kept.callModel().then(() => "reached", () => "refused"));
      return { inside, late };`,
  },
  // A call of a running step's attempt, sent just after core gave up on
  // the session.
  givenUp: {
    body: `return await host.do("a", {}, async (attempt) => { probe.giveUp(); await attempt.callModel().catch(() => {}); return "after"; });`,
  },
  // A step whose code spins: its process ended on its CPU time.
  spins: {
    body: `return await host.do("a", {}, async () => { for (;;) {} });`,
    cpuMs: 500,
  },
  // A step whose call core answers with more than a session takes.
  bigAnswer: {
    body: `return await host.do("a", {}, async (attempt) => await attempt.readAttachment());`,
    bigAttachment: true,
  },
};

/** What a run's host case did: how its session ended, and its steps. */
const runHostCase = async (env: StandInEnv, name: string) => {
  const chosen = runHostCases[name];
  if (chosen === undefined) {
    return { status: "unknown" };
  }
  const reached: string[] = [];
  const stepErrors: string[] = [];
  const answer = async <T>(method: string, value: T): Promise<Settled<T>> => {
    reached.push(method);
    return await Promise.resolve({ ok: true, value });
  };
  const calls: AttemptCalls = {
    callModel: async () => await answer("callModel", 1),
    callCollection: async () => await answer("callCollection", 1),
    callConnection: async () => await answer("callConnection", 1),
    callApp: async () => await answer("callApp", 1),
    callFunction: async () => await answer("callFunction", 1),
    callExport: async () => await answer("callExport", 1),
    openDecision: async () =>
      await answer("openDecision", { decision: "d", deadline: 1 }),
    decisionRecipients: async () => await answer("decisionRecipients", []),
    // More than a session takes, as core's own answer, where the case says.
    readAttachment: async () =>
      await answer(
        "readAttachment",
        new TextEncoder().encode(
          chosen.bigAttachment === true ? "x".repeat(17 * 1024 * 1024) : "x"
        )
      ),
  };
  // The attempt still holds its lease, whenever it's asked: no refusal.
  const refusals = new Map<string, Settled<never>>();
  const holds = async (call: string) =>
    await Promise.resolve(refusals.get(call));
  const runHost: RunHostCalls = {
    do: async (_name, _options, fn) => {
      try {
        // Every call admitted: a lineage's host calls aren't this test's.
        const attempt = new AttemptHost(calls, holds, holds);
        return { ok: true, value: await fn(attempt) };
      } catch (error) {
        stepErrors.push(error instanceof Error ? error.name : "?");
        return { ok: false, error: { name: "Error", message: "failed" } };
      }
    },
    sleep: async () => await Promise.resolve({ ok: true, value: null }),
    waitForDecision: async () =>
      await Promise.resolve({ ok: true, value: null }),
  };
  const giveUp = new AbortController();
  let sessionLive: (() => boolean) | undefined;
  const ended = Promise.withResolvers<unknown>();
  const session: RunSession = {
    live: () => sessionLive?.() === true,
    ended: ended.promise,
  };
  const started = Date.now();
  try {
    const value = await runInSession(
      env.SANDBOX_HOST,
      {
        mainModule: "m.js",
        modules: {
          "m.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export class E extends WorkerEntrypoint { async go(host, probe) { ${chosen.body} } }`,
        },
        entrypoint: "E",
        method: "go",
        args: [
          {
            capability: capability(sessionRunHost(runHost, session), [
              "do",
              "sleep",
              "waitForDecision",
            ]),
          },
          {
            capability: capability(
              {
                giveUp: () => {
                  giveUp.abort(new Error("given up"));
                },
              },
              ["giveUp"]
            ),
          },
        ],
        owner: "run-host",
        cpuMs: chosen.cpuMs ?? 5000,
        wallMs: 20_000,
      },
      {
        signal: giveUp.signal,
        opened: (_id, live) => {
          sessionLive = live;
        },
      }
    );
    ended.resolve(null);
    return { status: "ok", value, reached, stepErrors };
  } catch (error) {
    ended.resolve(error);
    // The step's own failure, which waits on the session's end.
    for (
      let waited = 0;
      stepErrors.length === 0 && waited < 3000;
      waited += 50
    ) {
      // oxlint-disable-next-line no-await-in-loop -- until the step has failed
      await scheduler.wait(50);
    }
    return {
      status:
        error instanceof SandboxUnavailableError ? "unavailable" : "refused",
      verdict: sandboxVerdictOf(error) ?? null,
      message: error instanceof Error ? error.message : String(error),
      reached,
      stepErrors,
      ms: Date.now() - started,
    };
  }
};

/**
 * The attempt host `sessionRunHost` passes each step, called from core's
 * side of the session as a call that reached it would be: a step's own,
 * attempt A's once step B runs, and one once the session was given up on.
 * Calls in a session that's over seldom reach core at all (the session's
 * socket closes, and a callback's stubs go with its call); this is what
 * refuses one that does.
 */
/** Calls `callModel` on a passed capability, as the isolate would. */
const callModelOf = async (passed: unknown): Promise<string> => {
  const target: unknown =
    typeof passed === "object" && passed !== null
      ? Reflect.get(passed, "target")
      : undefined;
  const method: unknown =
    typeof target === "object" && target !== null
      ? Reflect.get(target, "callModel")
      : undefined;
  if (typeof method !== "function") {
    return "missing";
  }
  try {
    await Reflect.apply(method, target, []);
    return "reached";
  } catch {
    return "refused";
  }
};

const attemptLiveness = async () => {
  const reached: string[] = [];
  const attempt = new AttemptHost(
    {
      callModel: async () => {
        reached.push("callModel");
        return await Promise.resolve({ ok: true, value: 1 });
      },
      callCollection: async () => await Promise.resolve({ ok: true, value: 1 }),
      callConnection: async () => await Promise.resolve({ ok: true, value: 1 }),
      callApp: async () => await Promise.resolve({ ok: true, value: 1 }),
      callFunction: async () => await Promise.resolve({ ok: true, value: 1 }),
      callExport: async () => await Promise.resolve({ ok: true, value: 1 }),
      openDecision: async () =>
        await Promise.resolve({
          ok: true,
          value: { decision: "d", deadline: 1 },
        }),
      decisionRecipients: async () =>
        await Promise.resolve({ ok: true, value: [] }),
      readAttachment: async () =>
        await Promise.resolve({ ok: true, value: new Uint8Array() }),
    },
    async (call: string) =>
      await Promise.resolve(new Map<string, Settled<never>>().get(call)),
    // Every call admitted: a lineage's host calls aren't this test's.
    async () => {
      await Promise.resolve();
    }
  );
  const runHost: RunHostCalls = {
    do: async (_name, _options, fn) => ({ ok: true, value: await fn(attempt) }),
    sleep: async () => await Promise.resolve({ ok: true, value: null }),
    waitForDecision: async () =>
      await Promise.resolve({ ok: true, value: null }),
  };
  let sessionOpen = true;
  const host = sessionRunHost(runHost, {
    live: () => sessionOpen,
    ended: Promise.resolve(null),
  });
  let keptA: unknown;
  const own = await host.do("a", {}, async (passed) => {
    keptA = passed;
    return await callModelOf(passed);
  });
  const lateFromA = await host.do(
    "b",
    {},
    async () => await callModelOf(keptA)
  );
  const afterGivingUp = await host.do("c", {}, async (passed) => {
    sessionOpen = false;
    return await callModelOf(passed);
  });
  return { own, lateFromA, givenUp: afterGivingUp, reached };
};

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/attempt-liveness") {
      return Response.json(await attemptLiveness());
    }
    if (pathname === "/run-host") {
      return Response.json(
        await runHostCase(env, searchParams.get("case") ?? "")
      );
    }
    if (pathname === "/run") {
      const outcome = await run(
        env,
        searchParams.get("case") ?? "",
        searchParams.get("owner") ?? "app-stand-in",
        searchParams.get("parent") ?? undefined,
        searchParams.has("memory")
          ? Number(searchParams.get("memory"))
          : undefined
      );
      // Long enough for what the isolate left behind to try its capability.
      await scheduler.wait(800);
      return Response.json({
        ...outcome,
        reachedAfter,
        reachedInternal,
        reachedAfterGivingUp,
        pinged,
        nestedRan,
        nestedRefused,
        refusedVerdict,
        logged,
      });
    }
    return new Response("core answers");
  },
} satisfies ExportedHandler<StandInEnv>;
