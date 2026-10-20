import { capability, runInSession } from "../../src/sandbox-session.ts";
import { callSandboxed } from "../../src/sandboxed.ts";
import type { SandboxedEnv } from "../../src/sandboxed.ts";

// Isolates logging what they hold on the on-prem sandbox
// (scripts/workerd-sandbox-console.test.ts): a stand-in core, with
// `SANDBOX_HOST` bound to the sandbox supervisor as on-prem binds it, runs
// one isolate each way core runs one there: as a call (`callSandboxed`,
// server functions, inspections, builds) and as a session that reaches
// back through a capability (`runInSession`, workflows, actions, Code
// Mode). Each answers with what it logged, which no log may carry.

interface StandInEnv extends SandboxedEnv {
  SANDBOX_HOST: Fetcher;
}

/** What the call's isolate holds and logs. */
const callValue = "call-value-4b2e";

/** What the session's isolate holds and logs. */
const sessionValue = "session-value-c81d";

/**
 * An isolate that logs `value` every way it can: each console method, a
 * console method it kept as it loaded, `node:console`, a console method it
 * puts back itself, a rejection nothing handles and an error thrown in a
 * microtask. Then it answers with `value`, through `probe` when given.
 */
const loggingModule = (
  value: string
): string => `import nodeConsole from "node:console";
import { WorkerEntrypoint } from "cloudflare:workers";
// Kept as the module loads, to log with later.
const kept = console.log;
const value = ${JSON.stringify(value)};
export class App extends WorkerEntrypoint {
  async run(probe) {
    kept(value);
    console.log(value);
    console.info(value);
    console.warn(value);
    console.error(value);
    console.debug(value);
    console.trace(value);
    console.dir({ value });
    console.table([value]);
    nodeConsole.log(value);
    nodeConsole.error(value);
    console.log = (...args) => console.error(...args);
    console.log(value);
    Promise.reject(new Error(value));
    queueMicrotask(() => {
      throw new Error(value);
    });
    await scheduler.wait(50);
    return probe === undefined ? value : await probe.ping(value);
  }
}
`;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/call") {
      const answered = await callSandboxed(
        env,
        {
          mainModule: "app.js",
          modules: { "app.js": loggingModule(callValue) },
        },
        "App",
        "run"
      );
      return Response.json({ answered, value: callValue });
    }
    if (pathname === "/session") {
      const answered = await runInSession(env.SANDBOX_HOST, {
        mainModule: "app.js",
        modules: { "app.js": loggingModule(sessionValue) },
        entrypoint: "App",
        method: "run",
        args: [
          {
            capability: capability(
              { ping: (value: unknown): unknown => value },
              ["ping"]
            ),
          },
        ],
        owner: "app:console",
        cpuMs: 5000,
        wallMs: 10_000,
      });
      return Response.json({ answered, value: sessionValue });
    }
    return new Response("core answers");
  },
} satisfies ExportedHandler<StandInEnv>;
