/**
 * A request for an App's npm packages, as the chat's agent leaves one, for
 * the e2e stack. Resolving reaches the npm registry through connect, which
 * a local stack can't point at a fake, and nothing else may hand core a
 * lock: so the request is written to core's database as the agent's
 * resolve would have proposed it, waiting in `chat`.
 */
import { npmRegistryOrigin } from "@grasp-os/shared/dependencies";
import { graspLockHash } from "@grasp-os/shared/packages";
import type { GraspLock } from "@grasp-os/shared/packages";

import { execute, quoted } from "./connections-seed.ts";

/** Writes the request; returns its ID and its graph's hash. */
export const seedDependencyRequest = async ({
  app,
  requestedBy,
  chat,
  purpose,
  packages,
}: {
  app: string;
  requestedBy: string;
  chat: string;
  purpose: string;
  /** Each package, by name: its exact version, with no dependencies of its own. */
  packages: Record<string, string>;
}): Promise<{ id: string; graphHash: string }> => {
  const lock: GraspLock = {
    lockfileVersion: 2,
    registry: npmRegistryOrigin,
    requested: packages,
    direct: packages,
    entries: Object.keys(packages),
    packages: Object.fromEntries(
      Object.entries(packages).map(([name, version]) => [
        `${name}@${version}`,
        {
          name,
          version,
          integrity: `sha512-${"A".repeat(86)}==`,
          license: "MIT",
          publishedAt: "2026-01-01T00:00:00.000Z",
          dependencies: {},
        },
      ])
    ),
  };
  const graphHash = await graspLockHash(lock);
  const id = crypto.randomUUID();
  const via = JSON.stringify({
    type: "agent",
    agentId: "chat-agent",
    onBehalfOf: requestedBy,
    workspaceId: `person:${requestedBy}`,
    chatId: chat,
  });
  const count = Object.keys(packages).length;
  await execute(
    `INSERT INTO dependency_requests (id, subject_type, subject_id, source_revision, graph_hash, targets, purpose, snapshot, summary, direct, packages, findings, refused, previous, status, requested_by, requested_via, requested_at, policy_generation) VALUES (${quoted(id)}, 'app', ${quoted(app)}, '', ${quoted(graphHash)}, '[]', ${quoted(purpose)}, ${quoted(JSON.stringify({ lock, findings: [], removed: [] }))}, ${quoted(JSON.stringify({ direct: [], findings: [] }))}, ${count}, ${count}, 0, 0, NULL, 'pending', ${quoted(requestedBy)}, ${quoted(via)}, ${Date.now()}, 0)`,
    "core"
  );
  return { id, graphHash };
};
