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
// - `/hashbang`: a main module that starts with a hashbang, which must stay
//   its first line; `/carriage`: one whose hashbang line ends in a
//   carriage return, with an App import after it.
// - `/nested`: a main module in a directory, beside an App module named
//   as the quiet module is.
// - `/thrown`: a call that throws to its caller, which workerd served
//   `--verbose` reports with its message (GRA-939).
// - `/cjs`: a main module that can't import the quiet module first.
// - `/control`: the same code in the Loader as it is, which shows workerd's
//   output is read at all.

/** What an isolate holds that no log may carry, by route. */
const values = {
  call: "record-value-5c1e",
  js: "record-value-b84d",
  nested: "record-value-3e97",
  carriage: "record-value-71d2",
  thrown: "record-value-c40b",
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
    setTimeout(() => {
      throw new Error(value);
    }, 0);
    const interval = setInterval(() => {
      clearInterval(interval);
      throw new Error(value);
    }, 0);
    reportError(new Error(value));
    await scheduler.wait(50);
    return value;
  }
}
`;

/** An isolate whose call throws `value` to its caller. */
const throwingOf = (
  value: string
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
export class App extends WorkerEntrypoint {
  run() {
    throw new Error(${JSON.stringify(value)});
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

/**
 * The ways an isolate's code can have workerd served `--verbose` report an
 * error with its message, each its own isolate (`/path/<name>`), the
 * value its route's name.
 */
const paths: Readonly<Record<string, (value: string) => string>> = {
  setImmediate: (value) => `setImmediate(() => {
      throw new Error(${JSON.stringify(value)});
    });`,
  nodeSetTimeout: (value) => `nodeTimers.setTimeout(() => {
      throw new Error(${JSON.stringify(value)});
    }, 0);`,
  nodeSetImmediate: (value) => `nodeTimers.setImmediate(() => {
      throw new Error(${JSON.stringify(value)});
    });`,
  nodeNamedSetTimeout: (value) => `namedSetTimeout(() => {
      throw new Error(${JSON.stringify(value)});
    }, 0);`,
  waitUntil: (value) =>
    `this.ctx.waitUntil(Promise.reject(new Error(${JSON.stringify(value)})));`,
};

/** An isolate that does what path `name` does with `value`, then answers. */
const pathIsolateOf = (
  name: string,
  value: string
): string => `import nodeTimers, { setTimeout as namedSetTimeout } from "node:timers";
import { WorkerEntrypoint } from "cloudflare:workers";
export class App extends WorkerEntrypoint {
  async run() {
    ${paths[name]?.(value) ?? ""}
    await scheduler.wait(50);
    return ${JSON.stringify(value)};
  }
}
`;

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
        // A name a module given as text couldn't have: `{ js }` must stay.
        mainModule: "app.mjs",
        modules: { "app.mjs": { js: isolateOf(values.js) } },
      })
    );
  }
  const path = /^\/(?<loud>loud-)?path(?<half>-half)?\/(?<name>\w+)$/u.exec(
    route
  )?.groups;
  if (path?.name !== undefined && Object.hasOwn(paths, path.name)) {
    const value = `${path.loud === undefined ? "quiet" : "loud"}-${path.name}${path.half ?? ""}-6d1f`;
    const code = {
      ...settings,
      // No `nodejs_compat`: its date gives the isolate `node:` modules, and
      // turning off only `no_nodejs_compat`'s half leaves `node:timers`.
      compatibilityFlags: path.half === undefined ? [] : ["no_nodejs_compat"],
      mainModule: "app.js",
      modules: { "app.js": pathIsolateOf(path.name, value) },
    };
    return await runApp(
      path.loud === undefined
        ? quietLoader(env.LOADER).load(code)
        : env.LOADER.load(code)
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
  if (route === "/nested") {
    // App modules named as the quiet module is, beside a main in a
    // directory and at the top: neither takes the quiet module's place.
    return await runApp(
      quietLoader(env.LOADER).load({
        ...settings,
        mainModule: "src/app.js",
        modules: {
          // The App's own module of that name, imported by its main: kept,
          // and silenced like any other.
          "src/app.js": `import { ownModule } from "./grasp-sandbox-quiet.js";\nif (ownModule !== true) throw new Error("not kept");\n${isolateOf(values.nested)}`,
          "src/grasp-sandbox-quiet.js": `console.log(${JSON.stringify(values.nested)});\nexport const ownModule = true;`,
          "grasp-sandbox-quiet.js": "export {};",
        },
      })
    );
  }
  if (route === "/carriage") {
    // A hashbang line ended by a carriage return, an App import after it:
    // the quiet import still comes before that import.
    return await runApp(
      quietLoader(env.LOADER).load({
        ...settings,
        mainModule: "app.js",
        modules: {
          "app.js": `#!x\rimport "./early.js";\n${isolateOf(values.carriage)}`,
          "early.js": `console.log(${JSON.stringify(values.carriage)});`,
        },
      })
    );
  }
  if (route === "/thrown") {
    try {
      return await runApp(
        quietLoader(env.LOADER).load({
          ...settings,
          mainModule: "app.js",
          modules: { "app.js": throwingOf(values.thrown) },
        })
      );
    } catch {
      return "threw";
    }
  }
  if (route === "/hashbang") {
    return await runApp(
      quietLoader(env.LOADER).load({
        ...settings,
        mainModule: "app.js",
        modules: { "app.js": `#!/usr/bin/env node\n${isolateOf(values.js)}` },
      })
    );
  }
  if (route !== "/control") {
    // workerd's readiness probe, and anything else: no isolate.
    return null;
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
