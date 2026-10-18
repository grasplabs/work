import {
  appModuleName,
  kitModuleName,
  workflowSdkModules,
} from "@grasp-os/compiler";
import type { ContractLookup } from "@grasp-os/open-workflow/catalog";
import { schemaFromDescriptor } from "@grasp-os/sdk/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { valueDepth } from "@grasp-os/shared/value-depth";
import {
  actionUseAliasPattern,
  actionUseSchema,
  workflowModuleLimits,
} from "@grasp-os/shared/workflow-modules";
import type { ActionUse, SealedUse } from "@grasp-os/shared/workflow-modules";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import type { WorkflowVersionAction } from "@grasp-os/shared/workflow-resources";
import { z } from "zod";

import { callSandboxed, SandboxUnavailableError } from "./sandboxed.ts";
import type { SandboxedEnv } from "./sandboxed.ts";
import { buildComputeModules, withinBuildWait } from "./screens.ts";

// A JSON workflow's own modules (platform specification 13.6, 32.4):
// TypeScript files under `code/`, published with the definition, whose
// `compute()` exports its `grasp.compute` tasks call, and whose `action()`
// exports its `grasp.operation` tasks call (resource-action.ts), each
// through a `local:code/<file>.ts#<export>` binding. An action's contract
// also lists the workflow's own bindings it uses, which validation checks
// against the definition and counts as referenced. This module builds them and
// reads their contracts as a version is published, and runs one
// calculation for a run (`runCompute`). workflow-builds.ts seals what it
// builds with the version.
//
// Threat model, and how each is closed (GRA-271 has it in full):
//
// - Module code reaching past its bindings (the network, storage, secrets,
//   core, the run's engine). It only ever runs through `callSandboxed`, as
//   App inspection and migration transforms do: an isolate with no env, no
//   bindings and no outbound network, bounded in CPU by the runtime on
//   Cloudflare and killed by the sandbox supervisor on-prem (its deadline,
//   memory, a crash). Each call is a fresh isolate, so nothing of one call
//   or run is left for the next, and it gets one validated value, never a
//   step, an env, a receipt or a stub. It never runs in a run's isolate:
//   the host makes the call from the sealed task table.
// - Imports past the SDK. The compiler builds them as their own kind
//   (`computeCode`): their own files and `@grasp-os/sdk/compute` only, so
//   no Workers runtime, no other SDK entry and no package, type-checked
//   against that SDK. A workflow's builders may have packages approved
//   for its compute modules (`computation`, dependencies/subjects.ts),
//   and build them (packages/build.ts), but none is imported yet: imports
//   come with sealing them into a version and admitting them at every
//   start and compute call (slice 3 of GRA-665).
// - The clock, randomness, timers and generated code. The isolate takes
//   them away before any module of the workflow's evaluates (the SDK's
//   compute-lockdown.ts), on the global object and every prototype of it,
//   for good, and refuses to run if it couldn't; and a handler answers
//   synchronously, so it hides no effect behind a wait. Taking `eval` and
//   `Function` away also keeps generated code from importing modules the
//   compiler never let the module name. Defense in depth: the boundary is
//   the empty env, and the step records the answer, so a replay never
//   calls the module again.
// - A contract that isn't what the module declares. The contracts are
//   read once, by an inspection in the same sandbox; `compute()`'s brand
//   keeps a plain object from counting by mistake, but it is a correctness
//   aid, not a boundary (module code runs in the isolate that holds it).
//   Nothing rests on it: a contract is whatever its author declares, so a
//   forged one grants nothing an honest one couldn't. What the inspection
//   answers is checked here: bounded, each key naming a published module
//   and an export name, each descriptor one the SDK reads. The contracts
//   are sealed with the version and covered by its executable identity; a
//   run checks its call against the sealed contract on both sides, never
//   against anything the module says then.
// - Answers past their bounds or contract. The input must be what the
//   contract takes exactly, within a step's payload; the answer is read
//   only within that bound, and must be what the output contract takes
//   exactly (`workflow.call_invalid` otherwise). A handler that throws, or
//   that the sandbox stopped, fails the call as `workflow.compute_failed`,
//   its message never kept: module code chooses it, and it could carry
//   the run's data into a failure others read.

