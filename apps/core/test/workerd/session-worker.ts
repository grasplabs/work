import { heldPool } from "@grasp-os/shared/rpc-accounting";

import type { NestedCall, NestedRun } from "../../src/sandbox-session.ts";
import {
  capability,
  functionCapability,
  runInSession,
  sandboxVerdictOf,
} from "../../src/sandbox-session.ts";
import {
  sandboxDeadlineHeader,
  SandboxUnavailableError,
} from "../../src/sandboxed.ts";

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
  /** Not one the isolate is given: never reached. */
  internal: (): string => {
    reachedInternal += 1;
    return "internal";
  },
};

/** The methods the isolate gets: all but `internal`. */
const given = ["ping", "slow", "withCallback"];

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
    drain: async () => {
      // One past what a session runs: the call itself, and 64 nested.
      for (let index = 0; index < 65; index += 1) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one after the other
          await nested?.(trivial);
          nestedRan += 1;
        } catch {
          nestedRefused += 1;
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

const run = async (env: StandInEnv, name: string, owner: string) => {
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
      ms: Date.now() - started,
    };
  } finally {
    open = false;
  }
};

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/run") {
      const outcome = await run(
        env,
        searchParams.get("case") ?? "",
        searchParams.get("owner") ?? "app-stand-in"
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
        logged,
      });
    }
    return new Response("core answers");
  },
} satisfies ExportedHandler<StandInEnv>;
