import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalText } from "@grasp-os/shared/json";

import type { AppManifest, FunctionManifest } from "./app-types.ts";
import type { BoundWorkflow } from "./bound-workflows.ts";

/**
 * Where the modules App code imports as `@server/_generated/<module>` are:
 * part of the App's files, which only Grasp writes, as Convex's
 * `convex/_generated/`.
 */
export const generatedServerFolder = "server/_generated/";

/** Where each generated module is: in the App's files, or the host's own (`.grasp/`). */
export const generatedPaths = {
  api: `${generatedServerFolder}api.ts`,
  internal: `${generatedServerFolder}internal.ts`,
  server: `${generatedServerFolder}server.ts`,
  dataModel: `${generatedServerFolder}dataModel.ts`,
  contracts: ".grasp/contracts.json",
  functions: ".grasp/functions.ts",
} as const;

/** Each of `server/_generated/`'s files, as Grasp generates them among the App's. */
const generatedServerFiles: ReadonlySet<string> = new Set(
  Object.values(generatedPaths).filter((path) =>
    path.startsWith(generatedServerFolder)
  )
);

/** Whether `path` is one of the files Grasp generates in `server/_generated/`. */
export const isGeneratedServerFile = (path: string): boolean =>
  generatedServerFiles.has(path);

/**
 * Whether `path` is under `server/_generated/` in any case, or is that
 * folder's own name: never one of an App's own files.
 */
export const isUnderGeneratedServerFolder = (path: string): boolean =>
  `${path.toLowerCase()}/`.startsWith(generatedServerFolder);

/**
 * `files` as people review them: without what Grasp generates in
 * `server/_generated/`, which no one wrote and every save writes again.
 */
export const ownFiles = <Content>(
  files: Readonly<Record<string, Content>>
): Record<string, Content> =>
  Object.fromEntries(
    Object.entries(files).filter(
      ([path]) => !isUnderGeneratedServerFolder(path)
    )
  );

/**
 * The format of `contracts.json`: 6 since its manifest names the App's
 * functions `functions`, and it names no release and seals only the
 * version each workflow binding pinned, the App's declaration being the
 * workflow's contract. A release whose contracts are of another format
 * doesn't load: a new version replaces it.
 */
export const contractsFormatVersion = 6;

/**
 * The fingerprint of `fn`'s exact contract: the SHA-256, in hex, of
 * its kind, visibility, arguments, return and progress, canonically. Any
 * change to any of them changes it.
 */
export const contractFingerprint = async (
  fn: FunctionManifest
): Promise<string> =>
  await sha256Hex(
    canonicalText({
      kind: fn.kind,
      visibility: fn.visibility,
      args: fn.args,
      returns: fn.returns,
      stream: fn.stream,
    })
  );

/** Each function's fingerprint, by path. */
export const contractFingerprints = async (
  manifest: AppManifest
): Promise<Record<string, string>> => {
  const fingerprints: Record<string, string> = {};
  for (const [path, fn] of Object.entries(manifest.functions)) {
    // One after the other: a digest is quick, and the order is the map's.
    // oxlint-disable-next-line no-await-in-loop -- see above
    fingerprints[path] = await contractFingerprint(fn);
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