/** A compute contract, as sealed: its descriptors' JSON text. */
export interface ComputeContract {
  /** A calculation (`compute`), or an action (`operation`). */
  readonly kind: "compute" | "operation";
  readonly input: string;
  readonly output: string;
  /**
   * An action's: the workflow's own bindings it uses, by alias and kind,
   * a connector's with the operations it calls.
   */
  readonly uses?: readonly SealedUse[];
}

/** `use` copied and frozen, its operations with it. */
export const sealedUse = (use: ActionUse | SealedUse): SealedUse => {
  switch (use.kind) {
    case "connector": {
      return Object.freeze({
        alias: use.alias,
        kind: use.kind,
        operations: Object.freeze([...use.operations]),
      });
    }
    case "model": {
      return Object.freeze({
        alias: use.alias,
        kind: use.kind,
        output: use.output,
      });
    }
    case "operation": {
      return Object.freeze({ alias: use.alias, kind: use.kind });
    }
    default: {
      return use satisfies never;
    }
  }
};

/** A version's compute modules, built and inspected for sealing. */
export interface CompiledModules {
  /** The modules exactly as published, by path (`code/<file>.ts`). */
  readonly sources: Readonly<Record<string, string>>;
  /** Their compiled code, by flat name. */
  readonly modules: Readonly<Record<string, string>>;
  /** Each calculation's contract, by `code/<file>.ts#<export>`. */
  readonly contracts: ReadonlyMap<string, ComputeContract>;
  /** What the inspection answered, which `contracts` were read from. */
  readonly manifest: string;
}

/** What validation resolves `local:` keys against: modules' contracts. */
export type ModuleContracts = Pick<CompiledModules, "contracts">;

/** The hash a version's modules are published under: of their canonical JSON. */
export const modulesHashOf = async (
  sources: Readonly<Record<string, string>>
): Promise<string> => await sha256Hex(canonicalJson({ ...sources }));

/** The most diagnostics a refusal names. */
const maxDiagnostics = 50;
/** The most of one diagnostic's message a refusal keeps. */
const maxMessage = 500;
/** The most characters an inspection may answer. */
const inspectionMaxLength = 1024 * 1024;
/** How deep a manifest's JSON may nest (see `contractsOf`). */
const manifestMaxDepth = 2 * valueDepth + 8;
/** The most calculations one version's modules export. */
const maxContracts = workflowModuleLimits.contracts;

/** What a JSON number, boolean or null starts with. */
const scalarStart = /^[-0-9tfn]$/u;

/**
 * How deep the JSON text `text` nests, as the SDK counts a value's depth
 * (`valueDepth`): the value itself is one level, and each array item or
 * object member one level below its container, so `[]` is 1 and `[1]` is
 * 2. Counted in one pass over the text, so nothing recurses however deep
 * it is. Text that isn't JSON counts as it reads; the parse refuses it
 * after.
 */
export const jsonTextDepth = (text: string): number => {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (inString) {
      if (char === "\\") {
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === "[" || char === "{") {
      depth += 1;
      deepest = Math.max(deepest, depth);
    } else if (char === "]" || char === "}") {
      depth -= 1;
    } else if (char === '"' || scalarStart.test(char)) {
      // A string (a member's name counts as its value would) or a
      // number, boolean or null: one level below its container.
      inString = char === '"';
      deepest = Math.max(deepest, depth + 1);
    }
  }
  return deepest;
};

const invalid = (
  diagnostics: readonly {
    file?: string | undefined;
    line?: number | undefined;
    message: string;
  }[]
) =>
  workflowResourceErrors.create("workflow.modules_invalid", {
    diagnostics: diagnostics
      .slice(0, maxDiagnostics)
      .map(({ file, line, message }) => ({
        file: file ?? null,
        line: line ?? null,
        message: message.slice(0, maxMessage),
      })),
  });

