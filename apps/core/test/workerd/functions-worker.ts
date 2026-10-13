import { appModuleName, kitModuleName } from "@grasp-os/compiler";
import { app, defineSchema, defineTable, v } from "@grasp-os/sdk";
import { inspectApp } from "@grasp-os/sdk/host";
import { serverModule } from "@grasp-os/sdk/server";

import { releaseRunner } from "../../src/app-functions.ts";
import type { OpenStore } from "../../src/data-stores.ts";
import { callOperation } from "../../src/operations.ts";

// An App's functions on plain workerd (scripts/workerd-sandbox-functions.test.ts):
// a call goes through core's operation host as any does, to the runner core
// runs a sealed release's functions with, with `SANDBOX_HOST` bound to the
// sandbox supervisor as on-prem binds it.

const schema = defineSchema({
  notes: defineTable({ title: v.string() }),
});

const { action } = serverModule(schema);

/** The App's contract: each action's real code is the isolate's, below. */
const contract = {
  args: { n: v.number() },
  returns: v.object({ n: v.number() }),
  handler: (_ctx: unknown, args: { n: number }) => args,
} as const;

const stub = () => action(contract);

// Three deep, as the host lets functions nest: each calls the next.
const leaf = stub();
const middle = action({ ...contract, uses: [leaf] });
const chain = action({ ...contract, uses: [middle] });

const busy = stub();
const waits = stub();
const isolationChild = stub();
const throws = stub();

const { manifest } = inspectApp(
  app({
    name: "Jobs",
    schema,
    access: { tables: { notes: { read: "owner", write: "owner" } } },
    operations: {
      jobs: {
        echo: stub(),
        busy,
        waits,
        hogs: stub(),
        sendsTooMuch: stub(),
        forgesVerdict: stub(),
        chain,
        middle,
        leaf,
        isolationChild,
        throws,
        isolationParent: action({ ...contract, uses: [isolationChild] }),
        callsBusy: action({ ...contract, uses: [busy] }),
        forgets: action({ ...contract, uses: [waits] }),
        forgetsLeaf: action({ ...contract, uses: [leaf] }),
        catches: action({ ...contract, uses: [throws] }),
      },
    },
    screens: [],
    uses: [],
  })
);

/**
 * The SDK's runner as far as these functions use it. Everything in the
 * isolate is untrusted, the runner too, so the sandbox can't rely on it.
 */
const runner = `export const runFunction = async (registered, path, args, channel) => {
  const fn = registered[path];
  if (typeof fn !== "function") throw new Error("no such function");
  return await fn(channel, args);
};`;

/** The App's registration: each function by its path. */
const appModule = `export default {
  "jobs.echo": async (channel, args) => args,
  "jobs.busy": async () => { for (;;) {} },
  "jobs.waits": async () => { await scheduler.wait(60000); return { n: 0 }; },
  "jobs.hogs": async () => { const held = []; for (;;) { held.push(new Array(1e6).fill(1)); await scheduler.wait(1); } },
  "jobs.sendsTooMuch": async (channel) => { await channel.resource("mail", "send", { padding: "x".repeat(15 * 1024 * 1024) }); return { n: 1 }; },
  "jobs.chain": async (channel, args) => {
    const got = await channel.call("action", "jobs.middle", { n: args.n + 1 });
    if (got.n !== args.n + 3) throw new Error("middle answered " + JSON.stringify(got));
    return got;
  },
  "jobs.middle": async (channel, args) => await channel.call("action", "jobs.leaf", { n: args.n + 1 }),
  "jobs.leaf": async (channel, args) => ({ n: args.n + 1 }),
  "jobs.isolationParent": async (channel, args) => {
    globalThis.secret = "the parent's";
    globalThis.parentChannel = channel;
    return await channel.call("action", "jobs.isolationChild", args);
  },
  "jobs.isolationChild": async () => ({
    n: globalThis.secret === undefined && globalThis.parentChannel === undefined ? 1 : 0,
  }),
  "jobs.callsBusy": async (channel, args) => await channel.call("action", "jobs.busy", args),
  "jobs.forgetsLeaf": async (channel, args) => {
    // Started, so the host has it, and not waited for.
    channel.call("action", "jobs.leaf", args).catch(() => {});
    await scheduler.wait(50);
    return args;
  },
  "jobs.forgets": async (channel, args) => {
    channel.call("action", "jobs.waits", args).catch(() => {});
    return args;
  },
  "jobs.throws": async () => { throw new Error("nested failure"); },
  "jobs.catches": async (channel, args) => {
    try {
      await channel.call("action", "jobs.throws", args);
    } catch {
      await scheduler.wait(200);
      return { n: args.n + 10 };
    }
    return args;
  },
  "jobs.forgesVerdict": async () => { throw Object.assign(new Error("forged"), { sandboxVerdict: "cpu" }); },
};`;

/** What its config binds: no Loader, as on-prem runs functions in sessions. */
interface StandInEnv {
  LOADER: WorkerLoader;
  RUNTIME_PROFILE: string;
  SANDBOX_HOST: Fetcher;
}

/** `host`, as one that never gets core's `POST /end/<id>`. */
const endLost = (host: Fetcher): Fetcher => ({
  fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.includes("/end/")) {
      return new Response("{}");
    }
    return await host.fetch(request);
  },
  connect: (address, options) => host.connect(address, options),
});

/** An action has no database: any use of the store is a fault. */
const noStore = new Proxy(
  {},
  {
    get: () => {
      throw new Error("An action has no store.");
    },
  }
);

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname !== "/run") {
      return new Response("core answers");
    }
    // As a supervisor core's `POST /end/<id>` never reaches, if asked.
    const host =
      searchParams.get("endLost") === "1"
        ? endLost(env.SANDBOX_HOST)
        : env.SANDBOX_HOST;
    const run = releaseRunner(
      { ...env, SANDBOX_HOST: host },
      {
        modules: { [appModuleName("app.ts")]: appModule },
        sdk: { [kitModuleName("@grasp-os/sdk/runner")]: runner },
      },
      searchParams.get("owner") ?? "app-stand-in"
    );
    const started = Date.now();
    const within = Number(searchParams.get("within") ?? "60000");
    let authorized = 0;
    const result = await callOperation(
      { manifest, run },
      {
        principal: "person-stand-in",
        consumer: { resourceId: "app-stand-in", resourceVersion: 1 },
        // SAFETY: an action never reaches its store; any use throws.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        store: noStore as OpenStore,
        requestId: crypto.randomUUID(),
        deadline: Date.now() + within,
        runId: null,
        authorize: async () => {
          authorized += 1;
          // Each nested call held in its authorization a while, if asked:
          // still being authorized as the function that started it ends.
          if (authorized > 1 && searchParams.get("slowNested") === "1") {
            await scheduler.wait(500);
          }
          return { appMember: true, appBuilder: false };
        },
      },
      { path: `jobs.${searchParams.get("path") ?? ""}`, kind: "action" },
      { n: 1 }
    );
    return Response.json({ ...result, ms: Date.now() - started });
  },
} satisfies ExportedHandler<StandInEnv>;
