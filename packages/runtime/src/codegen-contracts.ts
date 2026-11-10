import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalText } from "@grasp-os/shared/json";

import type { AppManifest, FunctionManifest } from "./app-types.ts";
import type { BoundWorkflow } from "./bound-workflows.ts";

/** Where each generated module is, among the App's files. */
export const generatedPaths = {
  api: "server/_generated/api.ts",
  internal: "server/_generated/internal.ts",
  server: "server/_generated/server.ts",
  dataModel: "server/_generated/dataModel.ts",
  contracts: ".grasp/contracts.json",
  functions: ".grasp/functions.ts",
} as const;

/**
 * The format of `contracts.json`: 5 since it names no release and seals
 * only the version each workflow binding pinned, the App's declaration
 * being the workflow's contract. A release whose contracts are of
 * another format doesn't load: a new version replaces it.
 */
export const contractsFormatVersion = 5;

/**
 * The fingerprint of `operation`'s exact contract: the SHA-256, in hex, of
 * its kind, visibility, arguments, return and progress, canonically. Any
 * change to any of them changes it.
 */
export const contractFingerprint = async (
  operation: FunctionManifest
): Promise<string> =>
  await sha256Hex(
    canonicalText({
      kind: operation.kind,
      visibility: operation.visibility,
      args: operation.args,
      returns: operation.returns,
      stream: operation.stream,
    })
  );

/** Each function's fingerprint, by path. */
export const contractFingerprints = async (
  manifest: AppManifest
): Promise<Record<string, string>> => {
  const fingerprints: Record<string, string> = {};
  for (const [path, operation] of Object.entries(manifest.operations)) {
    // One after the other: a digest is quick, and the order is the map's.
    // oxlint-disable-next-line no-await-in-loop -- see above
    fingerprints[path] = await contractFingerprint(operation);
  }
  return fingerprints;
};
/**
 * The fingerprint of a workflow's contract as the App declares it: the
 * SHA-256, in hex, of its args, returns, events, listen tasks and
 * decisions, canonically. What the host compares across an App's
 * releases before a page follows a run another release started, so a
 * page never reads a run's result, waits or events by a contract it
 * wasn't started under.
 */
export const workflowFingerprint = async (
  workflow: Pick<
    BoundWorkflow,
    "args" | "returns" | "events" | "listens" | "decisions"
  >
): Promise<string> =>
  await sha256Hex(
    canonicalText({
      args: workflow.args,
      returns: workflow.returns,
      events: workflow.events,
      listens: workflow.listens,
      decisions: workflow.decisions,
    })
  );
