import { quietLoader } from "../../src/quiet-loader.ts";
import { callSandboxed } from "../../src/sandboxed.ts";
import type { SandboxedEnv } from "../../src/sandboxed.ts";

// Isolates core loads in its own Loader off Cloudflare
// (scripts/workerd-core-loader-console.test.ts, GRA-910): no `SANDBOX_HOST`,
// `SANDBOX_IN_PROCESS=unbounded`, on a workerd served `--verbose`, which
// prints an isolate's console and its uncaught errors with their message.
//
// - `/call`: App code through `callSandboxed`, as core runs an inspection
//   or a migration's batch here.
// - `/js`: an isolate whose main module is given as `{ js }`, through the
//   loader core reads its `LOADER` through (`quietLoader`).
// - `/cjs`: a main module that can't import the quiet module first.
// - `/control`: the same code in the Loader as it is, which shows workerd's
//   output is read at all.

/** What an isolate holds that no log may carry, by route. */
const values = {
  call: "record-value-5c1e",
  js: "record-value-b84d",
  control: "control-value-0a6f",
} as const;

/**
 * An isolate that logs `value` every way it can (each console method, one
 * kept as the module loads, `node:console`, one it puts back) and leaves
 * an error and a rejection uncaught, then answers with it.
 */
const isolateOf = (
  value: string
): string => `import nodeConsole from "node:console";
import { WorkerEntrypoint } from "cloudflare:workers";
const value = ${JSON.stringify(value)};
const kept = console.log;
export class App extends WorkerEntrypoint {
  async run() {
    kept(value);
    for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
      console[level](value);
    }
    nodeConsole.log(value);
    console.log = (...args) => console.error(...args);
    console.log(value);
    Promise.reject(new Error(value));
    queueMicrotask(() => {
      throw new Error(value);
    });
    await scheduler.wait(50);
    return value;
  }
}
`;

const settings = {
  compatibilityDate: "2026-09-15",
  compatibilityFlags: ["nodejs_compat"],
  env: {},
  globalOutbound: null,
};

/** What `run` of the App entrypoint of `stub` answers. */
const runApp = async (stub: WorkerStub): Promise<unknown> => {
  const entry = stub.getEntrypoint("App");
  const run: unknown = Reflect.get(entry, "run");
  return typeof run === "function" ? await Reflect.apply(run, entry, []) : null;
};

/** What a route answers: the isolate's answer, or why it was refused. */
const answerOf = async (route: string, env: SandboxedEnv): Promise<unknown> => {
  if (route === "/call") {
    return await callSandboxed(
      env,
      { mainModule: "app.js", modules: { "app.js": isolateOf(values.call) } },
      "App",
      "run"
    );
  }
  if (route === "/js") {
    return await runApp(
      quietLoader(env.LOADER).load({
        ...settings,
        mainModule: "app.js",
        modules: { "app.js": { js: isolateOf(values.js) } },
      })
    );
  }
  if (route === "/cjs") {
    try {
      quietLoader(env.LOADER).load({
        ...settings,
        mainModule: "app.cjs",
        modules: { "app.cjs": { cjs: "module.exports = {};" } },
      });
      return "loaded";
    } catch (error) {
      return error instanceof TypeError ? "refused" : "failed";
    }
  }
  return await runApp(
    env.LOADER.load({
      ...settings,
      mainModule: "app.js",
      modules: { "app.js": isolateOf(values.control) },
    })
  );
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const answered = await answerOf(pathname, env);
    return Response.json({ answered, values });
  },
} satisfies ExportedHandler<SandboxedEnv>;
