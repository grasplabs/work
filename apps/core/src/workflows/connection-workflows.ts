import { connectionIdSchema } from "@grasp-os/shared/ids";
import { workflowErrors } from "@grasp-os/shared/workflows";
import type { WorkflowSummary } from "@grasp-os/shared/workflows";
import { and, eq, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { Member } from "../auth/identity.ts";
import { apps, appVersions, permissions } from "../db/core/schema.ts";
import { workflowOverview } from "./overview.ts";

// Which workflows use a connection, for its integration's page: those of
// the current version of an App that holds an active permission on it,
// whose code calls the permission's binding, as the version's review read
// it (`app_versions.workflow_calls`, what a run's calls are held to). The
// permission is the App's, and only a workflow that calls its binding can
// reach the connection through it. Only workflows of Apps `by` can open,
// as the Workflows page lists them (`workflowOverview`).

/** A workflow, as one key: its App and its ID. */
const keyOf = (app: string, workflow: string): string =>
  JSON.stringify([app, workflow]);

/**
 * The workflows of the Apps `by` can open that use `connection`, each as
 * the Workflows page sums it up, by App name, then workflow.
 */
export const connectionWorkflows = async (
  env: Env,
  by: Member,
  connection: unknown
): Promise<WorkflowSummary[]> => {
  const connectionId = workflowErrors.parse(
    "workflow.invalid",
    connectionIdSchema,
    connection
  );
  const rows = await drizzle(env.DB)
    .select({
      app: permissions.subjectId,
      binding: permissions.binding,
      calls: appVersions.workflowCalls,
    })
    .from(permissions)
    .innerJoin(apps, eq(apps.id, permissions.subjectId))
    .innerJoin(
      appVersions,
      and(
        eq(appVersions.appId, apps.id),
        eq(appVersions.version, apps.currentVersion)
      )
    )
    .where(
      and(
        eq(permissions.objectType, "connection"),
        eq(permissions.objectId, connectionId),
        eq(permissions.subjectType, "app"),
        eq(permissions.status, "active"),
        // A chat's request for its person's own connection is theirs alone.
        eq(permissions.personal, false),
        isNotNull(permissions.binding)
      )
    );
  const using = new Set(
    rows.flatMap(({ app, binding, calls }) =>
      Object.entries(calls)
        .filter(([, { all }]) => binding !== null && all.includes(binding))
        .map(([workflow]) => keyOf(app, workflow))
    )
  );
  return await workflowOverview(env, by, (app, workflow) =>
    using.has(keyOf(app, workflow))
  );
};
