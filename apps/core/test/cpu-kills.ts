import { env } from "cloudflare:workers";

// The Loader stopping a run's isolate past its CPU time, as Cloudflare
// does, for workflow tests on plain workerd, which enforces no `cpuMs`:
// the isolate, the host and the engine stay real, only the kill is stood
// in for. For an App's run and an independent workflow's alike: both
// isolates export a `Run` entrypoint whose `run` takes the host.

/** How the Loader stops an isolate past its `limits.cpuMs`, as Cloudflare documents it. */
const cpuKill = (): Error => new Error("Worker exceeded CPU time limit.");

/** The host core gives a run's isolate, as the isolate calls it. */
interface RunCallHost {
  do: (
    name: string,
    options: unknown,
    fn: (attempt: unknown) => Promise<unknown>
  ) => Promise<unknown>;
  sleep: (...args: unknown[]) => Promise<unknown>;
  sleepUntil?: (...args: unknown[]) => Promise<unknown>;
  waitForDecision: (...args: unknown[]) => Promise<unknown>;
  quiet?: (...args: unknown[]) => Promise<unknown>;
}

/**
 * When an attempt is cut off: as it starts, before any of its code runs,
 * or once its code has returned, all it did done and counted.
 */
type KillAt = "start" | "end";

/**
 * The `run` of a run's entrypoint `target`, with the Loader stopping the
 * isolate past its CPU time as each attempt of step `step` that `kills`
 * picks starts, or ends (`at`), counted from 1 across activations
 * (`counted`): that attempt's call, every other call into the isolate
 * still out, and the run's own call all reject with it.
 */
const killingRun =
  (
    target: object,
    {
      step,
      kills,
      at,
    }: { step: string; kills: (attempt: number) => boolean; at: KillAt },
    counted: { attempts: number }
  ) =>
  async (host: RunCallHost, input: unknown): Promise<unknown> => {
    const real: unknown = Reflect.get(target, "run");
    if (typeof real !== "function") {
      throw new TypeError("The run's isolate has no run");
    }
    const killed = Promise.withResolvers<never>();
    // Raced by every call it ends, and by none when no attempt is cut off:
    // never an unhandled rejection either way.
    // oxlint-disable-next-line promise/prefer-await-to-then -- not awaited here
    killed.promise.catch(() => null);
    const kill = (): never => {
      const error = cpuKill();
      killed.reject(error);
      throw error;
    };
    const watched: RunCallHost = {
      do: async (stepName, stepOptions, fn) =>
        await host.do(stepName, stepOptions, async (attempt) => {
          const killing = stepName === step && kills((counted.attempts += 1));
          if (killing && at === "start") {
            kill();
          }
          // Every call into the isolate still out ends with it.
          const value: unknown = await Promise.race([
            fn(attempt),
            killed.promise,
          ]);
          if (killing) {
            kill();
          }
          return value;
        }),
      sleep: async (...waitArgs) => await host.sleep(...waitArgs),
      ...(host.sleepUntil === undefined
        ? {}
        : {
            sleepUntil: async (...waitArgs: unknown[]) =>
              await host.sleepUntil?.(...waitArgs),
          }),
      waitForDecision: async (...waitArgs) =>
        await host.waitForDecision(...waitArgs),
      ...(host.quiet === undefined
        ? {}
        : {
            quiet: async (...quietArgs: unknown[]) =>
              await host.quiet?.(...quietArgs),
          }),
    };
    const ran: Promise<unknown> = Promise.resolve(
      Reflect.apply(real, target, [watched, input])
    );
    return await Promise.race([ran, killed.promise]);
  };

/**
 * What `run` returns while the Loader stops a run's isolate past its CPU
 * time as each attempt of step `step` that `kills` picks starts, or, with
 * `at` "end", once its code has returned (counted from 1 across
 * activations), as Cloudflare does (`killingRun`).
 */
export const withCpuKills = async <Result>(
  step: string,
  kills: (attempt: number) => boolean,
  run: () => Promise<Result>,
  at: KillAt = "start"
): Promise<Result> => {
  const loader = env.LOADER;
  const counted = { attempts: 0 };
  const getWorker = (...args: Parameters<WorkerLoader["get"]>) =>
    new Proxy(loader.get(...args), {
      get: (worker, property): unknown =>
        property === "getEntrypoint"
          ? (...entrypointArgs: Parameters<typeof worker.getEntrypoint>) => {
              const entrypoint = worker.getEntrypoint(...entrypointArgs);
              return entrypointArgs[0] === "Run"
                ? new Proxy(entrypoint, {
                    get: (target, name): unknown =>
                      name === "run"
                        ? killingRun(target, { step, kills, at }, counted)
                        : Reflect.get(target, name),
                  })
                : entrypoint;
            }
          : Reflect.get(worker, property),
    });
  env.LOADER = new Proxy(loader, {
    get: (target, property): unknown =>
      property === "get" ? getWorker : Reflect.get(target, property),
  });
  const retryDelay = env.WORKFLOW_RETRY_DELAY_MS;
  // A retry comes soon, but not at once: the engine parks its step, as for
  // any backoff, and the run's next activation runs it.
  env.WORKFLOW_RETRY_DELAY_MS = "200";
  try {
    return await run();
  } finally {
    env.LOADER = loader;
    if (retryDelay === undefined) {
      Reflect.deleteProperty(env, "WORKFLOW_RETRY_DELAY_MS");
    } else {
      env.WORKFLOW_RETRY_DELAY_MS = retryDelay;
    }
  }
};
