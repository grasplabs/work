/**
 * What an isolate on the on-prem sandbox host may print: nothing.
 *
 * On plain workerd, a Loader isolate's console goes to its process's
 * stdout and stderr, which the supervisor (scripts/workerd-sandbox.ts)
 * shares with the deployment's logs: whatever App code logs (a record, a
 * caller's input, another owner's data handed to it) would land there,
 * unbounded and read by whoever reads those logs. On Cloudflare the same
 * output never reaches the deployment's logs either: it is dropped, or,
 * where core names `AppTail` as the isolate's tail (server-logs.ts), it
 * goes bounded to a builder-visible log, never the platform's. So on-prem
 * drops it too (GRA-776), for every isolate the host loads, App and
 * platform code alike: what an isolate needs to say comes back in its
 * answer, and core logs what it decides itself.
 *
 * How: the isolate's main module imports `quietModule` first, from beside
 * itself under a name no module of the isolate has (an import resolves
 * against the importer's name, so no App module can stand in for it), so
 * it is evaluated before any other module of the isolate and no module
 * keeps a console method of its own. It replaces every console method with
 * one that does nothing (`node:console` prints through them, and a method
 * the App puts back can only call the silenced ones), and keeps what the
 * isolate's code leaves uncaught from anything workerd served `--verbose`
 * reports for an isolate: a timer's callback that throws (the global
 * timers, `node:timers`' default export), a promise handed to a
 * `WorkerEntrypoint`'s `this.ctx.waitUntil` that rejects, and any other
 * unhandled rejection or error (`quietErrors`).
 *
 * What it can't stop, workerd served `--verbose` still reports, message
 * and stack: an exception thrown out of an entrypoint's call (an RPC
 * method's, a fetch's), as it hands it to the caller as the call's answer;
 * what the callback of a timer imported by name from `node:timers` throws
 * (the binding is the module's own); and what is handed to the `waitUntil`
 * of any context other than an entrypoint's `this.ctx`, such as the one its
 * constructor is given and keeps, or a default export's handler's (the
 * runtime passes those itself, before anything of the quiet module's can
 * wrap them). Core's and connect's own Loader close the first and the last
 * (quiet-loader.ts) and give App code no Node.js (`isolateBase`, GRA-939).
 * Without `--verbose` none of it is printed. The supervisor refuses `--verbose`
 * (scripts/workerd-sandbox.ts); core loading isolates itself under
 * `SANDBOX_IN_PROCESS=unbounded` can't tell how its process was served, so
 * there not serving it `--verbose` is the operator's rule (GRA-939).
 *
 * One kind of call keeps what it writes, bounded, for whom core says: a
 * draft's sealed preview, whose lines go to the agent's next check of
 * that draft, as `AppTail` hands them over on Cloudflare
 * (server-logs.ts, GRA-689). The only other isolates core gives a tail
 * are a v1 App server's and its draft preview's (app.ts, preview.ts).
 * They never reach this host: on-prem refuses them unless
 * SANDBOX_IN_PROCESS=unbounded, which runs them in core's own Loader with
 * their tail and without the quiet module. The v1 server is being
 * removed (GRA-789). A sealed preview's isolate is loaded with the quiet module
 * recording instead (`capturedModules`): the first `maxCapturedLines`
 * lines of the call, each held to `maxCapturedMessage` characters, with
 * their level and time, still printing nothing. A module of the host's
 * own runs the call's entrypoint and, once it settled, answered or
 * thrown, hands those lines to the sink core passed with it.
 */

/** The quiet module's name: none an App's or the platform's module has. */
export const quietModule = "grasp-sandbox-quiet.js";

/**
 * What a quiet module's isolate is loaded with that changes what it may
 * do: `nodejsCompat`, its `node:` modules, `node:timers` among them.
 */
export interface QuietOptions {
  readonly nodejsCompat?: boolean;
}

/** The compatibility date from which workerd gives isolates `node:` modules. */
const nodejsByDefaultFrom = "2026-08-04";

/**
 * Whether an isolate loaded with `settings` has `node:` modules: asked for
 * (`nodejs_compat`), or by default from {@link nodejsByDefaultFrom} on,
 * unless turned off. `no_nodejs_compat` alone leaves `node:timers` there
 * (its `_v2` half stays on by date), so only both off count as none: a
 * module the quiet module would import that isn't there fails the load,
 * one it doesn't that is there goes unquieted.
 */