/** The runner and its lockdown, as the SDK's modules name them. */
const runnerModule = kitModuleName("@grasp-os/sdk/compute-runner");

/**
 * The import lines and the object of the modules' namespaces, by path,
 * that a sandbox main module hands the runner. Paths are checked module
 * paths (workflow-modules.ts in shared), written as JSON literals.
 */
const namespacesCode = (
  paths: readonly string[]
): { imports: string; object: string } => ({
  imports: paths
    .map(
      (path, index) =>
        `import * as m${index} from ${JSON.stringify(appModuleName(path))};`
    )
    .join("\n"),
  object: `{ ${paths
    .map((path, index) => `${JSON.stringify(path)}: m${index}`)
    .join(", ")} }`,
});

/** The module that answers in the sandbox. */
const computeMain = "grasp-compute.js";

/**
 * The inspection's main module: the runner first, which takes the clock
 * and randomness away before any of the workflow's modules evaluate.
 */
const inspectMain = (paths: readonly string[]): string => {
  const { imports, object } = namespacesCode(paths);
  return `import { WorkerEntrypoint } from "cloudflare:workers";
import { computeManifestOf } from ${JSON.stringify(runnerModule)};
${imports}

export class Inspect extends WorkerEntrypoint {
  manifest() {
    const text = computeManifestOf(${object});
    if (typeof text !== "string" || text.length > ${inspectionMaxLength}) {
      throw new Error("The modules' contracts are too large.");
    }
    return text;
  }
}
`;
};

/** A key of the manifest: `local:code/<file>.ts#<export>`. */
const manifestKey =
  /^local:(?<module>code\/[^#]+\.ts)#(?<export>[A-Za-z_$][A-Za-z0-9_$]*)$/u;

/**
 * What the version's own actions may do (GRA-709), from `modules`, the
 * contracts sealed into its compute.json in the same publication: one
 * entry per local operation binding the checked definition keeps, by
 * alias. A binding without its action's contract is the platform's fault:
 * validation resolved it against these same contracts.
 */
export const versionActionsOf = (
  bindings: ReadonlyMap<
    string,
    { readonly kind: string; readonly contract: string }
  >,
  modules: CompiledModules | undefined
): WorkflowVersionAction[] => {
  const actions: WorkflowVersionAction[] = [];
  for (const [alias, binding] of bindings) {
    const groups = manifestKey.exec(binding.contract)?.groups;
    if (binding.kind !== "operation" || groups === undefined) {
      continue;
    }
    const contract = modules?.contracts.get(
      `${groups.module}#${groups.export}`
    );
    if (
      groups.module === undefined ||
      groups.export === undefined ||
      contract?.kind !== "operation"
    ) {
      throw new Error(`Binding ${alias} names no sealed action`);
    }
    actions.push({
      binding: alias,
      module: groups.module,
      export: groups.export,
      uses: (contract.uses ?? []).map((use) =>
        use.kind === "connector"
          ? {
              alias: use.alias,
              kind: use.kind,
              operations: [...use.operations],
            }
          : { alias: use.alias, kind: use.kind }
      ),
    });
  }
  return actions.toSorted((a, b) => (a.binding < b.binding ? -1 : 1));
};

const descriptorObject = z.record(z.string(), z.json());

/**
 * A use as the inspection answers it: as sealed (`actionUseSchema`), but a
 * model's output as the descriptor itself, sealed as canonical JSON.
 */
const manifestUseSchema = z.union([
  actionUseSchema,
  z.strictObject({
    alias: z.string().regex(actionUseAliasPattern),
    kind: z.literal("model"),
    output: descriptorObject,
  }),
]);

const manifestSchema = z.record(
  z.string().max(512),
  z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("compute"),
      input: descriptorObject,
      output: descriptorObject,
    }),
    z.strictObject({
      kind: z.literal("operation"),
      input: descriptorObject,
      output: descriptorObject,
      uses: z
        .array(manifestUseSchema)
        .max(workflowModuleLimits.actionUses)
        .refine(
          (uses) => new Set(uses.map(({ alias }) => alias)).size === uses.length
        ),
    }),
  ])
);

