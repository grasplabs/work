import { appModuleName, kitModuleName } from "@grasp-os/compiler";
import type { OperationChannel } from "@grasp-os/sdk/runner";

import { releaseRunner } from "../../src/app-functions.ts";
import { SandboxUnavailableError } from "../../src/sandboxed.ts";

// An App's functions on plain workerd (scripts/workerd-sandbox-functions.test.ts):
// the same runner core runs a sealed release's functions with, with
// `SANDBOX_HOST` bound to the sandbox supervisor as on-prem binds it.

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
const app = `export default {
  echo: async (channel, args) => ({ args, read: await channel.read({ table: "items" }) }),
  busy: async () => { for (;;) {} },
  waits: async () => { await scheduler.wait(60000); return "late"; },
};`;

/** The operation channel the host would open: its reads answer this. */
const channel: OperationChannel = {
  read: async () => await Promise.resolve({ rows: ["one"] }),
  write: async () => await Promise.resolve(null),
  call: async () => await Promise.resolve(null),
  resource: async () => await Promise.resolve(null),
};

/** What its config binds: no Loader, as on-prem runs functions in sessions. */
interface StandInEnv {
  LOADER: WorkerLoader;
  RUNTIME_PROFILE: string;
  SANDBOX_HOST: Fetcher;
}

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname !== "/run") {
      return new Response("core answers");
    }
    const run = releaseRunner(
      env,
      {
        modules: { [appModuleName("app.ts")]: app },
        sdk: { [kitModuleName("@grasp-os/sdk/runner")]: runner },
      },
      "app-stand-in"
    );
    const started = Date.now();
    // As the host stops waiting past the invocation's deadline (operations.ts).
    const deadline = new AbortController();
    const stopAfter = Number(searchParams.get("stopAfter") ?? "0");
    if (stopAfter > 0) {
      setTimeout(() => {
        deadline.abort(new Error("past its deadline"));
      }, stopAfter);
    }
    try {
      const value = await run(
        searchParams.get("path") ?? "",
        { n: 1 },
        channel,
        deadline.signal
      );
      return Response.json({ status: "ok", value, ms: Date.now() - started });
    } catch (error) {
      return Response.json({
        status:
          error instanceof SandboxUnavailableError ? "unavailable" : "refused",
        message: error instanceof Error ? error.message : String(error),
        ms: Date.now() - started,
      });
    }
  },
} satisfies ExportedHandler<StandInEnv>;