export const hasNodeModules = (settings: {
  readonly compatibilityDate: string;
  readonly compatibilityFlags?: readonly string[];
}): boolean => {
  const flags = settings.compatibilityFlags ?? [];
  if (
    flags.includes("no_nodejs_compat") &&
    flags.includes("no_nodejs_compat_v2")
  ) {
    return false;
  }
  return (
    // Only the flags that turn them on: `nodejs_compat_populate_process_env`
    // and its like tune them, and give none by themselves.
    flags.includes("nodejs_compat") ||
    flags.includes("nodejs_compat_v2") ||
    settings.compatibilityDate >= nodejsByDefaultFrom
  );
};

/** The timer functions whose callbacks a quiet module catches. */
const timerNames = '["setTimeout", "setInterval", "setImmediate"]';

/**
 * What both quiet modules do besides the console, so workerd served
 * `--verbose` reports nothing of what the isolate's code leaves uncaught
 * (see GRA-939 for what it still can):
 *
 * - A timer's callback that throws is caught where it runs: the global
 *   timers, and `node:timers`' default export where the isolate has it.
 * - A promise handed to `this.ctx.waitUntil` of a `WorkerEntrypoint` (the
 *   classes core calls) that rejects is caught as it is handed over: the
 *   context's every other property is the runtime's own. Not the context
 *   its constructor is given, which the runtime passes itself.
 * - An unhandled rejection or error has its default prevented.
 *
 * Its imports are the runtime's own modules, which no App's module can
 * stand in for.
 */
const quietErrors = (
  options: QuietOptions
): { imports: string; source: string } => ({
  imports: `import { WorkerEntrypoint as QuietEntrypoint } from "cloudflare:workers";
${options.nodejsCompat === true ? 'import quietNodeTimers from "node:timers";\n' : ""}`,
  source: `const caught = (callback) =>
  typeof callback === "function"
    ? function (...args) {
        try {
          return callback.apply(this, args);
        } catch {
          return undefined;
        }
      }
    : callback;
const quietTimers = (timers) => {
  for (const name of ${timerNames}) {
    const timer = timers[name];
    if (typeof timer === "function") {
      timers[name] = (callback, ...rest) => timer(caught(callback), ...rest);
    }
  }
};
quietTimers(globalThis);
${options.nodejsCompat === true ? "quietTimers(quietNodeTimers);\n" : ""}const quietContext = (ctx) =>
  ctx === null || typeof ctx !== "object"
    ? ctx
    : new Proxy(ctx, {
        get: (target, property) => {
          if (property === "waitUntil") {
            return (promise) =>
              target.waitUntil(Promise.resolve(promise).catch(() => undefined));
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
// The entrypoint's constructor sets its context: it takes the quiet one.
Object.defineProperty(QuietEntrypoint.prototype, "ctx", {
  configurable: true,
  get() {
    return undefined;
  },
  set(ctx) {
    Object.defineProperty(this, "ctx", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: quietContext(ctx),
    });
  },
});
addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});
addEventListener("error", (event) => {
  event.preventDefault();
});
`,
});

/** Every console method silenced, and nothing else left for workerd to report. */
const quietSource = (options: QuietOptions): string => {
  const errors = quietErrors(options);
  return `${errors.imports}const silent = () => undefined;
for (const name of Object.getOwnPropertyNames(console)) {
  if (typeof console[name] === "function") {
    console[name] = silent;
  }
}
${errors.source}`;
};

/** Where a hashbang's line ends: at any line terminator JavaScript has. */
const lineTerminator = /[\r\n\u2028\u2029]/u;

/**
 * A module name in `dir` none of `modules` has, from `name`: `name` itself
 * when it is free, otherwise with a number before its extension. The
 * host's own modules go there, so they never take an App's module's place,
 * and none of the App's takes theirs.
 */
const freeName = (
  modules: Readonly<Record<string, unknown>>,
  dir: string,
  name: string
): string => {
  const stem = name.replace(/\.js$/u, "");
  let candidate = name;
  for (
    let count = 1;
    Object.hasOwn(modules, `${dir}${candidate}`);
    count += 1
  ) {
    candidate = `${stem}-${count}.js`;
  }
  return candidate;
};

/** The directory of module `name`, with its slash: "" at the top. */
const dirOf = (name: string): string =>
  name.slice(0, name.lastIndexOf("/") + 1);

/**
 * `modules` with the quiet module, imported first by `mainModule`. A main
 * module that isn't JavaScript text, or isn't there, is left as it is: the
 * Loader refuses it, and nothing runs.
 */