/**
 * `use` as the version seals it: a model's output as canonical JSON,
 * within what a load reads back, and a descriptor the SDK reads, or the
 * publication is refused (`invalid` with `where`).
 */
const sealedManifestUse = (
  use: z.infer<typeof manifestUseSchema>,
  where: { file: string; name: string }
): SealedUse => {
  if (use.kind !== "model") {
    return sealedUse(use);
  }
  const output =
    typeof use.output === "string" ? use.output : canonicalJson(use.output);
  let readable = output.length <= workflowModuleLimits.descriptorChars;
  if (readable) {
    try {
      schemaFromDescriptor(output);
    } catch {
      readable = false;
    }
  }
  if (!readable) {
    throw invalid([
      {
        file: where.file,
        message: `${where.name}'s use of \`${use.alias}\` declares an output that isn't a value the SDK reads, within ${workflowModuleLimits.descriptorChars} characters as JSON.`,
      },
    ]);
  }
  return sealedUse({ alias: use.alias, kind: "model", output });
};

/**
 * The contracts the inspection answered in `text`, checked against the
 * published `sources`: each key an export of one of them, each descriptor
 * one the SDK reads, and no more than `maxContracts`.
 */
const contractsOf = (
  text: string,
  sources: Readonly<Record<string, string>>
): Map<string, ComputeContract> => {
  // Bounded so nothing that reads it recurses past what it can: a
  // descriptor takes two JSON levels (its fields and itself) for each level
  // of the value it describes, below the manifest's own two.
  if (jsonTextDepth(text) > manifestMaxDepth) {
    throw invalid([{ message: "The modules' contracts nest too deep." }]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid([{ message: "The modules' contracts aren't JSON." }]);
  }
  const manifest = manifestSchema.safeParse(parsed);
  if (!manifest.success) {
    throw invalid([{ message: "The modules' contracts aren't contracts." }]);
  }
  const entries = Object.entries(manifest.data);
  if (entries.length > maxContracts) {
    throw invalid([
      {
        message: `The modules export more than ${maxContracts} calculations and actions.`,
      },
    ]);
  }
  const contracts = new Map<string, ComputeContract>();
  for (const [key, declared] of entries) {
    const { input, output } = declared;
    const groups = manifestKey.exec(key)?.groups;
    if (
      groups?.module === undefined ||
      groups.export === undefined ||
      !Object.hasOwn(sources, groups.module)
    ) {
      throw invalid([{ message: "A contract names no published module." }]);
    }
    const contract: ComputeContract = {
      kind: declared.kind,
      input: canonicalJson(input),
      output: canonicalJson(output),
      ...(declared.kind === "operation"
        ? {
            uses: declared.uses.map((use) =>
              sealedManifestUse(use, {
                file: groups.module ?? "",
                name: groups.export ?? "",
              })
            ),
          }
        : {}),
    };
    // As the version's load reads it back (workflow-builds.ts): a contract
    // past it would publish and then never load.
    if (
      contract.input.length > workflowModuleLimits.descriptorChars ||
      contract.output.length > workflowModuleLimits.descriptorChars
    ) {
      throw invalid([
        {
          file: groups.module,
          message: `${groups.export}'s input or output takes more than ${workflowModuleLimits.descriptorChars} characters as JSON.`,
        },
      ]);
    }
    try {
      schemaFromDescriptor(contract.input);
      schemaFromDescriptor(contract.output);
    } catch {
      throw invalid([
        {
          file: groups.module,
          message: `${groups.export}'s input or output isn't a value the SDK reads.`,
        },
      ]);
    }
    contracts.set(`${groups.module}#${groups.export}`, contract);
  }
  return contracts;
};

/**
 * `sources` (a version's modules, by path) built, inspected and checked
 * for publication: `workflow.modules_invalid` with diagnostics when they
 * don't build or their code fails as it loads (the author's), and
 * `workflow.build_slow` when building took longer than a publication
 * waits (the platform's, to try again).
 */
export const compileModules = async (
  env: Env,
  sources: Readonly<Record<string, string>>,
  /** Whose build it is: the workflow resource's ID. */
  whose: string
): Promise<CompiledModules> => {
  let built: Awaited<ReturnType<typeof buildComputeModules>> | "late";
  try {
    built = await withinBuildWait(
      env,
      async () => await buildComputeModules(env, { ...sources }, whose)
    );
  } catch (error) {
    if (isExpectedError(error)) {
      throw error;
    }
    log.warn("workflow.modules_build_unfinished", errorFields(error));
    built = "late";
  }
  if (built === "late") {
    throw workflowResourceErrors.create("workflow.build_slow");
  }
  if (!built.ok) {
    throw invalid(built.diagnostics);
  }
  const sdk = await workflowSdkModules(env.ASSETS);
  const paths = Object.keys(sources).toSorted();
  let text: unknown;
  try {
    text = await callSandboxed(
      env,
      {
        mainModule: computeMain,
        // The platform's modules last: no module of the workflow's takes one's name.
        modules: {
          ...built.modules,
          ...sdk.modules,
          [computeMain]: inspectMain(paths),
        },
      },
      "Inspect",
      "manifest"
    );
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      throw error;
    }
    throw invalid([
      {
        // Fixed: what the sandbox or the module's own code said is
        // neither the platform's to pass on nor checked.
        message: "The modules failed as they loaded.",
      },
    ]);
  }
  if (typeof text !== "string" || text.length > inspectionMaxLength) {
    throw invalid([{ message: "The inspection answered something else." }]);
  }
  return {
    sources: Object.freeze({ ...sources }),
    modules: Object.freeze({ ...built.modules }),
    contracts: contractsOf(text, sources),
    manifest: text,
  };
};

