import type { AppRole } from "@grasp-os/shared/apps";
import type { Permission } from "@grasp-os/shared/permissions";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { connectionGrants } from "./agent-connections.ts";
import { chatAuthority, chatContext } from "./agent-scope.ts";
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
// collections and connections (`recordSources`), and an App's answer,
// exports or files and the Knowledge catalog's collections
// (`recordRunReads`). Before every model request the chat asks which of
// those its agent may still read for its person, as a read made now would
// be decided, and withholds the results of every run that read one it may
// not (`withholdRuns` in agent.ts): a person who left a team or an App, an
// agent whose grant was revoked, a collection or App deleted.

/** How a run read an App, each checked as a read made now would be. */
const appReads = {
  /** One of its functions answered: the agent's grant on it, the person's role. */
  call: "app-call",
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
  for (const read of ["call", "exports", "build"] as const) {
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
  if (read === "call") {
    return {
      granted: permissions.some(
        ({ object, actions }) =>
          object.type === "app" &&
          object.appId === appId &&
          (actions.includes("read") || actions.includes("write"))
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
 * readable by the person: `collectionsAllowed`); a connection the agent
 * holds a grant for in this chat now that the person may use themselves;
 * an App read the agent's grants and the person's role in the App allow
 * now. Anything else, an unknown source included, is not. Throws what the
 * reads throw (a person who left, a database away): the caller withholds
 * everything then.
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
  // Each collection among them, and whether it may be read: a collection
  // never needs the connection lookup, readable or not.
  const known = await db
    .select({
      id: collections.id,
      readable: sql<number>`CASE WHEN ${condition} THEN 1 ELSE 0 END`,
    })
    .from(collections)
    .where(inList(collections.id, sourceIds));
  const found = new Set(
    known.flatMap(({ id, readable }) => (readable === 1 ? [id] : []))
  );
  const isCollection = new Set(known.map(({ id }) => id));
  for (const source of await readableApps(env, scope, sourceIds)) {
    found.add(source);
  }
  const rest = sourceIds.filter(
    (id) => !isCollection.has(id) && appReadOf(id) === undefined
  );
  if (rest.length === 0) {
    return found;
  }
  // Granted, and one the person may use themselves: shared, or their own
  // personal one (as `ConnectionsApi.list` decides it).
  const granted = await connectionGrants(env, scope);
  const owners = await connectionOwnersOf(env, [
    ...new Set(
      granted
        .map(({ connection }) => connection.connectionId)
        .filter((id) => rest.includes(id))
    ),
  ]);
  for (const { id, ownerUserId } of owners) {
    if (ownerUserId === null || ownerUserId === scope.personId) {
      found.add(id);
    }
  }
  return found;
};
