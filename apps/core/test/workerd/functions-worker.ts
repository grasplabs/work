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
const stub = () =>
  action({
    args: { n: v.number() },
    returns: v.object({ n: v.number() }),
    handler: (_ctx, args) => args,
  });

const { manifest } = inspectApp(
  app({
    name: "Jobs",
    schema,
    access: { tables: { notes: { read: "owner", write: "owner" } } },
    operations: {
      jobs: {
        echo: stub(),
        busy: stub(),
        waits: stub(),
        hogs: stub(),
        sendsTooMuch: stub(),
        forgesVerdict: stub(),
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
        authorize: async () =>
          await Promise.resolve({ appMember: true, appBuilder: false }),
      },
      { path: `jobs.${searchParams.get("path") ?? ""}`, kind: "action" },
      { n: 1 }
    );
    return Response.json({ ...result, ms: Date.now() - started });
  },
} satisfies ExportedHandler<StandInEnv>;
