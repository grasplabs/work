import { callSandboxed } from "../../src/sandboxed.ts";
import type { SandboxedEnv } from "../../src/sandboxed.ts";

// App code that throws, in a Loader isolate of core's own
// (`SANDBOX_IN_PROCESS=unbounded`), on plain workerd
// (scripts/workerd-rejected-calls.test.ts). Core goes on after the call
// rejected, as a migration run goes on to its next batch; the test reads
// how the isolate's request ended in workerd's log.

/** How long core goes on after the call: long past the isolate's last event. */
const goOnMs = 500;

/** An App whose method throws, as App code routinely does. */
const throwing = {
  mainModule: "app.js",
  modules: {
    "app.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export class App extends WorkerEntrypoint {
  run() { throw new Error("The App's code refused."); }
}
`,
  },
};

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/call") {
      return new Response("ok");
    }
    let answer = "answered";
    try {
      await callSandboxed(env, throwing, "App", "run");
    } catch (error) {
      answer = error instanceof Error ? error.message : "?";
    }
    await scheduler.wait(goOnMs);
    return new Response(answer);
  },
} satisfies ExportedHandler<SandboxedEnv>;
