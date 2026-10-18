import { packageModuleName } from "@grasp-os/compiler";
import { actorOf } from "@grasp-os/shared/audit";
import type { AuditActor } from "@grasp-os/shared/audit";
import type { DependencyTarget } from "@grasp-os/shared/dependencies";
import {
  dependencyErrors,
  workflowDependencyTarget,
} from "@grasp-os/shared/dependencies";
import { roleErrors } from "@grasp-os/shared/roles";
import { workflowModuleLimits } from "@grasp-os/shared/workflow-modules";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { drizzle } from "drizzle-orm/d1";

import type { Acting } from "../auth/identity.ts";
import { policyGeneration } from "../dependencies/policy.ts";
import { admitDependencies } from "../dependencies/requests.ts";
import { buildDependencies, keptFile } from "../packages/build.ts";
import type { SealedPackages } from "./package-seal.ts";

// Approved npm packages a version of an independent workflow seals for
// its compute modules (GRA-665), and the checks that keep a revoked graph
// from running. What could go wrong, and what stops it:
//
// - Sealing packages nobody approved, or not for this workflow: a
//   publication admits the graph for this workflow and `computation` as a
//   new use (`admitDependencies`), so an approval in force is needed; a
//   retired graph seals nothing new, a revoked one nothing at all.
// - Bytes that change under a sealed version: each entry's module is
//   copied into the version's own build (workflow-builds.ts), where the
//   build's identity covers it and every load checks it, so a lock's
//   artifact rebuilt or dropped later changes nothing that runs.
// - A package reaching what the sandbox doesn't have: an artifact that
//   imports a platform module (React, say) is refused; the rest runs in
//   the compute sandbox, locked down before any module evaluates, and its
//   contract inspection at publication loads every module there.
// - A revoked graph running on: every start requires the sealed graph to
//   be approved or retired as its admission lands (`packagesHoldSql`), and
//   every compute or action call admits it again under the policy
//   generation now (`requirePackagesAdmitted`), which a revocation moves
//   on: a run in flight fails at its next call (`workflow.packages_revoked`,
//   never retried), the refusal audited once per graph and generation.

/** What a workflow's packages are admitted for: its calculations. */
const computationOnly: DependencyTarget[] = [workflowDependencyTarget];

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const invalid = (reason: string) =>
  workflowResourceErrors.create("workflow.packages_invalid", { reason });

/**
 * The approved graph `graphHash` of workflow `workflow`, sealed for a
 * version `by` publishes: admitted as a new use, built for `computation`
 * (or the build pinned before), each entry's module read and checked
 * against the artifact's own hash of it.
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
  const generation = await policyGeneration(drizzle(env.DB));
  const asked = {
    workflow,
    graphHash,
    targets: computationOnly,
    policyGeneration: generation,
  };
  const admitted = await admitDependencies(
    env,
    by.actor ?? actorOf(by),
    asked,
    "new"
  );
  const built = await buildDependencies(env, by, {
    workflow,
    graphHash,
    target: workflowDependencyTarget,
    policyGeneration: generation,
  });
  const { artifact } = built;
  if (artifact.imports.length > 0) {
    throw invalid(
      `They import ${artifact.imports.join(", ")}, which a calculation's sandbox doesn't have.`
    );
  }
  const entries = Object.entries(artifact.entries).filter(
    (entry): entry is [string, (typeof entry)[1] & { module: string }] =>
      entry[1].module !== null
  );
  if (entries.length === 0) {
    throw invalid("None of them has a module to import.");
  }
  if (entries.length > workflowModuleLimits.files) {
    throw invalid(
      `They have ${entries.length} entries; a version holds at most ${workflowModuleLimits.files}.`
    );
  }
  const modules: Record<string, string> = {};
  const named: Record<string, string> = {};
  for (const [entry, { module }] of entries) {
    const file = artifact.files[module];
    const bytes =
      file === undefined
        ? undefined
        : // oxlint-disable-next-line no-await-in-loop -- a few, one at a time
          await keptFile(env, built.hash, module, file.sha256);
    if (bytes === undefined) {
      throw dependencyErrors.create("dependency.stale");
    }
    let text: string;
    try {
      text = decoder.decode(bytes);
    } catch {
      throw invalid(`The module of ${entry} isn't text.`);
    }
    const name = packageModuleName(entry);
    modules[name] = text;
    named[entry] = name;
  }
  return {
    manifest: {
      graphHash,
      artifact: built.hash,
      approval: admitted.approval,
      entries: named,
    },
    modules: Object.freeze(modules),
  };
};

/** How often a call's admission reads the policy generation again after a race. */
const generationTries = 3;

/** A run's actor in the audit log: the system, as every event of its runs names it. */
const runActor: AuditActor = { type: "system" };

/**
 * Admits workflow `workflow`'s sealed graph `graphHash` for a call of its
 * run, under the policy generation now: approved, or retired (what was
 * sealed keeps running). Anything else is `workflow.packages_revoked`,
 * which fails the run (never retried); the refusal is audited once per
 * graph, generation and reason (`admitDependencies`).
 */
export const requirePackagesAdmitted = async (
  env: Env,
  workflow: string,
  graphHash: string
): Promise<void> => {
  // Read now and admitted at once: a generation moved on in between (by
  // any change of the policy, not only this graph's) is read again,
  // never taken for a refusal.
  for (let tries = 0; ; tries += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- read again only on a race
      await admitDependencies(
        env,
        runActor,
        {
          workflow,
          graphHash,
          targets: computationOnly,
          // oxlint-disable-next-line no-await-in-loop -- as above
          policyGeneration: await policyGeneration(drizzle(env.DB)),
        },
        "retained"
      );
      return;
    } catch (error) {
      const code = dependencyErrors.codeOf(error);
      if (code === "dependency.policy_changed" && tries < generationTries) {
        continue;
      }
      if (code !== undefined) {
        throw workflowResourceErrors.create("workflow.packages_revoked");
      }
      throw error;
    }
  }
};
