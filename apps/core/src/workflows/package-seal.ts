import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import type { Acting } from "../auth/identity.ts";

// What a version of an independent workflow seals of the approved npm
// packages its compute modules import: its manifest's record, and how a
// publication has them sealed (workflows/sealed-packages.ts). Apart from
// the sealing itself, so the workflow registry names it without importing
// the package machinery, which reads the registry's roles.

/** What a version seals of its approved packages, as its manifest holds it. */
export const sealedPackagesSchema = z.strictObject({
  graphHash: z.string().regex(/^[0-9a-f]{64}$/u),
  /** The approval admitted at publication. */
  approval: z.string(),
  /** Each importable entry, by name, and the module it loads as. */
  entries: z.record(z.string(), z.string()),
});
export type SealedPackageManifest = z.infer<typeof sealedPackagesSchema>;

/** Where a version's manifest seals the approved packages its modules import. */
export const manifestPackagesSchema = z.object({
  packages: sealedPackagesSchema.optional(),
});

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
 * That workflow `workflow`'s graph `graphHash` is approved as the
 * statement runs, as SQL: what a publication, a start and every call of a
 * version that seals it require. A graph revoked as malware holds nothing.
 */
export const packagesHoldSql = (workflow: string, graphHash: string): SQL =>
  sql`EXISTS (SELECT 1 FROM dependency_requests
    WHERE subject_type = 'workflow' AND subject_id = ${workflow}
      AND graph_hash = ${graphHash} AND status = 'approved')`;

/** Whether workflow `workflow`'s graph `graphHash` is approved now. */
export const packagesHold = async (
  db: DrizzleD1Database,
  workflow: string,
  graphHash: string
): Promise<boolean> => {
  const read = await db.get<{ holds: number }>(
    sql`SELECT ${packagesHoldSql(workflow, graphHash)} AS holds`
  );
  return read.holds !== 0;
};
