import type { AppRole } from "@grasp-os/shared/apps";
import type { AuditDetailValue } from "@grasp-os/shared/audit";
import type { Permission } from "@grasp-os/shared/permissions";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { connectionGrants } from "./agent-connections.ts";
import { chatAuthority, chatContext, connectionReadOf } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { appFor } from "./apps.ts";
import { memberOf } from "./auth/identity.ts";
import { connectionOwnersOf } from "./connections.ts";
import { inList } from "./db/d1.ts";
import { collections } from "./db/knowledge/schema.ts";
import { collectionsAllowed } from "./knowledge/access.ts";
import { appsCollectionId } from "./knowledge/app-entries.ts";
import { grantedPermissions } from "./permissions.ts";

// What a chat's earlier code results may still send to the model (GRA-690).
// A result rests on what its run read, each recorded with the run:
// collections and each connection call, with the action and resource its
// grant allowed (`recordSources`), and an App's answer, exports or files
// and the Knowledge catalog's collections (`recordRunReads`). Before every
// model request the chat asks which of those its agent may still read for
// its person, as a read made now would be decided, and withholds the
// results of every run that read one it may not (`withholdRuns` in
// agent.ts): a person who left a team or an App, an agent whose grant was
// revoked (the one a connection call was made under, whatever other grant
// on that connection stays), a collection or App deleted.

/** How a run read an App, each checked as a read made now would be. */
const appReads = {
  /**
   * One of its queries answered: the agent's `read` grant on it, the
   * person's role, as the call needed.
   */
  query: "app-query",
  /** A mutation or action answered: the agent's `write` grant, the person's role. */
  write: "app-write",
  /** Its exports: the Apps collection granted, the person's role. */
  exports: "app-exports",
  /** Its files or versions: the Apps collection granted, the person builds it. */
  build: "app-build",
} as const;

type AppRead = keyof typeof appReads;

/** The source a run read of App `appId` is recorded as. */
export const appRead = (read: AppRead, appId: string): string =>
  `${appReads[read]}:${appId}`;

const appReadOf = (
  source: string
): { read: AppRead; appId: string } | undefined => {
  for (const read of ["query", "write", "exports", "build"] as const) {
    const prefix = `${appReads[read]}:`;
    if (source.startsWith(prefix)) {
      return { read, appId: source.slice(prefix.length) };
    }
  }
  return undefined;
};

/** What each App read needs of the agent's grants, and of the person's role. */
const appReadNeeds = (
  read: AppRead,
  appId: string,
  permissions: readonly Permission[]
): { granted: boolean; role: AppRole } => {
  if (read === "query" || read === "write") {
    // The action the call itself needed (`actionFor` in agent-apps.ts).
    const action = read === "query" ? "read" : "write";
    return {
      granted: permissions.some(
        ({ object, actions }) =>
          object.type === "app" &&
          object.appId === appId &&
          actions.includes(action)
      ),
      role: "user",
    };
  }
  return {
    granted: permissions.some(
      ({ object, actions }) =>
        object.type === "collection" &&
        object.collectionId === appsCollectionId &&
        actions.includes("read")
    ),
    role: read === "build" ? "builder" : "user",
  };
};

/**
 * What the audit names of a withheld source: a connection call's
 * connection, action and resource, each an identifier; any other source
 * by its ID.
 */
export const withheldSourceDetail = (
  source: string
): Record<string, AuditDetailValue> => {
  const read = connectionReadOf(source);
  return read === undefined
    ? { source }
    : {
        connection: read.connectionId,
        action: read.action,
        resource: read.resource,
      };
};

/**
 * Whether `grant` allows `read` now: the same connection and action, for
 * the same resource or the whole connection. A grant for one resource
 * never covers a read made under one for the whole connection.
 */
const covers = (
  grant: Awaited<ReturnType<typeof connectionGrants>>[number],
  read: { connectionId: string; action: string; resource: string | null }
): boolean => {
  const resource = grant.connection.resource ?? null;
  return (
    grant.connection.connectionId === read.connectionId &&
    grant.actions.includes(read.action) &&
    (resource === null || resource === read.resource)
  );
};

