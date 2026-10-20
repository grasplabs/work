/**
 * What an isolate on the on-prem sandbox host may print: nothing.
 *
 * On plain workerd, a Loader isolate's console goes to its process's
 * stdout and stderr, which the supervisor (scripts/workerd-sandbox.ts)
 * shares with the deployment's logs: whatever App code logs (a record, a
 * caller's input, another owner's data handed to it) would land there,
 * unbounded and read by whoever reads those logs. On Cloudflare the same
 * output is dropped unless a Tail Worker is attached, and core attaches
 * none. So on-prem drops it too (GRA-776), for every isolate the host
 * loads, App and platform code alike: what an isolate needs to say comes
 * back in its answer, and core logs what it decides itself.
 *
 * How: the isolate's main module imports `quietModule` first, so it is
 * evaluated before any other module of the isolate and no module keeps a
 * console method of its own. It replaces every console method with one
 * that does nothing (`node:console` prints through them, and a method the
 * App puts back can only call the silenced ones), and prevents the
 * default of an unhandled rejection or error, which workerd served
 * `--verbose` would otherwise print with its message.
 */

/** The quiet module's name: none an App's or the platform's module has. */
export const quietModule = "grasp-sandbox-quiet.js";

/** Every console method silenced, and nothing left for workerd to report. */
const quietSource = `const silent = () => undefined;
for (const name of Object.getOwnPropertyNames(console)) {
  if (typeof console[name] === "function") {
    console[name] = silent;
  }
}
addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
});
addEventListener("error", (event) => {
  event.preventDefault();
});
`;

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
  return {
    ...modules,
    [mainModule]: `import ${JSON.stringify(quietModule)};\n${main}`,
    [quietModule]: quietSource,
  };
};