export const quietModules = <Module>(
  mainModule: string,
  modules: Readonly<Record<string, Module | string>>,
  options: QuietOptions = {}
): Record<string, Module | string> => {
  const main = modules[mainModule];
  if (typeof main !== "string") {
    return { ...modules };
  }
  // A hashbang is allowed only at a module's very start: it stays there,
  // its line ending wherever JavaScript ends one.
  let hashbang = "";
  if (main.startsWith("#!")) {
    const end = main.search(lineTerminator);
    hashbang = end === -1 ? `${main}\n` : main.slice(0, end + 1);
  }
  const rest = main.slice(Math.min(hashbang.length, main.length));
  // Beside the main, so its relative import names this module and no
  // other (an import resolves against the importer's own name), under a
  // name none of the isolate's modules has.
  const dir = dirOf(mainModule);
  const quiet = freeName(modules, dir, quietModule);
  return {
    ...modules,
    [mainModule]: `${hashbang}import ${JSON.stringify(`./${quiet}`)};\n${rest}`,
    [`${dir}${quiet}`]: quietSource(options),
  };
};

/** Most lines a captured call keeps, as a tail keeps of one (server-logs.ts). */
export const maxCapturedLines = 20;

/** Most characters of one captured line, as a tail keeps (server-logs.ts). */
export const maxCapturedMessage = 2000;

/** The levels a captured line has: those a tail keeps. */
const capturedLevels = ["debug", "info", "log", "warn", "error"];

/**
 * The quiet module recording: the levels a tail keeps go to `lines`,
 * bounded; every other console method does nothing, as does everything
 * when quiet.
 */
const capturingSource = (
  options: QuietOptions
): string => `${quietErrors(options).imports}const silent = () => undefined;
const lines = [];
const partOf = (part) => {
  if (typeof part === "string") {
    return part;
  }
  // An error's own properties aren't enumerable: JSON would say "{}".
  if (part instanceof Error) {
    return part.stack ?? \`\${part.name}: \${part.message}\`;
  }
  try {
    return JSON.stringify(part) ?? String(part);
  } catch {
    return String(part);
  }
};
const recording = (level) => (...parts) => {
  if (lines.length >= ${maxCapturedLines}) {
    return;
  }
  // Logging never throws into the App's code, as on Cloudflare: a value
  // that can't be printed (its toString throws) is a placeholder.
  let message;
  try {
    message = parts.map(partOf).join(" ").slice(0, ${maxCapturedMessage});
  } catch {
    message = "[unprintable]";
  }
  // Printing a value may log too (its toJSON): those lines may have
  // filled the call's lines meanwhile.
  if (lines.length < ${maxCapturedLines}) {
    lines.push({ at: Date.now(), level, message });
  }
};
const levels = new Set(${JSON.stringify(capturedLevels)});
for (const name of Object.getOwnPropertyNames(console)) {
  if (typeof console[name] === "function") {
    console[name] = levels.has(name) ? recording(name) : silent;
  }
}
${quietErrors(options).source}export const takeLines = () => lines.splice(0);
`;

/** The host's module that runs a captured call's entrypoint. */
const captureModule = "grasp-sandbox-capture.js";

/** The entrypoint of `captureModule`, and its method. */
export const captureEntrypoint = "GraspCaptured";
export const captureMethod = "call";

/**
 * Runs `entrypoint`'s `method` of the call's main module with `args`, then
 * hands what it wrote to `sink`, answered or thrown. A class entrypoint is
 * made as workerd makes one, with this isolate's context and env.
 */
const captureSource = (
  mainModule: string,
  quiet: string
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
import { takeLines } from ${JSON.stringify(`./${quiet}`)};
import * as main from ${JSON.stringify(mainModule)};
export class ${captureEntrypoint} extends WorkerEntrypoint {
  async ${captureMethod}(entrypoint, method, args, sink) {
    try {
      const exported = main[entrypoint];
      const target =
        typeof exported === "function"
          ? new exported(this.ctx, this.env)
          : exported;
      return await target[method](...args);
    } finally {
      try {
        await sink(takeLines());
      } catch {
        // The lines are for a check of the draft: never the call's failure.
      }
    }
  }
}
`;

/**
 * `modules` as a captured call's isolate loads them (see the header): the
 * quiet module recording, imported first by `captureModule`, the main
 * module, which then runs the call. A main module that isn't JavaScript
 * text, or isn't there, is left as it is: the Loader refuses it.
 */
export const capturedModules = <Module>(
  mainModule: string,
  modules: Readonly<Record<string, Module | string>>,
  options: QuietOptions = {}
): { mainModule: string; modules: Record<string, Module | string> } => {
  if (typeof modules[mainModule] !== "string") {
    return { mainModule, modules: { ...modules } };
  }
  // At the top, under names none of the isolate's modules has.
  const quiet = freeName(modules, "", quietModule);
  const capture = freeName({ ...modules, [quiet]: "" }, "", captureModule);
  return {
    mainModule: capture,
    modules: {
      ...modules,
      [quiet]: capturingSource(options),
      [capture]: `import ${JSON.stringify(`./${quiet}`)};\n${captureSource(mainModule, quiet)}`,
    },
  };
};