/**
 * Of the connection reads in `sources`, those the agent may make for its
 * person now: a grant it holds in this chat now covers the read
 * (`covers`), and the connection is not disconnected and is one the
 * person may use themselves.
 */
const readableConnections = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  sources: readonly string[]
): Promise<string[]> => {
  const reads = sources.flatMap((source) => {
    const read = connectionReadOf(source);
    return read === undefined ? [] : [{ source, ...read }];
  });
  if (reads.length === 0) {
    return [];
  }
  const granted = await connectionGrants(env, scope);
  const covered = reads.filter((read) =>
    granted.some((grant) => covers(grant, read))
  );
  if (covered.length === 0) {
    return [];
  }
  // One the person may use themselves: shared, or their own personal one
  // (as `ConnectionsApi.list` decides it).
  const owners = await connectionOwnersOf(env, [
    ...new Set(covered.map(({ connectionId }) => connectionId)),
  ]);
  const usable = new Set(
    owners.flatMap(({ id, ownerUserId, status }) =>
      // A disconnected one is gone, whoever owned it; one waiting to be
      // signed in again changes nobody's access.
      status !== "disconnected" &&
      (ownerUserId === null || ownerUserId === scope.personId)
        ? [id]
        : []
    )
  );
  return covered.flatMap(({ source, connectionId }) =>
    usable.has(connectionId) ? [source] : []
  );
};

/** Of the App reads in `sources`, those the agent may make for its person now. */
const readableApps = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  sources: readonly string[]
): Promise<string[]> => {
  const reads = sources.flatMap((source) => {
    const read = appReadOf(source);
    return read === undefined ? [] : [{ source, ...read }];
  });
  if (reads.length === 0) {
    return [];
  }
  const [permissions, person] = await Promise.all([
    grantedPermissions(env, chatAuthority(scope)),
    memberOf(env.DB, scope.personId),
  ]);
  if (person === undefined) {
    return [];
  }
  const readable = await Promise.all(
    reads.map(async ({ source, read, appId }) => {
      const { granted, role } = appReadNeeds(read, appId, permissions);
      if (!granted) {
        return [];
      }
      try {
        // Refused as a read would be: no such App, no role, or a shared
        // App whose sources the person can't read.
        await appFor(env, person, appId, role);
        return [source];
      } catch {
        return [];
      }
    })
  );
  return readable.flat();
};

/**
 * Of `sourceIds`, those the chat's agent may read for its person now: a
 * collection a Knowledge read would allow now (granted to the agent, and
 * readable by the person: `collectionsAllowed`); a connection call a
 * grant the agent holds in this chat now covers, on a connection not
 * disconnected that the person may use themselves; an App read the
 * agent's grants and the person's role in the App allow now. Anything
 * else, an unknown source or a bare connection included, is not. Throws
 * what the reads throw (a person who left, a database away): the caller
 * withholds everything then.
 */
export const readableSources = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  sourceIds: readonly string[]
): Promise<Set<string>> => {
  if (sourceIds.length === 0) {
    return new Set();
  }
  const db = drizzle(env.KNOWLEDGE);
  const { condition } = await collectionsAllowed(env, db, {
    type: "delegate",
    authority: chatAuthority(scope),
    context: chatContext(scope),
  });
  const known = await db
    .select({
      id: collections.id,
      readable: sql<number>`CASE WHEN ${condition} THEN 1 ELSE 0 END`,
    })
    .from(collections)
    .where(inList(collections.id, sourceIds));
  const [apps, connections] = await Promise.all([
    readableApps(env, scope, sourceIds),
    readableConnections(env, scope, sourceIds),
  ]);
  return new Set([
    ...known.flatMap(({ id, readable }) => (readable === 1 ? [id] : [])),
    ...apps,
    ...connections,
  ]);
};
