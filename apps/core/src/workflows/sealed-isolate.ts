import { jqWasm, jqWasmModule, kitModuleName } from "@grasp-os/compiler";
import type { Json } from "@grasp-os/shared/json";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { quietLoader } from "@grasp-os/shared/quiet-loader";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { NonRetryableError } from "@grasp-os/workerflow/errors";
import type { RpcTarget } from "cloudflare:workers";

import {
  capability,
  noPlaceOf,
  passedCapability,
  runInSession,
  sandboxVerdictOf,
} from "../sandbox-session.ts";
import type { PlatformModule } from "../sandbox-session.ts";
import { sandbox } from "../sandbox.ts";
import { sessionHost } from "../sandboxed.ts";
import { attemptCallLabels } from "./attempt-host.ts";
import type { AttemptHost } from "./attempt-host.ts";
import {
  betweenSteps,
  betweenStepsBudgetOf,
  BoundedRunHost,
} from "./between-steps.ts";
import { cpuLimitKill } from "./host.ts";

// A workflow run's isolate: a sealed build's generated module (sealed-run.ts)
// or an independent workflow's build (resource-runs.ts), with the SDK's
// modules it was built against, run in a Worker Loader isolate with no
// network and an empty env, or on-prem in a sandbox session of its own.
// Every binding is a call to core's host (host.ts, resource-host.ts) over
// RPC. Everything in the isolate is untrusted, core's main module too:
// every check is on core's side of the RPC.

/**
 * An error as it crosses between core and a workflow's isolate: plain data,
 * so nothing of it depends on how RPC carries errors.
 */
export interface StepError {
  name: string;
  message: string;
  /** An expected error's code, such as `permission.denied`. */
  code?: string;
}

/** How a call across the isolate's boundary ended. */
export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: StepError };

/** The run's main module, as core calls it. */
export interface SealedEntrypoint extends Rpc.WorkerEntrypointBranded {
  run: (host: RpcTarget, start: unknown) => Promise<Settled<unknown>>;
}

/**
 * How a run's code runs: as App server code does, with more CPU. One load
 * runs an activation of the run: the workflow from its start (finished
 * steps replayed) until it suspends, at a wait or a parked retry, or
 * ends. Its code between steps is bounded by no attempt's timeout: by
 * the CPU limit below, and by each activation's budget of wall time
 * between steps (between-steps.ts).
 *
 * Its CPU time is a workflow attempt's (spec 18.1, 30 seconds). Cloudflare
 * documents `limits.cpuMs` as applying "per invocation", without saying
 * whether a call back into the isolate (a step's function, which the host
 * calls through RPC) is an invocation of its own. So it is taken at its
 * strictest: the run's call into the isolate may count the replay and
 * every attempt of its activation together. No attempt gets more, retried
 * or not; one may get less, after earlier steps spent some. When the
 * Loader stops the isolate past it, an attempt it cut off fails as a
 * retryable timeout, and the run waits for that retry in a fresh
 * activation, with a fresh isolate and limit, rather than fail for CPU an
 * earlier step spent (attempt-calls.ts, `afterCpuKill`). On-prem the
 * sandbox supervisor bounds each run load, a session of its own, by the
 * same CPU time, and its `cpu` verdict is taken as the Loader's kill
 * (`stepCodeFailure`, `runLoadFailure`): the attempt it cut off is
 * retried in a fresh activation, with a fresh session. Its wall time is
 * the engine's to end, at each attempt's timeout (host.ts, `stepConfig`).
 */
