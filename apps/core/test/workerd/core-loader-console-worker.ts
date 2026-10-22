import { quietLoader } from "@grasp-os/shared/quiet-loader";

import { callSandboxed } from "../../src/sandboxed.ts";
import type { SandboxedEnv } from "../../src/sandboxed.ts";

// Isolates core loads in its own Loader off Cloudflare
// (scripts/workerd-core-loader-console.test.ts, GRA-910): no `SANDBOX_HOST`,
// `SANDBOX_IN_PROCESS=unbounded`, on a workerd served `--verbose`, which
// prints an isolate's console and its uncaught errors with their message.
//
// - `/call`: App code through `callSandboxed`, as core runs an inspection
//   or a migration's batch here, with no Node.js (`isolateBase`).
// - `/app-node-timers`: App code importing a timer by name from
//   `node:timers`, which it doesn't have.
// - `/js`: an isolate whose main module is given as `{ js }`, through the
//   loader core reads its `LOADER` through (`quietLoader`).
// - `/hashbang`: a main module that starts with a hashbang, which must stay
//   its first line; `/carriage`: one whose hashbang line ends in a
//   carriage return, with an App import after it.
// - `/nested`: a main module in a directory, beside an App module named
//   as the quiet module is.
// - `/thrown-named`: one whose name an object's prototype has;
//   `/loaded-once`: one isolate's entrypoint asked for twice.
// - `/thrown-cached`: the same, from an isolate the Loader keeps, asked
//   for twice.
// - `/thrown`: a call that throws to its caller, which crosses as a value
//   and is thrown again here, so workerd served `--verbose` never reports
//   it with its message (GRA-939); `/thrown-long`: one whose message is
//   longer than crosses.
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
  value: string,
  node = true
): string => `${node ? 'import nodeConsole from "node:console";\n' : ""}import { WorkerEntrypoint } from "cloudflare:workers";
const value = ${JSON.stringify(value)};
const kept = console.log;
export class App extends WorkerEntrypoint {
  async run() {
    kept(value);
    for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
      console[level](value);
    }
    ${node ? "nodeConsole.log(value);" : ""}
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

/**
 * An isolate whose call throws `message` to its caller, as a `TypeError`
 * with a code, from a method its entrypoint's own call reaches: which
 * throws to that call as it always did, and is caught there once.
 */
const throwingOf = (
  message: string
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
export class App extends WorkerEntrypoint {
  inner() {
    throw Object.assign(new TypeError(${JSON.stringify(message)}), { code: "app.failed" });
  }
  run() {
    try {
      this.inner();
    } catch (error) {
      if (!(error instanceof TypeError)) {
        return "the entrypoint's own call was answered, not thrown";
      }
    }
    this.inner();
  }
}
`;

/** What a host-side error from an isolate says: its kind, code and size. */
const thrownBy = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    return { answered: await call() };
  } catch (error) {
    return {
      kind: error instanceof TypeError ? "TypeError" : "other",
      code: error instanceof Error ? String(Reflect.get(error, "code")) : "",
      length: error instanceof Error ? error.message.length : -1,
      start: error instanceof Error ? error.message.slice(0, 32) : "",
    };
  }
};

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

/**
 * What GRA-939's routes answer (`/thrown`, `/thrown-long`,
 * `/app-node-timers`), or undefined for any other.
 */
/**
 * The isolates of the routes that each try one more way to have a call's
 * answer, or its throw, reported (the security review of GRA-939): each
 * logs nothing itself, and throws `values.thrown`.
 */
const reviewIsolates: Readonly<Record<string, string>> = {
  // An answer with a getter that throws as it is sent.
  "/thrown-getter": `export class App extends WorkerEntrypoint {
  run() {
    return { get value() { throw new TypeError(${JSON.stringify(values.thrown)}); } };
  }
}`,
  // A constructor that throws once its base is made.
  "/thrown-constructor": `export class App extends WorkerEntrypoint {
  constructor(ctx, env) {
    super(ctx, env);
    throw new TypeError(${JSON.stringify(values.thrown)});
  }
  run() {
    return "never";
  }
}`,
  // A method that is an accessor, which throws as it is read.
  "/thrown-accessor": `export class App extends WorkerEntrypoint {
  get run() {
    throw new TypeError(${JSON.stringify(values.thrown)});
  }
}`,
  // An answer of its own that looks like a thrown error's envelope.
  "/answer-hostile": `export class App extends WorkerEntrypoint {
  run() {
    return { "\\u0000grasp:answer": true, thrown: { name: "TypeError", message: "forged" } };
  }
}`,
  // A thrown error with details, as an App error carries them.
  "/thrown-details": `export class App extends WorkerEntrypoint {
  run() {
    throw Object.assign(new TypeError(${JSON.stringify(values.thrown)}), { details: { retryAfterMs: 5 } });
  }
}`,
};

