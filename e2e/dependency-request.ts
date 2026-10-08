/**
 * A request for an App's npm packages, as core's resolver leaves one, for
 * the e2e stack. Resolving reaches the npm registry through connect, which
 * a local stack can't point at a fake (package-artifact.ts says the same),
 * and nothing else may hand core a graph: so the request is written to
 * core's database as the resolver would have proposed it, waiting, or
 * approved as a person's decision leaves it.
 */
import {
  canonicalGraph,
  dependencyGraphHash,
  dependencySummaryDirect,
  packageKey,
} from "@grasp-os/shared/dependencies";
import type {
  DependencyGraph,
  DependencyTarget,
} from "@grasp-os/shared/dependencies";
import { canonicalJson } from "@grasp-os/shared/json";

import { execute, quoted } from "./connections-seed.ts";

/** The policy generation now, as core reads it: none yet is 0. */
const generationNow =
  "(SELECT COALESCE(MAX(generation), 0) FROM dependency_policy)";

/** Writes the request; returns its ID and its graph's hash. */
export const seedDependencyRequest = async ({
  app,
  requestedBy,
  purpose,
  targets,
  graph,
  approved,
}: {
  app: string;
  requestedBy: string;
  purpose: string;
  targets: DependencyTarget[];
  graph: DependencyGraph;
  approved: boolean;
}): Promise<{ id: string; graphHash: string }> => {
  const canonical = canonicalGraph(graph);
  const graphHash = await dependencyGraphHash(canonical);
  const id = crypto.randomUUID();
  const now = Date.now();
  const snapshot = canonicalJson({
    graph: canonical,
    findings: [],
    refused: [],
  });
  const summary = JSON.stringify({
    direct: canonical.direct.slice(0, dependencySummaryDirect).map(packageKey),
    findings: [],
  });
  const decided = approved
    ? `${quoted(requestedBy)}, ${now}, ${generationNow}`
    : "NULL, NULL, NULL";
  await execute(
    `INSERT INTO dependency_requests (id, app_id, source_revision, graph_hash, targets, purpose, snapshot, summary, direct, packages, findings, refused, previous, status, requested_by, requested_via, requested_at, policy_generation, decided_by, decided_at, decided_generation, reason) VALUES (${quoted(id)}, ${quoted(app)}, 'rev-1', ${quoted(graphHash)}, ${quoted(JSON.stringify(targets.toSorted()))}, ${quoted(purpose)}, ${quoted(snapshot)}, ${quoted(summary)}, ${canonical.direct.length}, ${canonical.packages.length}, 0, 0, NULL, ${quoted(approved ? "approved" : "pending")}, ${quoted(requestedBy)}, NULL, ${now}, ${generationNow}, ${decided}, NULL)`,
    "core"
  );
  return { id, graphHash };
};
