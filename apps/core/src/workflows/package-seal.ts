import { workflowDependencyTarget } from "@grasp-os/shared/dependencies";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";

import type { Acting } from "../auth/identity.ts";

// What a version of an independent workflow seals of the approved npm
// packages its modules import (GRA-665): its manifest's record, and how a
// publication has them sealed (workflows/sealed-packages.ts). Apart from
// the sealing itself, so the workflow registry names it without importing
// the dependency machinery, which reads the registry's roles.

/** What a version seals of its approved packages, as its manifest holds it. */
export const sealedPackagesSchema = z.strictObject({
  graphHash: z.string().regex(/^[0-9a-f]{64}$/u),
  /** The artifact the entries were copied from, by its hash. */
  artifact: z.string().regex(/^[0-9a-f]{64}$/u),
  /** The approval admitted at publication. */
  approval: z.string(),
  /** Each importable entry, by name, and the module it loads as. */
  entries: z.record(z.string(), z.string()),
});
export type SealedPackageManifest = z.infer<typeof sealedPackagesSchema>;

/** The packages a publication seals: its manifest's record, and the modules. */
export interface SealedPackages {
  manifest: SealedPackageManifest;
  /** Each entry's module, by its flat name (`packageModuleName`). */
  modules: Readonly<Record<string, string>>;
}

/**
 * Seals the approved graph `graphHash` of workflow `workflow` for a
 * version `by` publishes (`sealPackages`).
 */
export type PackageSealer = (
  env: Env,
  by: Acting,
  workflow: string,
  graphHash: string
) => Promise<SealedPackages>;

/**
 * That workflow `workflow`'s graph `graphHash` is approved or retired for
 * `computation` as the statement runs, as SQL: what a start of a version
 * that seals it requires (workflow-starts.ts). A revoked graph, or one
 * approved for no `computation`, holds nothing.
 */
export const packagesHoldSql = (workflow: string, graphHash: string): SQL =>
  sql`EXISTS (SELECT 1 FROM dependency_requests AS approval
    WHERE approval.subject_type = 'workflow' AND approval.subject_id = ${workflow}
      AND approval.graph_hash = ${graphHash}
      AND approval.status IN ('approved', 'retired')
      AND EXISTS (SELECT 1 FROM json_each(approval.targets) WHERE value = ${workflowDependencyTarget}))`;