/**
 * The contracts of `sources` from what an inspection of exactly them
 * answered before (`CompiledModules.manifest`), checked again as they
 * were then: for checking a definition against, never for sealing, which
 * builds and inspects them afresh.
 */
export const contractsFromManifest = (
  manifest: string,
  sources: Readonly<Record<string, string>>
): ModuleContracts => ({ contracts: contractsOf(manifest, sources) });

/**
 * The module manifest validation resolves `local:` keys against: each
 * calculation `compiled` exports, as a compute contract.
 */
export const moduleLookup =
  (compiled: ModuleContracts | undefined): ContractLookup =>
  (key) => {
    const groups = manifestKey.exec(key)?.groups;
    const contract =
      groups === undefined
        ? undefined
        : compiled?.contracts.get(`${groups.module}#${groups.export}`);
    return contract === undefined
      ? undefined
      : {
          kind: contract.kind,
          input: contract.input,
          output: contract.output,
          ...(contract.uses === undefined
            ? {}
            : { uses: contract.uses.map(sealedUse) }),
        };
  };

/** One calculation of a version's sealed modules, as a run calls it. */
export interface ComputeCall {
  /** The version's compiled modules and the SDK's, by flat name. */
  readonly modules: Readonly<Record<string, string>>;
  readonly sdk: Readonly<Record<string, string>>;
  /** Every module path of the version, so each loads as published. */
  readonly paths: readonly string[];
  readonly module: string;
  readonly export: string;
  readonly input: unknown;
}

/**
 * The run's main module: the runner first, as at inspection; then the
 * request, as data (JSON is a JavaScript expression), and the modules.
 */