const sealedSandbox = {
  ...sandbox,
  // `AsyncLocalStorage` only, for a run's bindings: which attempt of a
  // step a call comes from (`bindingsSource`).
  compatibilityFlags: [...sandbox.compatibilityFlags, "nodejs_als"],
  limits: { cpuMs: platformLimits.workflowAttemptCpuMs },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

/**
 * The sandbox's verdicts that are the code's own doing: anything else it
 * says (its owner at its share, its call over) is the platform's, to try
 * again (`runLoadFailure`).
 */
const codesVerdicts: ReadonlySet<string> = new Set([
  "deadline",
  "cpu",
  "memory",
  "crashed",
  "refused",
]);

/**
 * jq's WebAssembly, as every run's isolate has it besides its modules: the
 * workflow SDK's `evaluate` imports it by `jqWasmModule`. In core's Loader
 * a module of its own, spread last so no module of the build's takes its
 * name; on-prem one of the release's platform modules, which the sandbox
 * host reads apart (sandbox-session.ts) and refuses a module named as. It
 * goes with every isolate, whether its code evaluates or not: about 1 MB,
 * read from the assets once per core isolate. Accepted, as every workflow
 * is code generated from a JSON workflow, which evaluates its data flow
 * with it.
 */
const jqModules = async (
  env: Pick<Env, "ASSETS">
): Promise<{
  loader: Record<string, { wasm: ArrayBuffer }>;
  platform: Record<string, PlatformModule>;
}> => {
  const wasm = await jqWasm(env.ASSETS);
  return {
    loader: { [jqWasmModule]: { wasm } },
    platform: { [jqWasmModule]: { type: "wasm", bytes: new Uint8Array(wasm) } },
  };
};

/** A run's main module, by its flat name (`mainSource`). */
export const sealedMainModule = "grasp-run.js";

/**
 * The shared part of every main module (`mainSource`, resource-host.ts):
 * settling a call into plain data and back.
 */
export const settling = `
const described = (error) => ({
  name: String(error?.name ?? "Error"),
  message: String(error?.message ?? error),
  ...(typeof error?.code === "string" ? { code: error.code } : {}),
});
const settled = async (run) => {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: described(error) };
  }
};
`;

/**
 * What a run's main module builds its bindings with, as a module of its
 * own that the main module imports before the workflow's. A module's
 * imports load in the order written, so this one has run before any of
 * the build's code has: the built-ins it keeps here (`Proxy`, `Error`,
 * `Object.hasOwn`) are the runtime's, whatever the workflow's module
 * puts in their place as it loads, and it builds with nothing else a
 * module could replace (no array or object method, and no assignment a
 * setter on `Object.prototype` would see). So nothing the build's code does
 * at load is handed the bindings as they are wrapped. It is the isolate's
 * own convenience all the same: every call a binding makes is checked and
 * audited on core's side of the RPC, whatever code makes it.
 *
 * It also keeps which attempt of a step the code running belongs to
 * (`inAttempt`): the host core minted for that attempt (host.ts,
 * `AttemptHost`), which every binding call goes through, so each call acts
 * as the attempt whose code makes it, and only while it may. Code outside
 * any step has none, and its binding calls fail. Its storage's methods are
 * kept here too, bound as the runtime made them.
 */
const bindingsModule = "grasp-run-bindings.js";

/** What a binding called outside any step fails with, in the isolate. */
const outsideStep = workflowErrors.create("workflow.outside_step");
const bindingsSource = `import { AsyncLocalStorage } from "node:async_hooks";

const ProxyOf = Proxy;
const ErrorOf = Error;
const hasOwn = Object.hasOwn;
const attempts = new AsyncLocalStorage();
const attemptOf = attempts.getStore.bind(attempts);

export const inAttempt = attempts.run.bind(attempts);

/** The host of the attempt whose code runs now; none outside a step. */
export const currentAttempt = () => {
  const attempt = attemptOf();
  if (attempt === undefined) {
    const error = new ErrorOf(${JSON.stringify(outsideStep.message)});
    error.code = "workflow.outside_step";
    throw error;
  }
  return attempt;
};

export const unwrapped = (result) => {
  if (result.ok) {
    return result.value;
  }
  const error = new ErrorOf(result.error.message);
  error.name = result.error.name;
  if (result.error.code !== undefined) {
    error.code = result.error.code;
  }
  throw error;
};

const guarded = (env) =>
  new ProxyOf(env, {
    get: (target, name) => {
      if (typeof name !== "string" || name === "then" || hasOwn(target, name)) {
        return target[name];
      }
      const error = new ErrorOf(\`This workflow has no permission named \${name}: it was never granted, or it was revoked.\`);
      error.name = "PermissionError";
      error.code = "permission.denied";
      throw error;
    },
  });

export const bindings = (connections) => {
  const all = { __proto__: null };
  for (let index = 0; index < connections.length; index += 1) {
    const name = connections[index];
    all[name] = {
      call: async (action, input, options) =>
        unwrapped(await currentAttempt().callConnection(name, [action, input, options])),
    };
  }
  return guarded(all);
};
`;

/**
 * The module a run's main module (`mainSource`) runs the workflow of: a
 * sealed build's generated module, which the build's hash proves
 * (sealed-run.ts).
 */
interface RunDefinition {
  /** Its flat name: its default export is the workflow. */
  module: string;
  /** What the run fails with when it exports no workflow. */
  refusal: string;
}

/**
 * The main module of a run of the workflow `definition` names: the engine
 * the SDK runs on,
 * each of its calls sent to core's host (host.ts), and each error in plain
 * data both ways. Every binding (each a connection by its alias), and
 * what the SDK does inside a step (a decision), goes through the host of
 * the attempt whose code makes it, which core hands each attempt's
 * function. A binding the run doesn't have fails with a permission error,
 * not `undefined`. It
 * imports what builds the bindings (`bindingsSource`), then the SDK's
 * `workflow`, before the workflow's module: the bindings are built from
 * the runtime's own built-ins, and the definition the SDK makes is frozen
 * with the runtime's `Object.freeze`, so no module replaces its `run`.
 */
const mainSource = ({
  module,
  refusal,
}: RunDefinition): string => `import { WorkerEntrypoint } from "cloudflare:workers";
import { bindings, currentAttempt, inAttempt, unwrapped } from ${JSON.stringify(bindingsModule)};
import ${JSON.stringify(kitModuleName("@grasp-os/sdk/workflow"))};
import definition from ${JSON.stringify(module)};
${settling}

export class Run extends WorkerEntrypoint {
  async run(host, { runId, params, input, connections }) {
    return await settled(async () => {
      if (typeof definition?.run !== "function") {
        throw new Error(${JSON.stringify(refusal)});
      }
      const engine = {
        runId,
        params,
        env: bindings(connections),
        do: async (name, options, fn, retry) => unwrapped(await host.do(name, options, async (attempt) => await inAttempt(attempt, async () => await settled(fn)), ...(typeof retry === "function" ? [async (error) => await settled(async () => await retry(error))] : []))),
        sleep: async (name, milliseconds) => unwrapped(await host.sleep(name, milliseconds)),
        sleepUntil: async (name, until) => unwrapped(await host.sleepUntil(name, until)),
        caught: async (name, options, takes) => unwrapped(await host.caught(name, options, async (attempt, error) => await inAttempt(attempt, async () => await settled(async () => await takes(error))))),
        listen: async (name) => unwrapped(await host.listen(name)),
        openDecision: async (request) => unwrapped(await currentAttempt().openDecision(request)),
        decisionRecipients: async (decision, reminder) => unwrapped(await currentAttempt().decisionRecipients(decision, reminder)),
        waitForDecision: async (name, options) => unwrapped(await host.waitForDecision(name, options)),
      };
      return await definition.run(engine, input);
    });
  }
}
`;

/**
 * The modules a run's isolate loads besides its workflow's and the SDK's:
 * its main module (`sealedMainModule`, `mainSource`) and what builds its bindings
 * (`bindingsSource`).
 */
export const sealedMainModules = (
  definition: RunDefinition
): Record<string, string> => ({
  [bindingsModule]: bindingsSource,
  [sealedMainModule]: mainSource(definition),
});

/**
 * The host's calls a run's code makes (`RunHost`'s, host.ts): its main
 * module calls only these (`mainSource`), and on-prem the isolate gets no
 * other.
 */
export interface IsolateHostCalls<Attempt = AttemptHost> {
  do: (
    name: unknown,
    options: unknown,
    /**
     * The attempt's function in the isolate, handed the host minted for
     * that attempt: a sealed run's `AttemptHost`, or an independent
     * workflow's (resource-host.ts).
     */
    fn: (attempt: Attempt) => Promise<unknown>,
    /**
     * A sealed run's choice of a retry after the step failed (host.ts,
     * `RunHost.#retried`): its retry function, run outside any attempt.
     */
    retry?: (error: Json) => Promise<unknown>
  ) => Promise<Settled<unknown>>;
  sleep: (name: unknown, duration: unknown) => Promise<Settled<null>>;
  /**
   * A `try` task's catch step: a sealed run's (host.ts, `RunHost.caught`);
   * an independent workflow's run has none.
   */
  caught?: (
    name: unknown,
    options: unknown,
    fn: (attempt: Attempt, error: Json) => Promise<unknown>
  ) => Promise<Settled<unknown>>;
  /**
   * A durable sleep until a deadline its step recorded: an independent
   * workflow's (resource-host.ts) or a sealed run's (host.ts).
   */
  sleepUntil?: (name: unknown, until: unknown) => Promise<Settled<null>>;
  /**
   * A listen task's events, as the host takes them: an independent
   * workflow's (resource-host.ts), or a sealed run's event wait (host.ts).
   */
  listen?: (name: unknown) => Promise<Settled<unknown>>;
  /**
   * A run task's child's output, as the host waits for it: an independent
   * workflow's (resource-host.ts); a sealed run has none.
   */
  child?: (name: unknown) => Promise<Settled<unknown>>;
  waitForDecision: (
    name: unknown,
    options: unknown
  ) => Promise<Settled<unknown>>;
  /**
   * The run's isolate went quiet after it last got control back, having
   * made `made` asks in all, the `time`th time it got control back: an
   * independent workflow's (resource-host.ts), which holds the run busy
   * until they have all arrived; a sealed run makes none.
   */
  quiet?: (made: unknown, time: unknown) => Promise<Settled<null>>;
}

/**
 * The longest one load of a run may take on-prem, in wall-clock time: from
 * its start or a resume to its next wait, the supervisor's longest session.
 * A load past it is stopped, as the code's: its steps wait on model and
 * connector calls, which cost it no CPU time, and its CPU time is bounded
 * on its own (`sealedSandbox`).
 */
const runLoadMs = 15 * 60_000;

/**
 * How long a run's load waits, in all, for a place in the sandbox: its
 * owner's runs may hold their share, and other calls the pool, for as long
 * as their own loads take. Nothing of the run ran yet, so waiting is safe;
 * past it, the load fails as the platform's.
 */
const runLoadWaitMs = 10 * 60_000;

/** The longest one wait between asks for a place. */
const runLoadRetryMs = 30_000;

/** How often a load waiting for a place looks whether its activation is over. */
const runLoadCheckMs = 1000;

/**
 * How long a step whose function failed waits for its session's verdict
 * (`sessionHostCalls`): the session ends at once when its process does.
 */
const verdictWaitMs = 5000;

/**
 * What never settles: a load let go of once its activation is over, as
 * the engine leaves a suspended call.
 */
const neverSettles = async (): Promise<never> =>
  // oxlint-disable-next-line promise/avoid-new -- a promise that never settles, which nothing else makes
  await new Promise<never>(() => {
    // Never settles.
  });

/** A run's load let go of: its run cancelled, or its activation superseded. */
const letGoError = (): Error =>
  new Error("The run was cancelled or taken over: its load let go.");

/**
 * Runs `load` on the sandbox, asking again while no place is free
 * (`noPlaceOf`), backing off up to {@link runLoadRetryMs}, for up to
 * {@link runLoadWaitMs}. It looks whether the run is still its
 * activation's (`current`) at once before each ask, with nothing awaited
 * in between, and every {@link runLoadCheckMs} as it waits: one cancelled
 * or taken over is refused (`letGoError`), and never takes a place. One
 * whose activation is over (`over`: a wait suspended it) never settles.
 */
const waitingForPlace = async (
  load: () => Promise<unknown>,
  { over, current }: { over: AbortSignal | undefined; current: () => boolean }
): Promise<unknown> => {
  const stillWanted = async (): Promise<void> => {
    if (over?.aborted === true) {
      await neverSettles();
    }
    if (!current()) {
      throw letGoError();
    }
  };
  const until = Date.now() + runLoadWaitMs;
  for (let wait = 1000; ; wait = Math.min(wait * 2, runLoadRetryMs)) {
    // oxlint-disable-next-line no-await-in-loop -- one look at a time
    await stillWanted();
    try {
      // oxlint-disable-next-line no-await-in-loop -- one ask at a time
      return await load();
    } catch (error) {
      if (!noPlaceOf(error) || Date.now() + wait > until) {
        throw error;
      }
    }
    for (const next = Date.now() + wait; Date.now() < next;) {
      // oxlint-disable-next-line no-await-in-loop -- one look at a time
      await stillWanted();
      // oxlint-disable-next-line no-await-in-loop -- one look at a time
      await scheduler.wait(Math.min(runLoadCheckMs, next - Date.now()));
    }
  }
};

/**
 * Aborts `letGo` once the run is no longer its activation's (`current`),
 * looking every {@link runLoadCheckMs} until `settled` aborts: a load
 * running for a run cancelled or taken over ends, freeing its place.
 */
const watchCurrent = async (
  current: () => boolean,
  letGo: AbortController,
  settled: AbortSignal
): Promise<void> => {
  while (!settled.aborted) {
    if (!current()) {
      letGo.abort(letGoError());
      return;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- one look at a time
      await scheduler.wait(runLoadCheckMs, { signal: settled });
    } catch {
      return;
    }
  }
};

/** The calls of a step's attempt host (`AttemptHost`): the isolate's, on-prem. */
export const attemptHostMethods = Object.keys(attemptCallLabels);

/** The run's session, as the capabilities passed during it see it. */
export interface IsolateSession {
  /** Whether its call is open now: not once it answered or was given up on. */
  live: () => boolean;
  /** The load's failure once it ended (null for none). */
  ended: Promise<unknown>;
}

/**
 * Fails a step whose function failed rather than answered, as its
 * session ended: past its CPU time, as the Loader's CPU kill, which the
 * host retries in a fresh session; for good when the sandbox stopped the
 * code otherwise (its memory or time past, its process gone, what it sent
 * refused), so the step is never tried again in an isolate that is no
 * more; as it failed,
 * the platform's to try again, otherwise (a socket dropped, a refusal of
 * core's own, or no verdict yet).
 */
const stepCodeFailure = async (
  thrown: unknown,
  session: IsolateSession
): Promise<Error> => {
  const failure = await Promise.race([
    session.ended,
    (async (): Promise<undefined> => {
      await scheduler.wait(verdictWaitMs);
      return undefined;
    })(),
  ]);
  const verdict = sandboxVerdictOf(failure);
  if (verdict === "cpu") {
    // As the Loader's CPU kill: the host fails the attempt as a retryable
    // timeout, retried in a fresh session (attempt-calls.ts,
    // `afterCpuKill`), with no more CPU time than this one had.
    return cpuLimitKill(failure);
  }
  if (verdict !== undefined && codesVerdicts.has(verdict)) {
    return new NonRetryableError(
      `The sandbox stopped the step's code: ${failure instanceof Error ? failure.message : verdict}`
    );
  }
  return thrown instanceof Error
    ? thrown
    : new Error("The step's code failed.");
};

/**
 * Runs `fn`, a step's function in the isolate, with `attempt` passed as a
 * capability of its calls alone, live while `fn` runs and the session's
 * call is open (`passedCapability`). A function that fails rather than
 * answering fails its step as `stepCodeFailure` says.
 */
const inSession = async <Attempt extends object>(
  session: IsolateSession,
  methods: readonly string[],
  attempt: Attempt,
  fn: (passed: Attempt) => Promise<unknown>
): Promise<unknown> => {
  let live = true;
  try {
    return await fn(
      // SAFETY: what the sandbox host makes of a passed capability for
      // the isolate: `fn` is the isolate's, over the session.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      passedCapability(attempt, methods, () => live && session.live()) as never
    );
  } catch (error) {
    throw await stepCodeFailure(error, session);
  } finally {
    live = false;
  }
};

/**
 * `host` as the run's capability in a session: its calls, and the
 * attempt host each step's function gets, passed as a capability of its
 * calls alone, live while that function runs and the session's call is
 * open (`passedCapability`). A function that fails rather than answering
 * fails its step as `stepCodeFailure` says.
 */
export const sessionHostCalls = <Attempt extends object = AttemptHost>(
  host: IsolateHostCalls<Attempt>,
  session: IsolateSession,
  /** The calls each attempt host passes. */
  methods: readonly string[]
): IsolateHostCalls<Attempt> => ({
  do: async (name, options, fn, retry) => {
    if (typeof fn !== "function") {
      return await host.do(name, options, fn, retry);
    }
    return await host.do(
      name,
      options,
      async (attempt) =>
        await inSession(
          session,
          methods,
          attempt,
          async (passed) => await fn(passed)
        ),
      typeof retry === "function"
        ? async (failure) => {
            try {
              return await retry(failure);
            } catch (error) {
              throw await stepCodeFailure(error, session);
            }
          }
        : undefined
    );
  },
  caught: async (name, options, fn) => {
    if (host.caught === undefined) {
      return {
        ok: false,
        error: { name: "Error", message: "This run has no catches." },
      };
    }
    if (typeof fn !== "function") {
      return await host.caught(name, options, fn);
    }
    return await host.caught(
      name,
      options,
      async (attempt, error) =>
        await inSession(
          session,
          methods,
          attempt,
          async (passed) => await fn(passed, error)
        )
    );
  },
  sleep: async (name, duration) => await host.sleep(name, duration),
  sleepUntil: async (name, until) =>
    host.sleepUntil === undefined
      ? {
          ok: false,
          error: { name: "Error", message: "This run has no sleep until." },
        }
      : await host.sleepUntil(name, until),
  listen: async (name) =>
    host.listen === undefined
      ? {
          ok: false,
          error: { name: "Error", message: "This run has no listen tasks." },
        }
      : await host.listen(name),
  child: async (name) =>
    host.child === undefined
      ? {
          ok: false,
          error: { name: "Error", message: "This run has no child workflows." },
        }
      : await host.child(name),
  waitForDecision: async (name, options) =>
    await host.waitForDecision(name, options),
  quiet: async (made, time) =>
    host.quiet === undefined
      ? { ok: true, value: null }
      : await host.quiet(made, time),
});

/**
 * What a run's load failing on-prem fails the run with: past its CPU
 * time, the Loader's CPU kill, for `afterCpuKill`; the sandbox stopping
 * its code otherwise (its memory or time past, its process gone, what it
 * sent refused) as the code's, a workflow error saying so; anything else
 * as it is, the platform's.
 */
const runLoadFailure = (error: unknown): unknown => {
  const verdict = sandboxVerdictOf(error);
  if (verdict === "cpu") {
    // As the Loader's CPU kill, for `afterCpuKill`: it waits for each
    // attempt the verdict cut off to be parked for its retry, and fails
    // the run when none was (its code spent the time outside any step).
    return cpuLimitKill(error);
  }
  if (verdict === undefined || !codesVerdicts.has(verdict)) {
    return error;
  }
  const failure = workflowErrors.create("workflow.run_failed");
  failure.message = `The sandbox stopped the workflow's code: ${error instanceof Error ? error.message : verdict}`;
  return failure;
};

/** How a run's load is let go of (`loadSealedIsolate`). */
export interface SealedLoadOptions {
  over?: AbortSignal;
  /** Hears the run's sandbox session ID on-prem, once it's open. */
  onSession?: (id: string) => void;
  /**
   * Whether the run is still its activation's: not cancelled, nor taken
   * over by a newer activation (run-object.ts).
   */
  current?: () => boolean;
}

/**
 * What a run's isolate is loaded with: a sealed build's (sealed-run.ts) or
 * an independent workflow's build (resource-runs.ts). Its main module's
 * `Run` entrypoint takes the host's calls and the run's start.
 */
export interface SealedIsolate {
  /** Whose runs it is among, which the sandbox caps per owner. */
  owner: string;
  mainModule: string;
  modules: () => Promise<Record<string, string>>;
  /** The calls each step's attempt host passes its code on-prem. */
  attemptHostMethods: readonly string[];
}

/**
 * A run's isolate, of its own, running the run's build. Each load is a
 * new isolate, which nothing else shares (it has no name): its env is
 * empty, as every binding it has goes through the host, and no two runs,
 * or loads of one run, share memory. Loads are few: a run's start, and
 * each resume after a wait.
 *
 * On-prem it runs as a sandbox session of its own, owned by `owner`, its
 * CPU time and memory bounded by the supervisor, with only the host's
 * calls (`sessionHostCalls`). `over` says the activation it runs for is
 * over (a wait suspended it, which never settles its call): the session
 * ends then, freeing its process, and a load waiting for a place stops
 * waiting: a cancel, which ends the activation, so stops it. A pause is
 * taken at the first step boundary once loaded, as the engine takes every
 * pause.
 *
 * Each load's code is held to the activation's budget of time between
 * steps (between-steps.ts): past it, its call fails with
 * `workflow.between_steps_limit`, and is let go of.
 */
export const loadSealedIsolate = <Attempt extends object = AttemptHost>(
  env: Env,
  { owner, mainModule, modules, attemptHostMethods: methods }: SealedIsolate,
  { over, current = () => true, onSession }: SealedLoadOptions = {}
): {
  run: (
    host: IsolateHostCalls<Attempt> & RpcTarget,
    start: unknown
  ) => Promise<unknown>;
} => {
  const sandboxHost = sessionHost(env);
  const budgetMs = betweenStepsBudgetOf(env);
  if (sandboxHost === undefined) {
    return {
      run: async (host, start) => {
        // Read before the clock starts: none of the run's code runs yet.
        const [own, jq] = await Promise.all([modules(), jqModules(env)]);
        const loaded = { ...own, ...jq.loader };
        const entrypoint = quietLoader(env.LOADER)
          .get(null, () => ({
            ...sealedSandbox,
            mainModule,
            modules: loaded,
            env: {},
          }))
          .getEntrypoint<SealedEntrypoint>("Run");
        const clock = betweenSteps(budgetMs);
        clock.started();
        try {
          // Past its budget the isolate's call is dropped: it can't be
          // killed, and every step call it makes after is refused.
          return await Promise.race([
            entrypoint.run(new BoundedRunHost(host, clock), start),
            clock.spent,
          ]);
        } finally {
          clock.ended();
        }
      },
    };
  }
  return {
    run: async (host, start) => {
      let sessionLive: (() => boolean) | undefined;
      const ended = Promise.withResolvers<unknown>();
      const session: IsolateSession = {
        live: () => sessionLive?.() === true && over?.aborted !== true,
        ended: ended.promise,
      };
      const clock = betweenSteps(budgetMs);
      const [own, jq] = await Promise.all([modules(), jqModules(env)]);
      const call = {
        mainModule,
        modules: own,
        platformModules: jq.platform,
        entrypoint: "Run",
        method: "run",
        args: [
          {
            capability: capability(
              sessionHostCalls(
                new BoundedRunHost(host, clock),
                session,
                methods
              ),
              [
                "do",
                "sleep",
                "sleepUntil",
                "caught",
                "listen",
                "child",
                "waitForDecision",
                "quiet",
              ]
            ),
          },
          { value: start },
        ],
        owner,
        cpuMs: sealedSandbox.limits.cpuMs,
        wallMs: runLoadMs,
        // Its run bindings' `AsyncLocalStorage`, as `sealedSandbox` gives it.
        asyncContext: true,
      };
      // Let go of once the run is cancelled or taken over, as it runs.
      const letGo = new AbortController();
      // Ended once its code spent its time between steps, freeing its
      // process.
      const signal = AbortSignal.any(
        over === undefined
          ? [letGo.signal, clock.over]
          : [over, letGo.signal, clock.over]
      );
      const loading = async (): Promise<unknown> => {
        try {
          const value = await waitingForPlace(
            async () => {
              // Nothing awaited since `current` was last looked at.
              const settled = new AbortController();
              const watching = watchCurrent(current, letGo, settled.signal);
              try {
                return await runInSession(sandboxHost, call, {
                  signal,
                  opened: (id, live) => {
                    sessionLive = live;
                    // Its code starts now: the wait for a place isn't its.
                    clock.started();
                    onSession?.(id);
                  },
                });
              } finally {
                settled.abort();
                await watching;
              }
            },
            { over, current }
          );
          ended.resolve(null);
          return value;
        } catch (error) {
          ended.resolve(error);
          if (clock.over.aborted) {
            return await clock.spent;
          }
          if (letGo.signal.aborted) {
            throw letGoError();
          }
          if (over?.aborted === true) {
            // Let go of once its activation was over: as the engine leaves a
            // suspended call, it never settles, so nothing of the run acts on
            // an activation that is over.
            return await neverSettles();
          }
          throw runLoadFailure(error);
        }
      };
      try {
        return await Promise.race([loading(), clock.spent]);
      } finally {
        clock.ended();
      }
    },
  };
};
