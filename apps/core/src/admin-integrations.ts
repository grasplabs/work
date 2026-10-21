import type {
  AdminConnection,
  AdminIntegrations,
  AdminNeeded,
} from "@grasp-os/shared/admin-snapshot";
import type {
  CatalogSource,
  OrganizationConnection,
} from "@grasp-os/shared/connect";
import { workflowBindingTargetSchema } from "@grasp-os/shared/workflow-resources";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { connectionOwnersOf, entryKey, hiddenEntries } from "./connections.ts";
import {
  permissions,
  sdkResourceBindings,
  users,
  workflowBindingApprovals,
  workflowResources,
} from "./db/core/schema.ts";
import { inList } from "./db/d1.ts";

// What the company connected, and what its workflows and chats still need,
// for Grasp's admin (admin-snapshot.ts): staff read it to know whom to
// reach out to, about which app. Connect says what is connected and
// whether it works (`organizationConnections`), never with a token, a
// server's URL or anything Composio knows an account by; core adds what
// its workflows bind and its chats asked for. What it must not let out,
// besides what connect keeps back: whose a personal connection is (they
// are counted by app), and anything a chat's agent said or whose chat it
// was (requests are counted by app too).

/** An app, as a connection names it. */
interface App {
  source: CatalogSource;
  provider: string;
}

/** How a listed connection stands, as Grasp's admin says it. */
const stateOf = ({
  status,
  composio,
}: OrganizationConnection): AdminConnection["state"] => {
  if (status === "needs_reauth") {
    return "again";
  }
  if (composio === "stopped" || composio === "unread") {
    return composio;
  }
  return "works";
};

/** The names of the members `ids` names, while they are members. */
const namesOf = async (
  env: Env,
  ids: readonly string[]
): Promise<Map<string, string>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inList(users.id, ids));
  return new Map(rows.map(({ id, name }) => [id, name]));
};

/** People's own connections, counted by app. */
const personalOf = (
  listed: readonly OrganizationConnection[]
): AdminIntegrations["personal"] => {
  const byApp = new Map<string, AdminIntegrations["personal"][number]>();
  for (const connection of listed) {
    if (connection.scope !== "personal") {
      continue;
    }
    const key = entryKey(connection.source, connection.provider);
    const app = byApp.get(key) ?? {
      source: connection.source,
      provider: connection.provider,
      people: 0,
      again: 0,
    };
    app.people += 1;
    if (connection.status === "needs_reauth") {
      app.again += 1;
    }
    byApp.set(key, app);
  }
  return [...byApp.values()];
};

/** A binding the current version of a live workflow declares, with its approval's target, if any. */
interface DeclaredBinding {
  workflowId: string;
  workflowName: string;
  alias: string;
  /** The approved target's permission; null while no approval serves it. */
  permissionId: string | null;
}

/**
 * Every connector binding the current version of each live workflow
 * declares, with the permission its active approval names, where an
 * admin approved one for that very declaration (`approvalServing`).
 */
const connectorBindingsOf = async (env: Env): Promise<DeclaredBinding[]> => {
  const db = drizzle(env.DB);
  const [declared, approvals] = await Promise.all([
    db
      .select({
        workflowId: workflowResources.id,
        workflowName: workflowResources.name,
        alias: sdkResourceBindings.alias,
        contractId: sdkResourceBindings.targetId,
        fingerprint: sdkResourceBindings.schemaHash,
      })
      .from(sdkResourceBindings)
      .innerJoin(
        workflowResources,
        and(
          eq(sdkResourceBindings.resourceId, workflowResources.id),
          eq(
            sdkResourceBindings.resourceVersion,
            workflowResources.currentVersion
          )
        )
      )
      .where(
        and(
          eq(sdkResourceBindings.kind, "connector"),
          isNull(workflowResources.deletedAt)
        )
      ),
    db
      .select({
        workflowId: workflowBindingApprovals.workflowResourceId,
        alias: workflowBindingApprovals.alias,
        contractId: workflowBindingApprovals.contractId,
        fingerprint: workflowBindingApprovals.fingerprint,
        target: workflowBindingApprovals.target,
      })
      .from(workflowBindingApprovals)
      .innerJoin(
        workflowResources,
        and(
          eq(workflowBindingApprovals.workflowResourceId, workflowResources.id),
          eq(
            workflowBindingApprovals.reviewedVersion,
            workflowResources.currentVersion
          )
        )
      )
      .where(
        and(
          eq(workflowBindingApprovals.kind, "connector"),
          eq(workflowBindingApprovals.status, "active")
        )
      ),
  ]);
  const served = new Map<string, string>();
  for (const approval of approvals) {
    const target = workflowBindingTargetSchema.safeParse(
      JSON.parse(approval.target)
    );
    if (target.data?.kind !== "connector") {
      continue;
    }
    served.set(
      JSON.stringify([
        approval.workflowId,
        approval.alias,
        approval.contractId,
        approval.fingerprint,
      ]),
      target.data.permissionId
    );
  }
  return declared.map((binding) => ({
    workflowId: binding.workflowId,
    workflowName: binding.workflowName,
    alias: binding.alias,
    permissionId:
      served.get(
        JSON.stringify([
          binding.workflowId,
          binding.alias,
          binding.contractId,
          binding.fingerprint,
        ])
      ) ?? null,
  }));
};