const runMain = (paths: readonly string[]): string => {
  const { imports, object } = namespacesCode(paths);
  return `import { WorkerEntrypoint } from "cloudflare:workers";
import { runCompute } from ${JSON.stringify(runnerModule)};
import request from "grasp-compute-request.js";
${imports}

export class Compute extends WorkerEntrypoint {
  run() {
    return runCompute(${object}, request);
  }
}
`;
};

/** The answer of a run, as the host reads it: bounded before it is parsed. */
const answerSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), output: z.string() }),
  z.strictObject({ ok: z.literal(false), message: z.string() }),
]);

/**
 * The module a run's isolate reads its request from: parsed from JSON text,
 * as the host checked it (in an object literal, a "__proto__" key would
 * set a prototype instead). It evaluates before any of the workflow's
 * modules (the main module imports it right after the runner).
 */
export const requestModule = (call: {
  readonly module: string;
  readonly export: string;
  readonly input: unknown;
}): Record<string, string> => ({
  "grasp-compute-request.js": `export default JSON.parse(${JSON.stringify(
    JSON.stringify({
      module: call.module,
      export: call.export,
      input: call.input,
    })
  )});\n`,
});

/**
 * What a run of a module answered (`answer`, what the runner sent), read
 * within `maxBytes` and a value's depth: its value, or `failed` (it threw,
 * answered no JSON, or its answer isn't one), or `workflow.call_invalid`
 * (an answer past its bounds).
 */
export const readAnswer = (
  answer: unknown,
  maxBytes: number,
  failed: () => Error
): unknown => {
  const read = answerSchema.safeParse(answer);
  if (!read.success || !read.data.ok) {
    throw failed();
  }
  const { output } = read.data;
  // Its length first: no text longer than the bound in UTF-16 code units
  // is within it in bytes.
  if (
    output.length > maxBytes ||
    new TextEncoder().encode(output).byteLength > maxBytes
  ) {
    throw workflowResourceErrors.create("workflow.call_invalid");
  }
  // Deeper than a value may nest, it is refused before anything walks it.
  if (jsonTextDepth(output) > valueDepth) {
    throw workflowResourceErrors.create("workflow.call_invalid");
  }
  // Module code may have changed what wrote it: text that isn't JSON is
  // the module's failure.
  try {
    return JSON.parse(output);
  } catch {
    throw failed();
  }
};

/** A calculation's failure, as a run fails with it. */
const computeFailed = (): Error =>
  workflowResourceErrors.create("workflow.compute_failed");

/**
 * Runs one calculation (`call`) in the sandbox: its answer, as JSON, once
 * its text is within `maxBytes`, or `workflow.compute_failed` (it threw,
 * answered a promise or no JSON, or the sandbox stopped it) or
 * `workflow.call_invalid` (an answer past its bound). The caller checks
 * the input before and the output after, against the sealed contract.
 * `SandboxUnavailableError` when the sandbox didn't answer at all.
 */
export const runCompute = async (
  env: SandboxedEnv,
  call: ComputeCall,
  maxBytes: number
): Promise<unknown> => {
  let answer: unknown;
  try {
    answer = await callSandboxed(
      env,
      {
        mainModule: computeMain,
        modules: {
          ...call.modules,
          ...call.sdk,
          ...requestModule(call),
          [computeMain]: runMain(call.paths),
        },
      },
      "Compute",
      "run"
    );
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      throw error;
    }
    throw computeFailed();
  }
  return readAnswer(answer, maxBytes, computeFailed);
};

/**
 * An action's main module: the runner first, as at inspection; then the
 * request and the modules. Its one method takes the host's capability.
 */
export const actionMain = (paths: readonly string[]): string => {
  const { imports, object } = namespacesCode(paths);
  return `import { WorkerEntrypoint } from "cloudflare:workers";
import { runAction } from ${JSON.stringify(runnerModule)};
import request from "grasp-compute-request.js";
${imports}

export class Action extends WorkerEntrypoint {
  async run(host) {
    return await runAction(${object}, request, host);
  }
}
`;
};

/** The module an action's isolate starts from (`actionMain`). */
export const actionMainModule = computeMain;