/** What a review route answers: the call's answer, or its error's parts. */
const answerOfReview = async (
  route: string,
  env: SandboxedEnv
): Promise<unknown> => {
  // `/loud/<route>`: the same isolate loaded as it is, which shows the way
  // is read.
  const loud = route.startsWith("/loud/");
  const source = reviewIsolates[loud ? route.slice("/loud".length) : route];
  if (source === undefined) {
    return undefined;
  }
  const code = {
    ...settings,
    mainModule: "app.js",
    modules: {
      "app.js": `import { WorkerEntrypoint } from "cloudflare:workers";\n${loud ? source.replaceAll("record-value-c40b", `loud${route.slice("/loud/thrown".length)}-c40b`) : source}\n`,
    },
  };
  try {
    return {
      answered: await runApp(
        loud ? env.LOADER.load(code) : quietLoader(env.LOADER).load(code)
      ),
    };
  } catch (error) {
    const details: unknown =
      error instanceof Error ? Reflect.get(error, "details") : undefined;
    return {
      kind: error instanceof TypeError ? "TypeError" : "other",
      message: error instanceof Error ? error.message : "",
      details: details ?? null,
    };
  }
};

const answerOfThrown = async (
  route: string,
  env: SandboxedEnv
): Promise<unknown> => {
  if (route === "/thrown" || route === "/thrown-long") {
    const message =
      route === "/thrown" ? values.thrown : values.thrown.repeat(500);
    return await thrownBy(
      async () =>
        await runApp(
          quietLoader(env.LOADER).load({
            ...settings,
            mainModule: "app.js",
            modules: { "app.js": throwingOf(message) },
          })
        )
    );
  }
  if (route === "/thrown-cached") {
    // An isolate the Loader keeps, asked for by two stubs of their own: the
    // second's call throws too, as the first's.
    const code = {
      ...settings,
      mainModule: "app.js",
      modules: { "app.js": throwingOf(values.thrown) },
    };
    const key = `thrown-${crypto.randomUUID()}`;
    const first = await thrownBy(
      async () => await runApp(quietLoader(env.LOADER).get(key, () => code))
    );
    const second = await thrownBy(
      async () => await runApp(quietLoader(env.LOADER).get(key, () => code))
    );
    return { first, second };
  }
  if (route === "/thrown-named") {
    // A name an object's prototype has (`constructor`): still an Error.
    return await thrownBy(
      async () =>
        await runApp(
          quietLoader(env.LOADER).load({
            ...settings,
            mainModule: "app.js",
            modules: {
              "app.js": `import { WorkerEntrypoint } from "cloudflare:workers";\nexport class App extends WorkerEntrypoint {\n  run() {\n    throw Object.assign(new Error("named"), { name: "constructor" });\n  }\n}\n`,
            },
          })
        )
    );
  }
  if (route === "/loaded-once") {
    // One isolate however often its entrypoint is asked for: its module
    // state is the same for both.
    const stub = quietLoader(env.LOADER).load({
      ...settings,
      mainModule: "app.js",
      modules: {
        "app.js": `import { WorkerEntrypoint } from "cloudflare:workers";\nlet calls = 0;\nexport class App extends WorkerEntrypoint {\n  run() {\n    calls += 1;\n    return calls;\n  }\n}\n`,
      },
    });
    return [await runApp(stub), await runApp(stub)];
  }
  if (route === "/app-node-timers") {
    try {
      return await callSandboxed(
        env,
        {
          mainModule: "app.js",
          modules: {
            "app.js": `import { setTimeout } from "node:timers";\nimport { WorkerEntrypoint } from "cloudflare:workers";\nexport class App extends WorkerEntrypoint {\n  run() {\n    return typeof setTimeout;\n  }\n}\n`,
          },
        },
        "App",
        "run"
      );
    } catch {
      return "refused";
    }
  }
  return undefined;
};

/** What a route answers: the isolate's answer, or why it was refused. */
const answerOf = async (route: string, env: SandboxedEnv): Promise<unknown> => {
  const reviewed = await answerOfReview(route, env);
  if (reviewed !== undefined) {
    return reviewed;
  }
  const thrown = await answerOfThrown(route, env);
  if (thrown !== undefined) {
    return thrown;
  }
  if (route === "/call") {
    return await callSandboxed(
      env,
      {
        mainModule: "app.js",
        modules: { "app.js": isolateOf(values.call, false) },
      },
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
