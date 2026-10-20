import {
  appModuleName,
  compilerVersion,
  kitModuleName,
  workflowSdkModules,
  workflowIdOf,
  workflowPaths,
} from "@grasp-os/compiler";
import { reviewedCalls } from "@grasp-os/sdk/describe";
import { paramValueSchemas } from "@grasp-os/sdk/params";
import type { ParamKind } from "@grasp-os/sdk/params";
import type { AppFiles } from "@grasp-os/shared/apps";
import { diagnosticCategory } from "@grasp-os/shared/diagnostics";
import { workflowIdSchema } from "@grasp-os/shared/ids";
import type { AppId, RunId, WorkflowId } from "@grasp-os/shared/ids";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import {
  paramDeclarationSchema,
  paramDeclarationsSchema,
  triggerDeclarationsSchema,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type {
  TriggerDeclaration,
  WorkflowCalls,
} from "@grasp-os/shared/workflows";
import { NonRetryableError } from "@grasp-os/workerflow/errors";
import type { RpcTarget } from "cloudflare:workers";
import { z } from "zod";

import {
  capability,
  noPlaceOf,
  passedCapability,
  runInSession,
  sandboxVerdictOf,
} from "../sandbox-session.ts";
import type { SessionCall, SessionOptions } from "../sandbox-session.ts";
import { sandbox } from "../sandbox.ts";
import { SandboxUnavailableError, sessionHost } from "../sandboxed.ts";
import { buildWorkflows } from "../screens.ts";
import { attemptCallLabels } from "./attempt-host.ts";
import type { AttemptHost } from "./attempt-host.ts";
import {
  betweenSteps,
  betweenStepsBudgetOf,
  BoundedRunHost,
} from "./between-steps.ts";
import { collectionMethods, cpuLimitKill, fromIsolate } from "./host.ts";

// An App's workflows are its code, written by the agent: they run as its
// server code does, in a Worker Loader isolate with no network and an
// empty env: every binding is a call to core's host (host.ts). Each
// isolate loads one version's workflows and the SDK's modules, and a main
// module of core's that connects the one workflow it runs to the engine
// (host.ts) over RPC. Everything in the isolate is untrusted, core's main
// module too: every check is on core's side of the RPC.
//
// A run is pinned to its App version's workflow code. The SDK's modules
// come from the release that runs it, and so does the engine contract
// between them (step names, `$params`): that contract must stay
// the same across releases, or runs started before a release replay
// differently after it. `env.APP.call` calls the App's current server
// version, as every caller of the App does; `env.APP.callFunction` calls a
// public function of the sealed release of the version the run is pinned
// to (host.ts).
//
// A version's workflows ship with their tests, which run in an isolate of
// their own before the version can be made current. That is a quality
// gate, not a security boundary: code can tell it runs under test.

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

/**
 * What the run's main module takes from core: the run, the parameter
 * values people set, its input, and the binding names of its collections,
 * connections and other Apps' exports, which it calls through the host
 * (host.ts).
 */
export interface RunStart {
  runId: RunId;
  params: Record<string, string | number>;
  input: unknown;
  collections: string[];
  connections: string[];
  apps: string[];
}

/** The run's main module, as core calls it. */
export interface RunEntrypoint extends Rpc.WorkerEntrypointBranded {
  run: (host: RpcTarget, start: unknown) => Promise<Settled<unknown>>;
}

/**
 * A workflow's tests as `runWorkflowTests` reports them, as far as core
 * reads it; the isolate sends it, so it is checked, and bounded.
 */
const testReportSchema = z.object({
  passed: z.boolean(),
  results: z
    .array(
      z.object({
        name: z.string().max(200),
        failures: z.array(z.string().max(2000)).max(50),
      })
    )
    .max(500),
});

/**
 * A workflow's parameters as its code declares them (the SDK's
 * `ParamMetadata`), within the bounds the SDK checks too. The isolate
 * sends them, so they are checked again here.
 */
const declaredParamsSchema = paramDeclarationsSchema(
  paramDeclarationSchema.extend({
    kind: z.custom<ParamKind>(
      (kind) =>
        typeof kind === "string" && Object.hasOwn(paramValueSchemas, kind)
    ),
  })
).superRefine((params, context) => {
  for (const param of params) {
    if (!paramValueSchemas[param.kind].safeParse(param.default).success) {
      context.addIssue({
        code: "custom",
        message: `The default of ${param.name} isn't a ${param.kind}`,
      });
    }
  }
});

/** A parameter as a workflow's code declares it. */
export type DeclaredParam = z.infer<typeof declaredParamsSchema>[number];

/** A workflow's metadata as its isolate sends it; its readers check each part. */
const declaredMetadataSchema = z.object({
  params: z.unknown().optional(),
  triggers: z.unknown().optional(),
});

/**
 * How workflow code runs: as App server code does, with more CPU. One load
 * runs an activation of the run: the workflow from its start (finished
 * steps replayed) until it suspends, at a wait or a parked retry, or
 * ends. Its code between steps is bounded by no attempt's timeout: by
 * the CPU limit below, and by each activation's budget of wall time
 * between steps (between-steps.ts); where one App call runs one method.
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
 * earlier step spent (dispatcher.ts, `afterCpuKill`). On-prem the
 * sandbox supervisor bounds each run load, a session of its own, by the
 * same CPU time, and its `cpu` verdict is taken as the Loader's kill
 * (`stepCodeFailure`, `runLoadFailure`): the attempt it cut off is
 * retried in a fresh activation, with a fresh session. Its wall time is
 * the engine's to end, at each attempt's timeout (host.ts, `stepConfig`).
 */
const workflowSandbox = {
  ...sandbox,
  // `AsyncLocalStorage` only, for a run's bindings: which attempt of a
  // step a call comes from (`runBindings`).
  compatibilityFlags: [...sandbox.compatibilityFlags, "nodejs_als"],
  limits: { cpuMs: platformLimits.workflowAttemptCpuMs },
} satisfies Omit<WorkerLoaderWorkerCode, "mainModule" | "modules">;

/**
 * How long a workflow isolate's call of its metadata, tests or dry runs
 * may take on-prem, waits included: its CPU time is bounded apart.
 */
const codeCallMs = 5 * 60_000;

/**
 * The sandbox's verdicts that are the code's own doing: anything else it
 * says (its owner at its share, its call over) is the platform's, to try
 * again (`isolateCall`).
 */
const codesVerdicts: ReadonlySet<string> = new Set([
  "deadline",
  "cpu",
  "memory",
  "crashed",
  "refused",
]);

/** What `work` comes to, or `signal`'s reason once it aborts first. */
const givenUpOn = async <T>(
  work: Promise<T>,
  signal: AbortSignal
): Promise<T> => {
  signal.throwIfAborted();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const abort = (): void => {
    reject(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

/**
 * What `call` answers in a sandbox session of App code apart from a run
 * (a workflow's metadata, tests and dry runs; an App's test suites,
 * app-tests.ts): what the code threw, or why the sandbox ended it, as the
 * code's failure only for {@link codesVerdicts}. Any other verdict (its
 * owner at its share, `busy`; its call over) is thrown as a
 * {@link SandboxUnavailableError}, the platform's, to try again, its
 * verdict on its `cause` (`noPlaceOf`).
 */
export const codeSession = async (
  host: Fetcher,
  call: SessionCall,
  options: SessionOptions = {}
): Promise<unknown> => {
  try {
    return await runInSession(host, call, options);
  } catch (error) {
    const verdict = sandboxVerdictOf(error);
    if (verdict !== undefined && !codesVerdicts.has(verdict)) {
      throw new SandboxUnavailableError(
        error instanceof Error ? error.message : "The sandbox is busy.",
        { cause: error, started: verdict !== "busy" }
      );
    }
    throw error;
  }
};

/**
 * Calls `method` of `entrypoint` with JSON `args`, in a workflow isolate of
 * `mainModule` and `modules`: on-prem in a sandbox session of its own, as
 * `owner`, its CPU time and memory bounded by the supervisor, which plain
 * workerd's Loader doesn't bound (sandbox-session.ts); elsewhere in core's
 * Loader, kept under `key` (`null`: never kept). Throws what the isolate's
 * entrypoint threw, or why the sandbox ended the call (`sandboxVerdictOf`).
 */
export const isolateCall = async (
  env: Pick<
    Env,
    "LOADER" | "RUNTIME_PROFILE" | "SANDBOX_HOST" | "SANDBOX_IN_PROCESS"
  >,
  {
    key,
    owner,
    mainModule,
    modules,
    entrypoint,
    method,
    args,
    signal,
  }: {
    key: string | null;
    owner: string;
    mainModule: string;
    modules: () => Promise<Record<string, string>>;
    entrypoint: string;
    method: string;
    args: unknown[];
    /** Gives up on it, freeing its process at once. */
    signal?: AbortSignal;
  }
): Promise<unknown> => {
  // Given up on before it starts (its modules built meanwhile): it never
  // starts.
  signal?.throwIfAborted();
  const host = sessionHost(env);
  if (host !== undefined) {
    return await codeSession(
      host,
      {
        mainModule,
        modules: await modules(),
        entrypoint,
        method,
        args: args.map((value) => ({ value })),
        owner,
        cpuMs: workflowSandbox.limits.cpuMs,
        wallMs: codeCallMs,
      },
      signal === undefined ? {} : { signal }
    );
  }
  const stub: unknown = env.LOADER.get(key, async () => ({
    ...workflowSandbox,
    mainModule,
    modules: await modules(),
    env: {},
  })).getEntrypoint(entrypoint);
  const fn: unknown =
    typeof stub === "object" || typeof stub === "function"
      ? Reflect.get(stub ?? {}, method)
      : undefined;
  if (typeof fn !== "function") {
    throw new TypeError(`The workflow's isolate has no ${method}.`);
  }
  const called: Promise<unknown> = Promise.resolve(
    Reflect.apply(fn, stub, args)
  );
  // In core's own Loader nothing frees the isolate: given up on, the
  // caller stops waiting for it, which the runtime bounds.
  return signal === undefined ? await called : await givenUpOn(called, signal);
};

const runModule = "grasp-run.js";
const testsModule = "grasp-tests.js";
const metadataModule = "grasp-metadata.js";
const dryRunModule = "grasp-dry-run.js";

/** Most of a workflow's tests one dry run runs. */
const maxDryRuns = 50;

/** The most of one dry run's report core keeps, in characters. */
const maxDryRunReport = 20_000;

/** Each test's dry run, as `dryRunMain` reports it; checked, and bounded. */
const dryRunsSchema = z
  .array(
    z.object({
      name: z.string().max(200),
      status: z.enum(["completed", "failed"]),
      report: z.string().max(maxDryRunReport),
    })
  )
  .max(maxDryRuns);

/** Each test's dry run of a workflow. */
export type DryRuns = z.infer<typeof dryRunsSchema>;

/**
 * The shared part of both main modules: settling a call into plain data
 * and back.
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
 * the App's code has: the built-ins it keeps here (`Proxy`, `Error`,
 * `Object.hasOwn`) are the runtime's, whatever the workflow's module
 * puts in their place as it loads, and it builds with nothing else a
 * module could replace (no array or object method, and no assignment a
 * setter on `Object.prototype` would see). So nothing the App's code does
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
const runBindingsModule = "grasp-run-bindings.js";

/** What a binding called outside any step fails with, in the isolate. */
const outsideStep = workflowErrors.create("workflow.outside_step");
const runBindings = `import { AsyncLocalStorage } from "node:async_hooks";

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

const collectionMethods = ${JSON.stringify(collectionMethods)};

export const bindings = ({ connections, apps, collections }) => {
  const all = {
    __proto__: null,
    APP: {
      call: async (method, ...args) => unwrapped(await currentAttempt().callApp(method, args)),
      callFunction: async (reference, input) =>
        unwrapped(await currentAttempt().callFunction(reference, input)),
    },
  };
  for (let index = 0; index < collections.length; index += 1) {
    const name = collections[index];
    const methods = { __proto__: null };
    for (let at = 0; at < collectionMethods.length; at += 1) {
      const method = collectionMethods[at];
      methods[method] = async (...args) =>
        unwrapped(await currentAttempt().callCollection(name, method, args));
    }
    all[name] = methods;
  }
  for (let index = 0; index < connections.length; index += 1) {
    const name = connections[index];
    all[name] = {
      call: async (action, input, options) =>
        unwrapped(await currentAttempt().callConnection(name, [action, input, options])),
    };
  }
  for (let index = 0; index < apps.length; index += 1) {
    const name = apps[index];
    all[name] = {
      call: async (method, input) => unwrapped(await currentAttempt().callExport(name, method, input)),
    };
  }
  return guarded(all);
};
`;

/**
 * The main module of a run of workflow `id`: the engine the SDK runs on,
 * each of its calls sent to core's host (host.ts), and each error in plain
 * data both ways. Every binding (its App, its collections, connections
 * and other Apps' exports), and what the SDK does inside a step (a model
 * call, a decision), goes through the host of the attempt whose code makes
 * it, which core hands each attempt's function. A binding the run doesn't have (a permission revoked since, or
 * never granted) fails with a permission error, not `undefined`. It
 * imports what builds the bindings (`runBindings`), then the SDK's
 * `workflow`, before the workflow's module: the bindings are built from
 * the runtime's own built-ins, and the definition the SDK makes is frozen
 * with the runtime's `Object.freeze`, so no module replaces its `run`.
 */
const runMain = (
  id: WorkflowId
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
import { bindings, currentAttempt, inAttempt, unwrapped } from ${JSON.stringify(runBindingsModule)};
import ${JSON.stringify(kitModuleName("@grasp-os/sdk/workflow"))};
import definition from ${JSON.stringify(appModuleName(workflowPaths(id).workflow))};
${settling}

export class Run extends WorkerEntrypoint {
  async run(host, { runId, params, input, connections, apps, collections }) {
    return await settled(async () => {
      if (definition?.metadata?.id !== ${JSON.stringify(id)} || typeof definition.run !== "function") {
        throw new Error(${JSON.stringify(`workflows/${id}.ts must export the workflow "${id}" as its default export.`)});
      }
      const engine = {
        runId,
        params,
        env: bindings({ connections, apps, collections }),
        do: async (name, options, fn) => unwrapped(await host.do(name, options, async (attempt) => await inAttempt(attempt, async () => await settled(fn)))),
        sleep: async (name, milliseconds) => unwrapped(await host.sleep(name, milliseconds)),
        callModel: async (request) => unwrapped(await currentAttempt().callModel(request)),
        openDecision: async (request) => unwrapped(await currentAttempt().openDecision(request)),
        decisionRecipients: async (decision, reminder) => unwrapped(await currentAttempt().decisionRecipients(decision, reminder)),
        waitForDecision: async (name, options) => unwrapped(await host.waitForDecision(name, options)),
        readAttachment: async (stored, index) => unwrapped(await currentAttempt().readAttachment(stored, index)),
      };
      return await definition.run(engine, input);
    });
  }
}
`;

/** The main module that runs workflow `id`'s tests (`runWorkflowTests`). */
const testsMain = (
  id: WorkflowId,
  calls: string
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
import { runWorkflowTests } from ${JSON.stringify(kitModuleName("@grasp-os/sdk/testing"))};
import tests from ${JSON.stringify(appModuleName(workflowPaths(id).tests))};
${settling}
export class Tests extends WorkerEntrypoint {
  async run() {
    return await settled(async () => {
      if (tests?.definition?.metadata?.id !== ${JSON.stringify(id)}) {
        throw new Error(${JSON.stringify(`workflows/${id}.workflow-tests.ts must export the tests of "${id}" as its default export.`)});
      }
      return JSON.parse(JSON.stringify(await runWorkflowTests(tests, ${calls})));
    });
  }
}
`;

/**
 * The main module that dry-runs each of workflow `id`'s tests
 * (`dryRun`), with the parameter values core passes over each test's own.
 * Each report is cut to what core keeps of it.
 */
const dryRunMain = (
  id: WorkflowId,
  calls: string
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
import { dryRun } from ${JSON.stringify(kitModuleName("@grasp-os/sdk/testing"))};
import tests from ${JSON.stringify(appModuleName(workflowPaths(id).tests))};
${settling}
export class DryRuns extends WorkerEntrypoint {
  async run(params) {
    return await settled(async () => {
      if (tests?.definition?.metadata?.id !== ${JSON.stringify(id)}) {
        throw new Error(${JSON.stringify(`workflows/${id}.workflow-tests.ts must export the tests of "${id}" as its default export.`)});
      }
      const runs = [];
      for (const { name, expect: _expect, ...options } of tests.tests.slice(0, ${maxDryRuns})) {
        const run = await dryRun(tests.definition, { ...options, params: { ...options.params, ...params }, calls: ${calls} });
        runs.push({ name: String(name).slice(0, 200), status: run.status, report: run.report.slice(0, ${maxDryRunReport}) });
      }
      return runs;
    });
  }
}
`;

/**
 * The main module that reads workflow `id`'s metadata from its code: its
 * parameters and its triggers.
 */
const metadataMain = (
  id: WorkflowId
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
import definition from ${JSON.stringify(appModuleName(workflowPaths(id).workflow))};
${settling}
export class Metadata extends WorkerEntrypoint {
  async read() {
    return await settled(async () => {
      if (definition?.metadata?.id !== ${JSON.stringify(id)}) {
        throw new Error(${JSON.stringify(`workflows/${id}.ts must export the workflow "${id}" as its default export.`)});
      }
      const { params, triggers } = definition.metadata;
      return JSON.parse(JSON.stringify({ params, triggers }));
    });
  }
}
`;

/** The workflows in an App version's files, by ID. */
export const workflowIdsIn = (files: AppFiles): WorkflowId[] =>
  Object.keys(files).flatMap((path) => {
    const id = workflowIdOf(path);
    return id === undefined ? [] : [workflowIdSchema.parse(id)];
  });

/** Whether `id` is one of the workflows in `files`. */
export const hasWorkflow = (files: AppFiles, id: string): boolean =>
  workflowIdsIn(files).some((workflow) => workflow === id);

/**
 * What workflow `id` in `files` calls of the App's bindings, as a review
 * of it shows them (`reviewedCalls`): what a version keeps of each of its
 * workflows as it is committed (`workflowCallsIn`), which its runs are
 * held to, and what its tests and dry runs are held to, so a call a run
 * would refuse fails before the version is made current.
 */
export const workflowCallsOf = (
  files: AppFiles,
  id: WorkflowId
): WorkflowCalls => reviewedCalls(files[workflowPaths(id).workflow] ?? "");

/** What each workflow in a version's `files` calls, by ID (`workflowCallsOf`). */
export const workflowCallsIn = (
  files: AppFiles
): Record<string, WorkflowCalls> =>
  Object.fromEntries(
    workflowIdsIn(files).map((id) => [id, workflowCallsOf(files, id)])
  );

/** `workflowCallsOf`, as JavaScript for a main module. */
const callsOf = (files: AppFiles, id: WorkflowId): string =>
  JSON.stringify(workflowCallsOf(files, id));

/**
 * An App version's workflows built into modules (cached in R2), with the
 * SDK's modules they import.
 */
const modulesOf = async (
  env: Env,
  app: AppId,
  version: number,
  files: AppFiles,
  /** Given up on: no compile starts, and it throws its reason. */
  signal?: AbortSignal
): Promise<Record<string, string>> => {
  const build = await buildWorkflows(env, files, app, signal);
  signal?.throwIfAborted();
  if (!build.ok) {
    throw workflowErrors.create("workflow.build_failed", {
      version,
      diagnostics: build.diagnostics.map(({ file, line, rule, message }) => ({
        file: file ?? null,
        line: line ?? null,
        category: diagnosticCategory(rule),
        message,
      })),
    });
  }
  const sdk = await workflowSdkModules(env.ASSETS);
  return { ...sdk.modules, ...build.modules };
};

/** What a run's isolate is loaded for: its code. */
export interface RunCode {
  /** Whose run it is: the App, which the sandbox caps per owner. */
  app: AppId;
  /** The version the run is pinned to. */
  version: number;
  workflow: WorkflowId;
  /** The version's files (`versionFiles`). */
  files: AppFiles;
}

/**
 * The host's calls a run's code makes (`RunHost`'s, host.ts): its main
 * module calls only these (`runMain`), and on-prem the isolate gets no
 * other.
 */
export interface RunHostCalls<Attempt = AttemptHost> {
  do: (
    name: unknown,
    options: unknown,
    /**
     * The attempt's function in the isolate, handed the host minted for
     * that attempt: an App run's `AttemptHost`, or an independent
     * workflow's (resource-host.ts).
     */
    fn: (attempt: Attempt) => Promise<unknown>
  ) => Promise<Settled<unknown>>;
  sleep: (name: unknown, duration: unknown) => Promise<Settled<null>>;
  /**
   * A durable sleep until a deadline its step recorded: an independent
   * workflow's (resource-host.ts); an App's run has none.
   */
  sleepUntil?: (name: unknown, until: unknown) => Promise<Settled<null>>;
  waitForDecision: (
    name: unknown,
    options: unknown
  ) => Promise<Settled<unknown>>;
}

/** A run's code, loaded: `run` runs it once, from its start or a resume. */
export interface RunLoad {
  run: (host: RunHostCalls & RpcTarget, start: RunStart) => Promise<unknown>;
}

/**
 * The longest one load of a run may take on-prem, in wall-clock time: from
 * its start or a resume to its next wait, the supervisor's longest session.
 * A load past it is stopped, as the App's: its steps wait on model and
 * connector calls, which cost it no CPU time, and its CPU time is bounded
 * on its own (`workflowSandbox`).
 */
const runLoadMs = 15 * 60_000;

/**
 * How long a run's load waits, in all, for a place in the sandbox: its
 * App's runs may hold their share, and other calls the pool, for as long
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
 * (`sessionRunHost`): the session ends at once when its process does.
 */
const verdictWaitMs = 5000;

/**
 * Whose a run's loads are in the sandbox: the App's runs, an owner apart
 * from the App's interactive calls (its functions, screens, Code Mode,
 * metadata and tests), so runs, whose loads hold their places for as long
 * as their steps take, never hold the places those wait for.
 */
export const runOwnerOf = (app: AppId): string => `workflow:${app}`;

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
export const attemptMethods = Object.keys(attemptCallLabels);

/** The run's session, as the capabilities passed during it see it. */
export interface RunSession {
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
  session: RunSession
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
 * `host` as the run's capability in a session: its three calls, and the
 * attempt host each step's function gets, passed as a capability of its
 * calls alone, live while that function runs and the session's call is
 * open (`passedCapability`). A function that fails rather than answering
 * fails its step as `stepCodeFailure` says.
 */
export const sessionRunHost = <Attempt extends object = AttemptHost>(
  host: RunHostCalls<Attempt>,
  session: RunSession,
  /** The calls each attempt host passes: an App run's, unless given. */
  methods: readonly string[] = attemptMethods
): RunHostCalls<Attempt> => ({
  do: async (name, options, fn) => {
    if (typeof fn !== "function") {
      return await host.do(name, options, fn);
    }
    return await host.do(name, options, async (attempt) => {
      let live = true;
      try {
        return await fn(
          // SAFETY: what the sandbox host makes of a passed capability
          // for the isolate: `fn` is the isolate's, over the session.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          passedCapability(
            attempt,
            methods,
            () => live && session.live()
          ) as never
        );
      } catch (error) {
        throw await stepCodeFailure(error, session);
      } finally {
        live = false;
      }
    });
  },
  sleep: async (name, duration) => await host.sleep(name, duration),
  sleepUntil: async (name, until) =>
    host.sleepUntil === undefined
      ? {
          ok: false,
          error: { name: "Error", message: "This run has no sleep until." },
        }
      : await host.sleepUntil(name, until),
  waitForDecision: async (name, options) =>
    await host.waitForDecision(name, options),
});

/**
 * What a run's load failing on-prem fails the run with: past its CPU
 * time, the Loader's CPU kill, for `afterCpuKill`; the sandbox stopping
 * its code otherwise (its memory or time past, its process gone, what it
 * sent refused) as the App's, a workflow error saying so; anything else
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

/** How a run's load is let go of (`loadRun`). */
export interface LoadOptions {
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
 * What a run's isolate is loaded with, whatever workflow runs in it: an
 * App's (`loadRun`) or an independent workflow's sealed build
 * (resource-runs.ts). Its main module's `Run` entrypoint takes the host's
 * calls and the run's start.
 */
export interface RunIsolate {
  /** Whose runs it is among, which the sandbox caps per owner. */
  owner: string;
  mainModule: string;
  modules: () => Promise<Record<string, string>>;
  /** The calls each step's attempt host passes its code on-prem. */
  attemptMethods: readonly string[];
}

/**
 * A run's isolate, loaded as `loadRun` loads an App's (see there). Each
 * load's code is held to the activation's budget of time between steps
 * (between-steps.ts): past it, its call fails with
 * `workflow.between_steps_limit`, and is let go of.
 */
export const loadRunIsolate = <Attempt extends object = AttemptHost>(
  env: Env,
  { owner, mainModule, modules, attemptMethods: methods }: RunIsolate,
  { over, current = () => true, onSession }: LoadOptions = {}
): {
  run: (
    host: RunHostCalls<Attempt> & RpcTarget,
    start: unknown
  ) => Promise<unknown>;
} => {
  const sandboxHost = sessionHost(env);
  const budgetMs = betweenStepsBudgetOf(env);
  if (sandboxHost === undefined) {
    return {
      run: async (host, start) => {
        // Read before the clock starts: none of the run's code runs yet.
        const loaded = await modules();
        const entrypoint = env.LOADER.get(null, () => ({
          ...workflowSandbox,
          mainModule,
          modules: loaded,
          env: {},
        })).getEntrypoint<RunEntrypoint>("Run");
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
      const session: RunSession = {
        live: () => sessionLive?.() === true && over?.aborted !== true,
        ended: ended.promise,
      };
      const clock = betweenSteps(budgetMs);
      const call = {
        mainModule,
        modules: await modules(),
        entrypoint: "Run",
        method: "run",
        args: [
          {
            capability: capability(
              sessionRunHost(new BoundedRunHost(host, clock), session, methods),
              ["do", "sleep", "sleepUntil", "waitForDecision"]
            ),
          },
          { value: start },
        ],
        owner,
        cpuMs: workflowSandbox.limits.cpuMs,
        wallMs: runLoadMs,
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

/**
 * The run's main module, in an isolate of its own running the run's
 * pinned version. Each load is a new isolate, which nothing else shares
 * (it has no name): its env is empty, as every binding it has goes
 * through the host, and no two runs, or loads of one run, share memory.
 * Loads are few: a run's start, and each resume after a wait.
 *
 * On-prem it runs as a sandbox session of its own, owned by the App's runs
 * (`runOwnerOf`), its CPU time and memory bounded by the supervisor, with
 * only the host's calls (`sessionRunHost`). `over` says the activation it
 * runs for is over (a wait suspended it, which never settles its call):
 * the session ends then, freeing its process, and a load waiting for a
 * place stops waiting: a cancel, which ends the activation, so stops it.
 * A pause is taken at the first step boundary once loaded, as the engine
 * takes every pause.
 */
export const loadRun = (
  env: Env,
  { app, version, workflow, files }: RunCode,
  options: LoadOptions = {}
): RunLoad =>
  loadRunIsolate(
    env,
    {
      owner: runOwnerOf(app),
      mainModule: runModule,
      modules: async () => ({
        ...(await modulesOf(env, app, version, files)),
        [runBindingsModule]: runBindings,
        [runModule]: runMain(workflow),
      }),
      attemptMethods,
    },
    options
  );

/** The most of why an isolate didn't start that a failure keeps. */
const maxLoadFailure = 500;

/**
 * workerd's "Failed to start Worker" message: first line, and what threw.
 * Should workerd word it otherwise, a start failure no longer matches, and
 * shows as the platform's error (`internal.unexpected`), never as passing.
 */
const failedStart = /^Failed to start Worker:\n(?:Uncaught )?(?<cause>.*)/u;

/**
 * What threw as an isolate's code loaded, without the stack, when `error`
 * is workerd's "Failed to start Worker"; nothing for any other error.
 */
export const startFailure = (error: unknown): string | undefined => {
  const cause =
    error instanceof Error
      ? failedStart.exec(error.message)?.groups?.cause
      : undefined;
  return cause?.slice(0, maxLoadFailure);
};

/**
 * Whether `error` is the workflow code's failure to load or finish: a
 * module that threw as it loaded, or (on-prem) the sandbox ending it past
 * its CPU time, memory or time. Anything else is the platform's.
 */
export const codesFailure = (error: unknown): string | undefined => {
  const verdict = sandboxVerdictOf(error);
  if (verdict !== undefined && codesVerdicts.has(verdict)) {
    return error instanceof Error ? error.message : "it was stopped";
  }
  return startFailure(error);
};

/**
 * What workflow `id` declares at an App version (with its `files`), read
 * from its code in an isolate of their own, kept by the loader for that
 * version: a version's code never changes. Each part is checked by
 * whoever reads it, so a part one reader doesn't know stops only that
 * reader. `workflow.invalid` for code that doesn't load or say.
 */
const declaredMetadata = async (
  env: Env,
  app: AppId,
  version: number,
  id: WorkflowId,
  files: AppFiles
): Promise<{ params?: unknown; triggers?: unknown }> => {
  // Refused before anything is read where no sandbox may run it.
  sessionHost(env);
  // Read once a version: its code never changes, and every run load,
  // parameter read and trigger registration asks again. Kept where its
  // builds are (screens.ts), as what it read, never what it refused.
  const cacheKey = `workflow-metadata/${app}/${version}/${id}/${compilerVersion}.json`;
  const cached = await env.FILES.get(cacheKey);
  if (cached !== null) {
    const kept = declaredMetadataSchema.safeParse(await cached.json());
    if (kept.success) {
      return kept.data;
    }
  }
  let outcome: Settled<unknown>;
  try {
    outcome = fromIsolate(
      await isolateCall(env, {
        key: `workflow-metadata:${app}:${version}:${id}:${compilerVersion}`,
        owner: app,
        mainModule: metadataModule,
        modules: async () => ({
          ...(await modulesOf(env, app, version, files)),
          [metadataModule]: metadataMain(id),
        }),
        entrypoint: "Metadata",
        method: "read",
        args: [],
      })
    );
  } catch (error) {
    // A module threw as it loaded (a definition the SDK refuses), or it
    // ran past its bounds: the code's failure, as `workflow.invalid`.
    // Anything else is the platform's.
    if (codesFailure(error) === undefined) {
      throw error;
    }
    throw workflowErrors.create("workflow.invalid");
  }
  const metadata = outcome.ok
    ? declaredMetadataSchema.safeParse(outcome.value)
    : undefined;
  if (metadata?.success !== true) {
    throw workflowErrors.create("workflow.invalid");
  }
  await env.FILES.put(cacheKey, JSON.stringify(metadata.data));
  return metadata.data;
};

/** The parameters workflow `id` declares at an App version. */
export const declaredParams = async (
  env: Env,
  app: AppId,
  version: number,
  id: WorkflowId,
  files: AppFiles
): Promise<DeclaredParam[]> => {
  const { params } = await declaredMetadata(env, app, version, id, files);
  const parsed = declaredParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  return parsed.data;
};

/**
 * The triggers workflow `id` declares at an App version; none for a
 * definition that doesn't say (one not written with the SDK).
 */
export const declaredTriggers = async (
  env: Env,
  app: AppId,
  version: number,
  id: WorkflowId,
  files: AppFiles
): Promise<TriggerDeclaration[]> => {
  const { triggers } = await declaredMetadata(env, app, version, id, files);
  const parsed = triggerDeclarationsSchema.optional().safeParse(triggers);
  if (!parsed.success) {
    throw workflowErrors.create("workflow.invalid");
  }
  return parsed.data ?? [];
};

/** What a run of tests says: why they fail (none: they pass), and whether that may be kept. */
export interface TestOutcome {
  failures: string[];
  /**
   * Whether it says what the code does, and may be kept for the version:
   * not when its isolate crashed, which may be the sandbox's doing.
   */
  keep: boolean;
}

/**
 * Why workflow `id`'s tests fail on a version's `modules`, one line each;
 * none if they pass. They run App code, once, as the version is made
 * current, in an isolate with no name, which nothing else shares and which
 * goes once they are done: workerd keeps a named isolate, the SDK's
 * modules in it, for as long as the process runs.
 */
export const testOutcomeOf = async (
  env: Pick<
    Env,
    "LOADER" | "RUNTIME_PROFILE" | "SANDBOX_HOST" | "SANDBOX_IN_PROCESS"
  >,
  app: AppId,
  id: WorkflowId,
  modules: Record<string, string>,
  calls: string,
  /** Gives up on the tests' isolate, and throws its reason. */
  signal?: AbortSignal
): Promise<TestOutcome> => {
  let outcome: Settled<unknown>;
  try {
    outcome = fromIsolate(
      await isolateCall(env, {
        key: null,
        owner: app,
        mainModule: testsModule,
        modules: async () =>
          await Promise.resolve({
            ...modules,
            [testsModule]: testsMain(id, calls),
          }),
        entrypoint: "Tests",
        method: "run",
        args: [],
        ...(signal === undefined ? {} : { signal }),
      })
    );
  } catch (error) {
    // Given up on, not the code's failure.
    if (signal?.aborted === true) {
      throw signal.reason;
    }
    // The isolate didn't start because a module threw as it loaded, such
    // as a workflow whose definition the SDK refuses, or it ran past its
    // bounds: the code's failure, reported as its tests'. Anything else is
    // the platform's.
    const cause = codesFailure(error);
    if (cause === undefined) {
      throw error;
    }
    return {
      failures: [`${id}: its code doesn't load: ${cause}`],
      // A crash may be the sandbox's own (its process killed from outside)
      // as much as the code's: reported, never kept.
      keep: sandboxVerdictOf(error) !== "crashed",
    };
  }
  if (!outcome.ok) {
    return { failures: [`${id}: ${outcome.error.message}`], keep: true };
  }
  const report = testReportSchema.safeParse(outcome.value);
  if (!report.success) {
    return {
      failures: [`${id}: its tests didn't report as the test harness does`],
      keep: true,
    };
  }
  const { passed, results } = report.data;
  if (results.length === 0) {
    return { failures: [`${id}: has no tests`], keep: true };
  }
  return {
    keep: true,
    failures: passed
      ? []
      : results.flatMap(({ name, failures }) =>
          failures.map((failure) => `${id}, "${name}": ${failure}`)
        ),
  };
};

/**
 * Dry-runs each of workflow `id`'s tests at an App version (with its
 * `files`), with `params` over each test's own values, in an isolate of
 * their own with an empty env: nothing a dry run does leaves it. The
 * loader keeps the isolate for that version, whose code never changes;
 * the values go with each call. A current version's workflows all have
 * tests (`requireWorkflowTestsPass`).
 */
export const dryRunTests = async (
  env: Env,
  app: AppId,
  version: number,
  id: WorkflowId,
  files: AppFiles,
  params: Record<string, string | number>,
  /**
   * For a chat's draft over `version` (agent-builds.ts): its isolate is
   * loaded unnamed, never kept, as a draft's code changes with each write.
   */
  {
    draft = false,
    signal,
  }: {
    draft?: boolean;
    /** Gives up on the dry runs, freeing their process at once on-prem. */
    signal?: AbortSignal;
  } = {}
): Promise<DryRuns> => {
  const calls = callsOf(files, id);
  let outcome: Settled<unknown>;
  try {
    outcome = fromIsolate(
      await isolateCall(env, {
        key: draft
          ? null
          : `workflow-dry-run:${app}:${version}:${id}:${compilerVersion}`,
        owner: app,
        mainModule: dryRunModule,
        modules: async () => ({
          ...(await modulesOf(env, app, version, files)),
          [dryRunModule]: dryRunMain(id, calls),
        }),
        entrypoint: "DryRuns",
        method: "run",
        args: [params],
        ...(signal === undefined ? {} : { signal }),
      })
    );
  } catch (error) {
    // As for parameters: a module that threw as it loaded, or one that ran
    // past its bounds, is the code's failure, anything else the platform's.
    if (codesFailure(error) === undefined) {
      throw error;
    }
    throw workflowErrors.create("workflow.invalid");
  }
  const runs = outcome.ok ? dryRunsSchema.safeParse(outcome.value) : undefined;
  if (runs?.success !== true) {
    throw workflowErrors.create("workflow.invalid");
  }
  return runs.data;
};

/**
 * Runs the tests of the workflows in an App's `files` (its `version`, or
 * the version a chat's draft is over, for errors), and says what fails:
 * nothing when all pass, or there are no workflows. Refuses workflows that
 * don't build (`workflow.build_failed`).
 */
export const workflowTestOutcome = async (
  env: Env,
  /** Whose tests they are: the App, which the sandbox caps per owner. */
  app: AppId,
  version: number,
  files: AppFiles,
  /**
   * Aborted once the tests are no one's (a build job's lease lost): the
   * test running is given up, none starts after, and it throws its reason.
   */
  signal?: AbortSignal
): Promise<TestOutcome> => {
  const ids = workflowIdsIn(files);
  if (ids.length === 0) {
    return { failures: [], keep: true };
  }
  // Refused before anything is built where no sandbox may run them.
  sessionHost(env);
  signal?.throwIfAborted();
  const modules = await modulesOf(env, app, version, files, signal);
  const failures: string[] = [];
  let keep = true;
  for (const id of ids) {
    if (Object.hasOwn(files, workflowPaths(id).tests)) {
      const calls = callsOf(files, id);
      // oxlint-disable-next-line no-await-in-loop -- one isolate at a time
      const outcome = await testOutcomeOf(env, app, id, modules, calls, signal);
      failures.push(...outcome.failures);
      keep &&= outcome.keep;
    } else {
      // Often a helper, not a workflow: say where shared code goes.
      failures.push(
        `${id}: has no tests (${workflowPaths(id).tests}). Only \`workflows/<id>.ts\` (an id without dots) is a workflow: put shared code in a folder under workflows/, such as workflows/lib/.`
      );
    }
  }
  return { failures, keep };
};

/** Why the workflows' tests in `files` fail (`workflowTestOutcome`). */
export const workflowTestFailures = async (
  env: Env,
  /** Whose tests they are: the App, which the sandbox caps per owner. */
  app: AppId,
  version: number,
  files: AppFiles,
  signal?: AbortSignal
): Promise<string[]> => {
  const { failures } = await workflowTestOutcome(
    env,
    app,
    version,
    files,
    signal
  );
  return failures;
};

/**
 * Refuses a version (with its `files`) whose workflows don't build, or
 * whose workflows' tests fail or are missing (`workflow.tests_failed`), so
 * no such version is made current. A version without workflows passes.
 */
export const requireWorkflowTestsPass = async (
  env: Env,
  app: AppId,
  version: number,
  files: AppFiles
): Promise<void> => {
  const failures = await workflowTestFailures(env, app, version, files);
  if (failures.length > 0) {
    throw workflowErrors.create("workflow.tests_failed", {
      version,
      failures,
    });
  }
};
