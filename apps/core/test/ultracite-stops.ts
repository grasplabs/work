/** Ultracite's module (compilerAssets.ultracite), and where the stub moves it. */
const ultracite = "ultracite.js";
const linted = "ultracite-linted.js";

/**
 * `loader` with Ultracite's isolates stopped, as the runtime stops one at
 * its `limit` ("Worker exceeded CPU time limit."), on each call whose
 * files hold `marker`: the warm one every App shares (a name of its own,
 * so no isolate an earlier test started answers), and with `fresh` the
 * fresh one a call is tried again in too. Plain workerd bounds nothing,
 * so this is how a test reaches what core does with a stop.
 */
export const stoppingUltracite = (
  loader: WorkerLoader,
  {
    marker,
    limit,
    fresh,
  }: { marker: string; limit: "CPU time" | "memory"; fresh: boolean }
): WorkerLoader => {
  // Its own module, under another name, behind one that stops: whatever
  // wraps it (shared/quiet-loader.ts) imports this one.
  const stopping = (
    worker: WorkerLoaderWorkerCode
  ): WorkerLoaderWorkerCode => ({
    ...worker,
    modules: {
      ...worker.modules,
      [linted]: worker.modules[ultracite] ?? "",
      [ultracite]: `import Linter from "./${linted}";
const stopped = (files) => {
  if (Object.hasOwn(files, ${JSON.stringify(marker)})) {
    throw new Error("Worker exceeded ${limit} limit.");
  }
};
export default class extends Linter {
  lint(files) { stopped(files); return super.lint(files); }
  tidy(files) { stopped(files); return super.tidy(files); }
}
`,
    },
  });
  const named = crypto.randomUUID();
  return {
    get: (name, code) =>
      name?.startsWith("ultracite:") === true
        ? loader.get(`${name}:${named}`, async () => stopping(await code()))
        : loader.get(name, code),
    load: (code) =>
      fresh && Object.hasOwn(code.modules, ultracite)
        ? loader.load(stopping(code))
        : loader.load(code),
  };
};
