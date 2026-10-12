import {
  capability,
  functionCapability,
  runInSession,
  sandboxVerdictOf,
} from "../../src/sandbox-session.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";

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

/** The capability each case gets: what core's would do, and counted. */
const probe = {
  ping: (value: unknown): unknown => {
    // 5 and 6 are what an isolate sends once its call is over.
    if (!open || value === 5 || value === 6) {
      reachedAfter += 1;
    }
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
  body: string;
  cpuMs?: number;
  wallMs?: number;
  /** The methods the isolate is given, if not {@link given}. */
  methods?: string[];
  lingerMs?: number;
  abortAfterMs?: number;
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
  cancelled: {
    body: "return await probe.slow(60_000);",
    wallMs: 120_000,
    abortAfterMs: 300,
  },
  // Longer than a session waits for its owner's room (3 s).
  holds: { body: "return await probe.slow(6000);", wallMs: 20_000 },
};

const run = async (env: StandInEnv, name: string, owner: string) => {
  const chosen = cases[name];
  if (chosen === undefined) {
    return { status: "unknown" };
  }
  logged = [];
  reachedAfter = 0;
  reachedInternal = 0;
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
      env.SANDBOX_HOST,
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
      { signal: cancel.signal }
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
        logged,
      });
    }
    return new Response("core answers");
  },
} satisfies ExportedHandler<StandInEnv>;