/**
 * The connection each of the workflows' own active connection
 * permissions `ids` is on: a revoked one serves no start, so it serves
 * nothing here either.
 */
const connectionsOfPermissions = async (
  env: Env,
  ids: readonly string[]
): Promise<Map<string, string>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await drizzle(env.DB)
    .select({ id: permissions.id, connectionId: permissions.objectId })
    .from(permissions)
    .where(
      and(
        inList(permissions.id, ids),
        eq(permissions.subjectType, "workflow"),
        eq(permissions.objectType, "connection"),
        eq(permissions.status, "active")
      )
    );
  return new Map(rows.map(({ id, connectionId }) => [id, connectionId]));
};

/** Requests chats' agents made for connections, still waiting on a decision. */
const waitingRequests = async (env: Env) =>
  await drizzle(env.DB)
    .select({
      connectionId: permissions.objectId,
      personal: permissions.personal,
      requestedAt: permissions.requestedAt,
    })
    .from(permissions)
    .where(
      and(
        isNotNull(permissions.chatId),
        eq(permissions.objectType, "connection"),
        eq(permissions.status, "requested")
      )
    );

/** The requests, counted by app and by who decides them, the oldest's time with each. */
const requestsOf = (
  waiting: Awaited<ReturnType<typeof waitingRequests>>,
  apps: ReadonlyMap<string, App>
): AdminIntegrations["requests"] => {
  const byApp = new Map<string, AdminIntegrations["requests"][number]>();
  for (const request of waiting) {
    const app = apps.get(request.connectionId);
    if (app === undefined) {
      continue;
    }
    const decidedBy = request.personal ? "person" : "admin";
    const key = JSON.stringify([app.source, app.provider, decidedBy]);
    const since = request.requestedAt.toISOString();
    const counted = byApp.get(key);
    byApp.set(key, {
      ...app,
      decidedBy,
      waiting: (counted?.waiting ?? 0) + 1,
      since:
        counted === undefined || since < counted.since ? since : counted.since,
    });
  }
  return [...byApp.values()];
};

/** Why `connection`, approved for a binding, doesn't serve it now; undefined while it does. */
const needOf = (
  connection: OrganizationConnection | undefined,
  hidden: ReadonlySet<string>
): AdminNeeded["state"] | undefined => {
  if (connection === undefined) {
    return "missing";
  }
  if (hidden.has(entryKey(connection.source, connection.provider))) {
    return "hidden";
  }
  return connection.status === "needs_reauth" ||
    connection.composio === "stopped"
    ? "stopped"
    : undefined;
};

/**
 * What the company connected, and what its workflows and chats still
 * need, as Grasp's admin reads it.
 */
export const adminIntegrationsOf = async (
  env: Env
): Promise<AdminIntegrations> => {
  const [listed, hidden, bindings, waiting] = await Promise.all([
    env.CONNECT.organizationConnections(),
    hiddenEntries(env),
    connectorBindingsOf(env),
    waitingRequests(env),
  ]);
  const byId = new Map(listed.map((connection) => [connection.id, connection]));
  const shared = listed.filter(({ scope }) => scope === "shared");
  const [names, approved] = await Promise.all([
    namesOf(env, [
      ...new Set(shared.flatMap(({ connectedBy }) => connectedBy ?? [])),
    ]),
    connectionsOfPermissions(env, [
      ...new Set(bindings.flatMap(({ permissionId }) => permissionId ?? [])),
    ]),
  ]);
  // What app a connection connect no longer lists was: one that was
  // disconnected, as connect still knows it.
  const gone = [
    ...new Set([
      ...approved.values(),
      ...waiting.map(({ connectionId }) => connectionId),
    ]),
  ].filter((id) => !byId.has(id));
  const apps = new Map<string, App>(
    [...listed, ...(await connectionOwnersOf(env, gone))].map(
      ({ id, source, provider }) => [id, { source, provider }]
    )
  );
  const needed = bindings.flatMap((binding): AdminNeeded[] => {
    const workflow = { id: binding.workflowId, name: binding.workflowName };
    const connectionId =
      binding.permissionId === null
        ? undefined
        : approved.get(binding.permissionId);
    if (connectionId === undefined) {
      return [{ workflow, alias: binding.alias, app: null, state: "unbound" }];
    }
    const state = needOf(byId.get(connectionId), hidden);
    return state === undefined
      ? []
      : [
          {
            workflow,
            alias: binding.alias,
            app: apps.get(connectionId) ?? null,
            state,
          },
        ];
  });
  return {
    connected: shared.map((connection) => ({
      source: connection.source,
      provider: connection.provider,
      state: stateOf(connection),
      hidden: hidden.has(entryKey(connection.source, connection.provider)),
      connectedBy:
        connection.connectedBy === null
          ? null
          : (names.get(connection.connectedBy) ?? null),
      connectedAt: connection.createdAt,
      account: connection.accountName,
      tools: connection.tools,
    })),
    personal: personalOf(listed),
    needed,
    requests: requestsOf(waiting, apps),
  };
};
