import { appModuleName, kitModuleName } from "@grasp-os/compiler";
import { app, defineSchema, defineTable, v } from "@grasp-os/sdk";
import { inspectApp } from "@grasp-os/sdk/host";
import { serverModule } from "@grasp-os/sdk/server";
import { WorkerEntrypoint, exports } from "cloudflare:workers";

import { releaseRunner } from "../../src/app-functions.ts";
import { requestText } from "../../src/app-requests.ts";
import { codeRuntime, describeRun, runCode } from "../../src/code-mode.ts";
import type { OpenStore } from "../../src/data-stores.ts";
import { callOperation } from "../../src/operations.ts";
import { runSessionOf } from "../../src/run-sessions.ts";
import { sessionHost } from "../../src/sandboxed.ts";

// Code Mode on the on-prem sandbox (scripts/workerd-sandbox-code-mode.test.ts):
// the same `runCode` core runs, with `SANDBOX_HOST` bound to the sandbox
// supervisor as on-prem binds it, so each run is a sandbox session and its
// APIs reach this Worker through it.

/** Calls the API took, across every case. */
let calls = 0;

interface StandInEnv {
  LOADER: WorkerLoader;
  RUNTIME_PROFILE: string;
  SANDBOX_HOST: Fetcher;
}

// An App with one action, its code the isolate's: as core runs a sealed
// release's functions (app-functions.ts), here with a runner of its own.
const schema = defineSchema({ notes: defineTable({ title: v.string() }) });
const { action } = serverModule(schema);
const { manifest } = inspectApp(
  app({
    name: "Jobs",
    schema,
    access: { tables: { notes: { read: "owner", write: "owner" } } },
    operations: {
      jobs: {
        echo: action({
          args: { n: v.number() },
          returns: v.object({ n: v.number() }),
          handler: (_ctx, args) => args,
        }),
      },
    },
    screens: [],
    uses: [],
  })
);
const release = {
  modules: {
    [appModuleName("app.ts")]:
      'export default { "jobs.echo": async (channel, args) => ({ n: args.n + 1 }) };',
  },
  sdk: {
    [kitModuleName("@grasp-os/sdk/runner")]:
      "export const runFunction = async (registered, path, args, channel) => await registered[path](channel, args);",
  },
};

/** An action has no store: any use of it is a fault. */
const noStore = new Proxy(
  {},
  {
    get: () => {
      throw new Error("An action has no store.");
    },
  }
);

/** An API the code is given, as core gives its APIs: a loopback stub. */
export class Caps extends WorkerEntrypoint<StandInEnv, { runId: string }> {
  // oxlint-disable-next-line class-methods-use-this -- an RPC method, called on the entrypoint
  async double(value: number): Promise<number> {
    calls += 1;
    await scheduler.wait(1);
    return value * 2;
  }

  /** As `AppsApi.call` takes an App call: its request, a stream of JSON. */
  // oxlint-disable-next-line class-methods-use-this -- an RPC method, called on the entrypoint
  async call(_app: unknown, request: unknown): Promise<unknown> {
    const parsed: unknown = JSON.parse(await requestText(request));
    return parsed;
  }

  /**
   * Calls the App's action, as `AppsApi.call` does (callAppFunction), in
   * a child of the calling run's session.
   */
  async callsFunction(): Promise<unknown> {
    const parentSession = runSessionOf(this.ctx.props.runId);
    const result = await callOperation(
      { manifest, run: releaseRunner(this.env, release, "app-jobs") },
      {
        principal: "person-stand-in",
        consumer: { resourceId: "app-jobs", resourceVersion: 1 },
        // SAFETY: an action never reaches its store; any use throws.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        store: noStore as OpenStore,
        requestId: crypto.randomUUID(),
        deadline: Date.now() + 20_000,
        runId: null,
        authorize: async () =>
          await Promise.resolve({ appMember: true, appBuilder: false }),
      },
      { path: "jobs.echo", kind: "action" },
      { n: 1 },
      parentSession === undefined ? {} : { parentSession }
    );
    return result;
  }
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
    code: "export default async (self, env) => { console.log('working'); return (await env.apps.double(2)) + (await env.apps.double(3)); };",
  },
  noSuchApi: { code: "export default async (self, env) => env.mail.send();" },
  objectMethod: {
    code: "export default async (self, env) => env.apps.hasOwnProperty('double');",
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
  // An App call, its request a stream, as AppsApi.call documents it.
  streamedRequest: {
    code: "export default async (self, env) => await env.apps.call('app', new Blob([JSON.stringify({ reference: { kind: 'query' }, input: { n: 1 } })]).stream());",
  },
  tooLargeRequest: {
    code: "export default async (self, env) => await env.apps.call('app', new Blob(['x'.repeat(140_000)]).stream());",
  },
  // A stream where the API takes none: only an App call's request is one.
  streamElsewhere: {
    code: "export default async (self, env) => await env.apps.double(new Blob(['2']).stream());",
  },
  callsFunction: {
    code: "export default async (self, env) => await env.apps.callsFunction();",
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
const api = (runId: string): Fetcher => {
  const make: unknown = Reflect.get(exports, "Caps");
  const stub: unknown =
    typeof make === "function"
      ? Reflect.apply(make, exports, [{ props: { runId } }])
      : undefined;
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
    const runId = crypto.randomUUID();
    const run = await runCode(
      env.LOADER,
      chosen.code,
      { apps: api(runId) },
      {
        sessionKey: runId,
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
