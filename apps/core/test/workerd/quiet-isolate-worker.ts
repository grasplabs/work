import { quietModules } from "../../src/on-prem/quiet-isolate.ts";

// The sandbox host's quiet module on a workerd served `--verbose`, which
// prints an isolate's uncaught errors with their message
// (scripts/workerd-sandbox-console.test.ts): the same isolate loaded as it
// is (`/loud`, the control, showing workerd prints what it logs) and as
// the sandbox host loads it (`/quiet`, through `quietModules`).

interface QuietEnv {
  LOADER: WorkerLoader;
}

/** What the isolate logs and throws, loaded as it is. */
const loudValue = "loud-value-2d7a";

/** What the isolate logs and throws, loaded as the sandbox host loads it. */
const quietValue = "quiet-value-e93f";

/** An isolate that logs `value` to stderr and leaves errors uncaught. */
const isolateOf = (
  value: string
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
const value = ${JSON.stringify(value)};
export class App extends WorkerEntrypoint {
  async run() {
    console.error(value);
    Promise.reject(new Error(value));
    queueMicrotask(() => {
      throw new Error(value);
    });
    await scheduler.wait(50);
    return value;
  }
}
`;

/** Runs the isolate of `value`, its modules quieted or as they are. */
const runIsolate = async (
  env: QuietEnv,
  value: string,
  quiet: boolean
): Promise<unknown> => {
  const modules = { "app.js": isolateOf(value) };
  const stub = env.LOADER.get(value, () => ({
    compatibilityDate: "2026-09-15",
    mainModule: "app.js",
    modules: quiet ? quietModules("app.js", modules) : modules,
    env: {},
    globalOutbound: null,
  })).getEntrypoint("App");
  const run: unknown = Reflect.get(stub, "run");
  return typeof run === "function" ? await Reflect.apply(run, stub, []) : null;
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/loud" || pathname === "/quiet") {
      const quiet = pathname === "/quiet";
      const value = quiet ? quietValue : loudValue;
      const answered = await runIsolate(env, value, quiet);
      return Response.json({ answered, value });
    }
    return new Response("ok");
  },
} satisfies ExportedHandler<QuietEnv>;
