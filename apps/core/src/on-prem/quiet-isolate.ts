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
 * itself (an import resolves against the importer's name, and the quiet
 * module takes that name over whatever an App supplied there), so it is
 * evaluated before any other module of the isolate and no module keeps a
 * console method of its own. It replaces every console method with one
 * that does nothing (`node:console` prints through them, and a method the
 * App puts back can only call the silenced ones), catches what a timer's
 * callback throws, and prevents the default of an unhandled rejection or
 * error, which workerd served `--verbose` would otherwise print with its
 * message. What it can't stop: workerd served `--verbose` reports an
 * exception thrown out of an entrypoint's call (an RPC method's, a
 * fetch's), message and stack, as it hands it to the caller as the call's
 * answer (GRA-939). Without `--verbose`, as the supervisor and a
 * deployment run, nothing of it is printed.
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
 * What both quiet modules do besides the console: a timer's callback that
 * throws is caught where it runs, and an unhandled rejection or error has
 * its default prevented, so workerd served `--verbose` reports neither.
 * (An exception thrown out of an entrypoint's call, an RPC method's or a
 * fetch's, still is: it is the call's answer, which its caller gets.)
 */
const quietErrors = `const caught = (callback) =>
  typeof callback === "function"
    ? function (...args) {
        try {
          return callback.apply(this, args);
        } catch {
          return undefined;
        }
      }
    : callback;
for (const name of ["setTimeout", "setInterval"]) {
  const timer = globalThis[name];
  if (typeof timer === "function") {
    globalThis[name] = (callback, ...rest) => timer(caught(callback), ...rest);
  }
}
addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});
addEventListener("error", (event) => {
  event.preventDefault();
});
`;

/** Every console method silenced, and nothing else left for workerd to report. */
const quietSource = `const silent = () => undefined;
for (const name of Object.getOwnPropertyNames(console)) {
  if (typeof console[name] === "function") {
    console[name] = silent;
  }
}
${quietErrors}`;

/** Where a hashbang's line ends: at any line terminator JavaScript has. */
const lineTerminator = /[\r\n\u2028\u2029]/u;

/**
 * Where the quiet module goes for `mainModule`: beside it, so the main's
 * relative import names this module and no other an App's code supplied
 * (an import resolves against the importing module's own name).
 */
const quietPathOf = (mainModule: string): string =>
  `${mainModule.slice(0, mainModule.lastIndexOf("/") + 1)}${quietModule}`;

/**
 * `modules` with the quiet module, imported first by `mainModule`. A main
 * module that isn't JavaScript text, or isn't there, is left as it is: the
 * Loader refuses it, and nothing runs.
 */
export const quietModules = <Module>(
  mainModule: string,
  modules: Readonly<Record<string, Module | string>>
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
  return {
    ...modules,
    [mainModule]: `${hashbang}import ${JSON.stringify(`./${quietModule}`)};\n${rest}`,
    [quietPathOf(mainModule)]: quietSource,
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
const capturingSource = `const silent = () => undefined;
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
${quietErrors}export const takeLines = () => lines.splice(0);
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
  mainModule: string
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
import { takeLines } from ${JSON.stringify(`./${quietModule}`)};
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
  modules: Readonly<Record<string, Module | string>>
): { mainModule: string; modules: Record<string, Module | string> } => {
  if (typeof modules[mainModule] !== "string") {
    return { mainModule, modules: { ...modules } };
  }
  return {
    mainModule: captureModule,
    modules: {
      ...modules,
      [quietModule]: capturingSource,
      [captureModule]: `import ${JSON.stringify(`./${quietModule}`)};\n${captureSource(mainModule)}`,
    },
  };
};
