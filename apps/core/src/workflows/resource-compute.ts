import type { Json } from "@grasp-os/shared/json";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";

import type { LoadedModules, SealedCall } from "../workflow-builds.ts";
import { runCompute } from "../workflow-modules.ts";
import { requireShape } from "./resource-calls.ts";

// A run's `grasp.compute` call (platform specification 13.6): one
// calculation of the workflow's own sealed compute modules, run in core's
// sandbox (workflow-modules.ts, whose header has the threat model). The
// contract is the sealed one, never anything the module says now: the
// arguments must be what its input takes exactly before anything runs,
// and the answer what its output takes exactly before the run sees it
// (`workflow.call_invalid` otherwise).

/** How long a calculation may run past its attempt's deadline: none. */
const deadlineError = () =>
  workflowResourceErrors.create("workflow.compute_failed");

/**
 * Makes `call`, a task's compute call, with `input` the arguments the host
 * built: its answer, checked against the sealed contract. Given up at
 * `deadline` (the attempt's), whatever the sandbox is still doing.
 */
export const callCompute = async (
  env: Env,
  compute: LoadedModules,
  sdk: Readonly<Record<string, string>>,
  call: Extract<SealedCall, { name: "grasp.compute" }>,
  input: Json,
  deadline: number
): Promise<Json> => {
  const contract = compute.contracts.get(`${call.module}#${call.export}`);
  // The build's load checked every compute task names a sealed contract.
  if (contract === undefined) {
    throw workflowResourceErrors.create("workflow.call_invalid");
  }
  // Within what a step records, as every call's arguments, and exactly
  // what the contract takes: refused before anything is sent.
  const checked = requireShape(contract.input, input, "arguments");
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw deadlineError();
  }
  const timer = Promise.withResolvers<never>();
  const timeout = setTimeout(() => {
    timer.reject(deadlineError());
  }, remaining);
  const running = runCompute(
    env,
    {
      modules: compute.modules,
      sdk,
      paths: compute.paths,
      module: call.module,
      export: call.export,
      input: checked,
    },
    // What one step's result may take, as every task's answer.
    platformLimits.stepPayloadBytes
  );
  // Settled either way, so once the deadline won, what the sandbox still
  // answers goes nowhere, and no rejection is left unhandled.
  const outcome = (async () => {
    try {
      return { ok: true as const, value: await running };
    } catch (error) {
      return { ok: false as const, error };
    }
  })();
  let settled: Awaited<typeof outcome>;
  try {
    settled = await Promise.race([outcome, timer.promise]);
  } finally {
    clearTimeout(timeout);
  }
  if (!settled.ok) {
    throw settled.error;
  }
  return requireShape(contract.output, settled.value, "output");
};
