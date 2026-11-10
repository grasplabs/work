import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalText } from "@grasp-os/shared/json";

import type { AppManifest, FunctionManifest } from "./app-types.ts";
import type {
  BoundWorkflow,
  BoundWorkflowDecision,
  BoundWorkflowEvent,
} from "./bound-workflows.ts";

/** The release a reference belongs to. */
export interface ReleaseIdentity {
  readonly resourceId: string;
  readonly resourceVersion: number;
}

/** Where each generated module is, among the App's files. */
export const generatedPaths = {
  api: "server/_generated/api.ts",
  internal: "server/_generated/internal.ts",
  server: "server/_generated/server.ts",
  dataModel: "server/_generated/dataModel.ts",
  contracts: ".grasp/contracts.json",
} as const;

/**
 * The format of `contracts.json`: 4 since its manifest carries no pages
 * or surfaces, which are the App's file routes'. A release whose
 * contracts are of another format doesn't load: a new version replaces
 * it.
 */
export const contractsFormatVersion = 4;

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
 * The fingerprint of a decision's exact contract: the SHA-256, in hex, of
 * its value and context descriptors, canonically.
 */
export const decisionFingerprint = async (
  decision: BoundWorkflowDecision
): Promise<string> =>
  await sha256Hex(
    canonicalText({ value: decision.value, context: decision.context })
  );
/**
 * The fingerprint of an event's exact contract: the SHA-256, in hex, of
 * its type and data descriptor, canonically.
 */
export const eventFingerprint = async (
  event: BoundWorkflowEvent
): Promise<string> =>
  await sha256Hex(canonicalText({ type: event.type, data: event.data }));
/**
 * The fingerprint of a bound workflow's contract: the SHA-256, in hex, of
 * its args and returns descriptors, canonically. What a run pins and the
 * host checks at start and watch; its events carry their own fingerprints,
 * and the release's contracts cover all of it.
 */
export const workflowFingerprint = async (
  workflow: Pick<BoundWorkflow, "args" | "returns">
): Promise<string> =>
  await sha256Hex(
    canonicalText({ args: workflow.args, returns: workflow.returns })
  );
