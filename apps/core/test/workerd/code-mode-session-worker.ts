import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { codeRuntime, describeRun, runCode } from "../../src/code-mode.ts";
import { sessionHost } from "../../src/sandboxed.ts";

// Code Mode on the on-prem sandbox (scripts/workerd-sandbox-code-mode.test.ts):
// the same `runCode` core runs, with `SANDBOX_HOST` bound to the sandbox
// supervisor as on-prem binds it, so each run is a sandbox session and its
// APIs reach this Worker through it.

/** Calls the API took, across every case. */
let calls = 0;

/** An API the code is given, as core gives its APIs: a loopback stub. */
export class Caps extends WorkerEntrypoint {
  // oxlint-disable-next-line class-methods-use-this -- an RPC method, called on the entrypoint
  async double(value: number): Promise<number> {
    calls += 1;
    await scheduler.wait(1);
    return value * 2;
  }
}

interface StandInEnv {
  LOADER: WorkerLoader;
  RUNTIME_PROFILE: string;
  SANDBOX_HOST: Fetcher;
}

const cases: Record<
  string,
  {
    code: string;
    timeoutMs?: number;
    cancelAfterMs?: number;
    /** Whether the deployment binds no sandbox, as one off Cloudflare may. */
    misconfigured?: boolean;
  }
> = {
  complete: {
    code: "export default async (self, env) => { console.log('working'); return (await env.caps.double(2)) + (await env.caps.double(3)); };",
  },
  noSuchApi: { code: "export default async (self, env) => env.mail.send();" },
  objectMethod: {
    code: "export default async (self, env) => env.caps.hasOwnProperty('double');",
  },
  misconfigured: {
    code: "export default async () => 1;",
    misconfigured: true,
  },
  busy: { code: "export default async () => { for (;;) {} };" },
  throws: { code: "export default async () => { throw new Error('nope'); };" },
  syntax: { code: "export default async () => {" },
  cancelled: {
    code: "export default async () => { await scheduler.wait(60_000); };",
    cancelAfterMs: 300,
  },
  waitsPastItsTime: {
    code: "export default async () => { await scheduler.wait(60_000); };",
    timeoutMs: 1000,
  },
};

/** Whether `value` is a stub a loaded Worker can be given in its env. */
const isFetcher = (value: unknown): value is Fetcher =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  "fetch" in value;

/** A loopback stub of {@link Caps}, as core makes its APIs' stubs. */
const api = (): Fetcher => {
  const make: unknown = Reflect.get(exports, "Caps");
  const stub: unknown =
    typeof make === "function" ? Reflect.apply(make, exports, [{}]) : undefined;
  if (!isFetcher(stub)) {
    throw new TypeError("This Worker exports no Caps");
  }
  return stub;
};

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname !== "/run") {
      return new Response("core answers");
    }
    const chosen = cases[searchParams.get("case") ?? ""];
    if (chosen === undefined) {
      return new Response("no such case", { status: 404 });
    }
    calls = 0;
    const streamed: string[] = [];
    const started = Date.now();
    const cancel = new AbortController();
    if (chosen.cancelAfterMs !== undefined) {
      setTimeout(() => {
        cancel.abort();
      }, chosen.cancelAfterMs);
    }
    const run = await runCode(
      env.LOADER,
      chosen.code,
      { caps: api() },
      {
        sandbox: () =>
          chosen.misconfigured === true
            ? sessionHost({
                RUNTIME_PROFILE: env.RUNTIME_PROFILE,
                SANDBOX_HOST: undefined,
                SANDBOX_IN_PROCESS: undefined,
              })
            : env.SANDBOX_HOST,
        owner: "person:stand-in",
        signal: cancel.signal,
        ...(chosen.timeoutMs === undefined
          ? {}
          : { timeoutMs: chosen.timeoutMs }),
        onOutput: (line) => {
          streamed.push(line);
        },
      }
    );
    return Response.json({
      status: run.status,
      text: describeRun(run).slice(0, 400),
      ms: Date.now() - started,
      streamed,
      calls,
      runtime: codeRuntime(env),
    });
  },
} satisfies ExportedHandler<StandInEnv>;
