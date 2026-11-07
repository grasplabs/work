import { packageModuleName } from "@grasp-os/compiler";
import { packageLimits } from "@grasp-os/shared/packages";
import { roleErrors } from "@grasp-os/shared/roles";
import { workflowModuleLimits } from "@grasp-os/shared/workflow-modules";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { drizzle } from "drizzle-orm/d1";

import type { Acting } from "../auth/identity.ts";
import { buildPackages } from "../packages/build.ts";
import { packagesHold } from "./package-seal.ts";
import type { SealedPackages } from "./package-seal.ts";

// Approved npm packages a version of an independent workflow seals for
// its compute modules, and the check that keeps a revoked graph from
// running. What could go wrong, and what stops it:
//
// - Sealing packages nobody approved, or not for this workflow: the build
//   reads the lock from this workflow's approval alone
//   (packages/build.ts), and the version is written only while it is
//   still approved (workflow-resources.ts).
// - Bytes that change under a sealed version: each entry's module is
//   copied into the version's own build, whose artifacts are
//   content-addressed and checked on every load, so nothing built later
//   changes what runs.
// - A revoked graph running on: every start requires it approved as the
//   start lands (`packagesHoldSql`), and every compute or action call
//   checks it again (`requirePackagesAdmitted`): a run in flight fails at
//   its next call (`workflow.packages_revoked`, never retried).

const invalid = (reason: string) =>
  workflowResourceErrors.create("workflow.packages_invalid", { reason });

/**
 * The approved graph `graphHash` of workflow `workflow`, built and sealed
 * for a version `by` publishes: each entry's module under its flat name.
 */
export const sealPackages = async (
  env: Env,
  by: Acting,
  workflow: string,
  graphHash: string
): Promise<SealedPackages> => {
  // Grasp staff neither ask for nor build a workflow's packages.
  if (by.staff) {
    throw roleErrors.create("role.forbidden");
  }
  const { approval, modules: built } = await buildPackages(
    env,
    by,
    { type: "workflow", id: workflow },
    graphHash
  );
  const entries = Object.entries(built);
  if (entries.length > workflowModuleLimits.files) {
    throw invalid(
      `They have ${entries.length} entries; a version holds at most ${workflowModuleLimits.files}.`
    );
  }
  const chars = entries.reduce((total, [, text]) => total + text.length, 0);
  if (chars > packageLimits.workflowPackageChars) {
    throw invalid(
      `Their modules are larger than a version holds: at most ${packageLimits.workflowPackageChars} characters together.`
    );
  }
  const modules: Record<string, string> = {};
  const named: Record<string, string> = {};
  for (const [entry, text] of entries) {
    const name = packageModuleName(entry);
    modules[name] = text;
    named[entry] = name;
  }
  return {
    manifest: { graphHash, approval, entries: named },
    modules: Object.freeze(modules),
  };
};

/**
 * Requires workflow `workflow`'s sealed graph `graphHash` to be approved
 * for a call of its run: anything else is `workflow.packages_revoked`,
 * which fails the run (never retried).
 */
export const requirePackagesAdmitted = async (
  env: Env,
  workflow: string,
  graphHash: string
): Promise<void> => {
  if (!(await packagesHold(drizzle(env.DB), workflow, graphHash))) {
    throw workflowResourceErrors.create("workflow.packages_revoked");
  }
};
