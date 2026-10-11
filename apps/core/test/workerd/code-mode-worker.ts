import { WorkerEntrypoint, env, exports } from "cloudflare:workers";

import {
  codeLimits,
  codeRuntime,
  cutMarker,
  describeRun,
  runCode,
  utf8Bytes,
} from "../../src/code-mode.ts";
import type { CodeRun } from "../../src/code-mode.ts";

// Code Mode's executor on plain workerd (scripts/workerd-code-mode.ts):
// the same `runCode` core runs, with a Worker Loader and a capability of
// this Worker's own as the code's env, and no Wrangler or Miniflare. Each
// case runs one module and says how it ended; the script checks them.

/** Calls the capability took, across every case. */
let calls = 0;

/** A capability the code is given, as core gives its APIs: a loopback stub. */
export class Caps extends WorkerEntrypoint {
  // oxlint-disable-next-line class-methods-use-this -- an RPC method, called on the entrypoint
  async double(value: number): Promise<number> {
    calls += 1;
    await scheduler.wait(1);
    return value * 2;
  }
}

interface Case {
  code: string;
  timeoutMs?: number;
  /** Cancels the run this long after it starts. */
  cancelAfterMs?: number;
}

const cases: Record<string, Case> = {
  complete: {
    code: "const twice = (env, n) => env.caps.double(n); export default async (self, env, ctx) => ({ self, ctx: Object.keys(ctx), sum: (await Promise.all([twice(env, 1), twice(env, 2)])).reduce((a, b) => a + b, 0) });",
  },
  network: {
    code: "export default async () => (await fetch('https://example.com')).status;",
  },
  syntax: { code: "export default async () => {" },
  notAFunction: { code: "export default 42;" },
  throwsAsItLoads: {
    code: "console.log('loading'); throw new Error('broken module'); export default async () => 1;",
  },
  throws: { code: "export default async () => { throw new Error('nope'); };" },
  oversized: {
    code: `export default async () => 1; // ${"x".repeat(codeLimits.sourceChars)}`,
  },
  neverSettles: {
    code: "export default async () => { await new Promise(() => {}); };",
  },
  waitsPastItsTime: {
    code: "export default async () => { await scheduler.wait(60_000); };",
    timeoutMs: 1000,
  },
  cancelled: {
    code: "export default async () => { await scheduler.wait(60_000); };",
    cancelAfterMs: 300,
  },
  manyLines: {
    code: "export default async () => { for (let i = 0; i < 5000; i++) console.log(i); return 'done'; };",
  },
  flood: {
    code: "export default async () => { for (let i = 0; i < 5000; i++) console.log('é'.repeat(200)); throw new Error('the end'); };",
  },
};

/** Whether `value` is a stub a loaded Worker can be given in its env. */
const isFetcher = (value: unknown): value is Fetcher =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  "fetch" in value;

/** A loopback stub of {@link Caps}, as core makes its APIs' stubs. */
const capability = (): Fetcher => {
  const make: unknown = Reflect.get(exports, "Caps");
  if (typeof make !== "function") {
    throw new TypeError("This Worker exports no Caps");
  }
  const stub: unknown = Reflect.apply(make, exports, [{}]);
  if (!isFetcher(stub)) {
    throw new TypeError("Caps gave no stub");
  }
  return stub;
};

/** One case: how it ended, what the model would read, what streamed. */
const runCase = async ({ code, timeoutMs, cancelAfterMs }: Case) => {
  const cancel = new AbortController();
  if (cancelAfterMs !== undefined) {
    setTimeout(() => {
      cancel.abort();
    }, cancelAfterMs);
  }
  const streamed: string[] = [];
  const started = Date.now();
  const run: CodeRun = await runCode(
    env.LOADER,
    code,
    { caps: capability() },
    {
      signal: cancel.signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      onOutput: (line) => {
        streamed.push(line);
      },
    }
  );
  const text = describeRun(run);
  return {
    status: run.status,
    text: text.slice(0, 400),
    ending: text.slice(-200),
    ms: Date.now() - started,
    bytes: utf8Bytes(text),
    cut: text.includes(cutMarker),
    streamed: streamed.length,
  };
};

export default {
  async fetch(): Promise<Response> {
    const results: Record<string, unknown> = {};
    for (const [name, each] of Object.entries(cases)) {
      // oxlint-disable-next-line no-await-in-loop -- one run at a time, as a chat runs them
      results[name] = await runCase(each);
    }
    return Response.json({
      runtime: codeRuntime({ RUNTIME_PROFILE: "workerd" }),
      calls,
      results,
    });
  },
};
