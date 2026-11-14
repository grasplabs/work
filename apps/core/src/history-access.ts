import { brainErrors } from "@grasp-os/brain/contract";
import { d1BrainStore } from "@grasp-os/brain/recall-store";
import type { BrainStore, PinnedVersion } from "@grasp-os/brain/recall-store";
import { collections } from "@grasp-os/brain/schema";
import type { Permission } from "@grasp-os/shared/permissions";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { MemberRole } from "@grasp-os/shared/subject-members";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { connectionGrants } from "./agent-connections.ts";
import { chatAuthority, chatContext, connectionReadOf } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { appFor } from "./apps.ts";
import { memberOf } from "./auth/identity.ts";
import {
  readableMemoriesAs,
  readableVersionsAs,
  versionRefSchema,
} from "./brain-next.ts";
import type { StoredMemoryPlace, SourceVersionRef } from "./brain-next.ts";
import { audienceOf } from "./chat-audiences.ts";
import { connectionOwnersOf } from "./connections.ts";
import { inList } from "./db/d1.ts";
import { collectionsAllowed } from "./knowledge/access.ts";
import { readAsDelegate } from "./knowledge/binding.ts";
import { brainOf } from "./knowledge/ports.ts";
import { grantedPermissions } from "./permissions.ts";

// What a chat's earlier code results may still send to the model (GRA-690).
// A result rests on what its run read, each recorded with the run:
// collections and each connection call, with the action and resource its
// grant allowed (`recordSources`), and an App's answer or files
// and the Knowledge catalog's collections (`recordRunReads`). Before every
// model request the chat asks which of those its agent may still read for
// its person, as a read made now would be decided, and withholds the
// results of every run that read one it may not (`withheld` in
// chat-agent.ts, then `rebase`): a person who left a team or an App, an
// agent whose grant was revoked (the one a connection call was made under,
// whatever other grant on that connection stays), a collection or App
// deleted.
//
// What a run read of the Brain is pinned too (GRA-299; the threat model is
// on the issue): beside its collections, the agent's `brain` grant it read
// under (`brainGrantRead`) and each document it was handed
// (`brainDocumentRead`), at its version, pinned as its text was
// (`PinnedVersion`), so its results are withheld once that grant is
// revoked, or once a document it was handed is erased, moved or purged,
// though its collection may still be read.

/** The source a run's read of the Brain under the agent's `brain` grant is recorded as. */
export const brainGrantRead = "brain-grant";

const brainDocumentPrefix = "brain-document:";

/** The source a document version handed to a run is recorded as: pinned. */
export const brainDocumentRead = ({
  collectionId,
  documentId,
  version,
  text,
}: PinnedVersion): string =>
  `${brainDocumentPrefix}${JSON.stringify([collectionId, documentId, version, text])}`;

const pinnedSourceSchema = z.tuple([
  z.string().min(1),
  z.string().min(1),
  z.int().min(1),
  z.string().min(1),
]);

/** The pinned version a `brainDocumentRead` source names, if it is one. */
const brainDocumentOf = (source: string): PinnedVersion | undefined => {
  if (!source.startsWith(brainDocumentPrefix)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.slice(brainDocumentPrefix.length));
  } catch {
    return undefined;
  }
  const pin = pinnedSourceSchema.safeParse(parsed);
  if (!pin.success) {
    return undefined;
  }
  const [collectionId, documentId, version, text] = pin.data;
  return { collectionId, documentId, version, text };
};

// What a chat's recall before a question read of the new Brain
// (turn-recall.ts) is pinned too: each version it handed over, by its
// source as its producer names it and its number. A version never changes
// and an erased source's key is never added again, so a pin means the same
// text for as long as it is kept; it is withheld once the person may no
// longer read that version (`readableVersionsAs`), and with the agent's
// `brain` grant (`brainGrantRead`).

const brainVersionPrefix = "brain-version:";

/** The source a version the new Brain handed a run is recorded as. */
export const brainVersionRead = ({
  source,
  version,
}: SourceVersionRef): string =>
  `${brainVersionPrefix}${JSON.stringify([source.producer, source.id, version])}`;

/**
 * A pin's version as the Brain names one (`versionRefSchema`): of a kind
 * of source a producer has, by an id it could give.
 */
const brainVersionSchema = z
  .tuple([z.unknown(), z.unknown(), z.unknown()])
  .transform(([producer, id, version]) => ({
    source: { producer, id },
    version,
  }))
  .pipe(versionRefSchema);

/** The version a `brainVersionRead` source names, if it is one. */
const brainVersionOf = (source: string): SourceVersionRef | undefined => {
  if (!source.startsWith(brainVersionPrefix)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.slice(brainVersionPrefix.length));
  } catch {
    return undefined;
  }
  // One the Brain couldn't name (a kind no producer has now) is withheld
  // alone, as no version it may read; never failing the whole check.
  const pin = brainVersionSchema.safeParse(parsed);
  return pin.success ? pin.data : undefined;
};

/**
 * Of the new Brain's versions in `sources`, those the person may still
 * read, in one read of the Brain per 500 (`readableVersionsAs`).
 */
const readableBrainVersions = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  sources: readonly string[]
): Promise<string[]> => {
  const pins = sources.flatMap((source) => {
    const pin = brainVersionOf(source);
    return pin === undefined ? [] : [{ source, pin }];
  });
  if (pins.length === 0) {
    return [];
  }
  const versions = await readableVersionsAs(
    env,
    scope.personId,
    pins.map(({ pin }) => pin)
  );
  const readable = new Set(versions.map((ref) => brainVersionRead(ref)));
  return pins.flatMap(({ source }) => (readable.has(source) ? [source] : []));
};

// What a chat's code recalled (`env.brain.recall`, agent-brain.ts) is
// pinned the same way under a prefix of its own: code reads as the
// person's teams and the company, never what only they may read
// (brain-recall.ts), so it is checked as they read it, and withheld once
// those may no longer read it, even if the person alone still may.

const brainTeamVersionPrefix = "brain-team-version:";

/** The source a version code's recall handed a run is recorded as. */
export const brainTeamVersionRead = (ref: SourceVersionRef): string =>
  `${brainTeamVersionPrefix}${brainVersionRead(ref).slice(brainVersionPrefix.length)}`;

// What a chat's recall before a question read as the company alone
// (turn-recall.ts: anywhere but the person's own chat in Grasp, in a turn
// they started) is pinned under a prefix of its own too, and checked as
// the company reads it: withheld once everyone in the company may no
// longer read it, even if the person still may, and every one of them
// once anyone Grasp can't name as a member is in a chat others share.

const brainCompanyVersionPrefix = "brain-company-version:";

/** The source a version a recall as the company handed a run is recorded as. */
export const brainCompanyVersionRead = (ref: SourceVersionRef): string =>
  `${brainCompanyVersionPrefix}${brainVersionRead(ref).slice(brainVersionPrefix.length)}`;

// The memories' prefixes (below), beside the versions': what a recall as
// the company pinned is either kind.
const brainMemoryPrefix = "brain-memory:";
const brainCompanyMemoryPrefix = "brain-company-memory:";

/** Whether `source` is a pin of a recall as the company. */
const isCompanyPin = (source: string): boolean =>
  source.startsWith(brainCompanyVersionPrefix) ||
  source.startsWith(brainCompanyMemoryPrefix);

/**
 * Of the versions in `sources` pinned under `prefix`, those `reach` may
 * still read (`readableVersionsAs`), in one read of the Brain per 500.
 */
const readableAt = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  sources: readonly string[],
  prefix: string,
  reach: "teams" | "company"
): Promise<string[]> => {
  const pins = sources.flatMap((source) => {
    const pin = source.startsWith(prefix)
      ? brainVersionOf(`${brainVersionPrefix}${source.slice(prefix.length)}`)
      : undefined;
    return pin === undefined ? [] : [{ source, pin }];
  });
  if (pins.length === 0) {
    return [];
  }
  const versions = await readableVersionsAs(
    env,
    scope.personId,
    pins.map(({ pin }) => pin),
    { reach }
  );
  const readable = new Set(
    versions.map(
      (ref) =>
        `${prefix}${brainVersionRead(ref).slice(brainVersionPrefix.length)}`
    )
  );
  return pins.flatMap(({ source }) => (readable.has(source) ? [source] : []));
};

/**
 * Why what a recall as the company handed over may not be sent in a chat
 * others share, the history's own cause (GRA-1882): anyone Grasp can't
 * name as a member is in it (`outsiders`), as last kept from the
 * platform's roster (`chat_audiences`); or no roster is kept for it
 * (`unkept`), as its first turn refuses a roster it couldn't read.
 */
export type AudienceCut = "outsiders" | "unkept";

/**
 * Why the chat may not be sent what a recall as the company handed over,
 * or `undefined` while it may (`AudienceCut`), or `sources` holds none
 * of its pins. The row can be gone while
 * the chat keeps its pins (core's database restored to before it, a turn
 * a restart cut short set up again without the turn's own check). A chat
 * nobody else shares keeps none, and reads as the company may.
 */
const audienceCut = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  sources: readonly string[]
): Promise<AudienceCut | undefined> => {
  if (!sources.some((source) => isCompanyPin(source))) {
    return undefined;
  }
  const audience = await audienceOf(env, chatContext(scope));
  if (audience === undefined) {
    return scope.shared === true ? "unkept" : undefined;
  }
  return audience.outsiders ? "outsiders" : undefined;
};

/**
 * Of the versions a recall as the company handed over in `sources`, those
 * everyone in the company may still read: none while the chat's audience
 * cuts them (`cut`), so a guest joining withholds what earlier turns
 * recalled from the next request on (GRA-1820).
 */
const readableBrainCompanyVersions = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  sources: readonly string[],
  cut: Promise<AudienceCut | undefined>
): Promise<string[]> => {
  if (!sources.some((source) => source.startsWith(brainCompanyVersionPrefix))) {
    return [];
  }
  return (await cut) === undefined
    ? await readableAt(
        env,
        scope,
        sources,
        brainCompanyVersionPrefix,
        "company"
      )
    : [];
};

// Each memory a chat's recall before a question handed over is pinned too,
// by the store it is in and that store's id for it, under the prefix of
// the reach the recall read at, as its versions are: `brain-memory:` for
// the person's own chat, `brain-company-memory:` for a recall as the
// company. An id is never used again, so a pin means the same memory for
// as long as it is kept, and it is asked of that store alone, at that
// reach. It is withheld, as a passage is, once that reach may no longer
// read it (erased, its source narrowed, the person out of the team, or,
// as the company, anyone unnamed in the chat), or its writer retired it
// (`readableMemoriesAs`), and with the agent's `brain` grant. A newer
// memory that replaced it withholds nothing: the next recall brings that.

/** The source a memory the new Brain handed a run is recorded as. */
export const brainMemoryRead = ({ store, memory }: StoredMemoryPlace): string =>
  `${brainMemoryPrefix}${JSON.stringify([store, memory])}`;

/** The source a memory a recall as the company handed a run is recorded as. */
export const brainCompanyMemoryRead = (place: StoredMemoryPlace): string =>
  `${brainCompanyMemoryPrefix}${brainMemoryRead(place).slice(brainMemoryPrefix.length)}`;

const brainMemorySchema = z.tuple([
  z.enum(["own", "shared"]),
  z.string().min(1),
]);

/** The memory `source`, pinned under `prefix`, names, if it is one. */
const brainMemoryOf = (
  source: string,
  prefix: string
): StoredMemoryPlace | undefined => {
  if (!source.startsWith(prefix)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.slice(prefix.length));
  } catch {
    return undefined;
  }
  const pin = brainMemorySchema.safeParse(parsed);
  if (!pin.success) {
    return undefined;
  }
  const [store, memory] = pin.data;
  return { store, memory };
};

/**
 * Of the memories in `sources` pinned under `prefix`, those `reach` may
 * still read (`readableMemoriesAs`), in one read of each store per 500. A
 * pin whose id isn't one is refused there, and the check withholds all.
 */
const readableMemoriesAt = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  sources: readonly string[],
  prefix: string,
  reach: "person" | "company"
): Promise<string[]> => {
  const pins = sources.flatMap((source) => {
    const pin = brainMemoryOf(source, prefix);
    return pin === undefined ? [] : [{ source, pin }];
  });
  if (pins.length === 0) {
    return [];
  }
  const memories = await readableMemoriesAs(
    env,
    scope.personId,
    pins.map(({ pin }) => pin),
    { reach }
  );
  const readable = new Set(
    memories.map(
      (place) =>
        `${prefix}${brainMemoryRead(place).slice(brainMemoryPrefix.length)}`
    )
  );
  return pins.flatMap(({ source }) => (readable.has(source) ? [source] : []));
};

/** Of the memories the person's own chat pinned in `sources`, those they may still read. */
const readableBrainMemories = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  sources: readonly string[]
): Promise<string[]> =>
  await readableMemoriesAt(env, scope, sources, brainMemoryPrefix, "person");

/**
 * Of the memories a recall as the company handed over in `sources`, those
 * everyone in the company may still read: none while the chat's audience
 * cuts them (`cut`).
 */
const readableBrainCompanyMemories = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  sources: readonly string[],
  cut: Promise<AudienceCut | undefined>
): Promise<string[]> => {
  if (!sources.some((source) => source.startsWith(brainCompanyMemoryPrefix))) {
    return [];
  }
  return (await cut) === undefined
    ? await readableMemoriesAt(
        env,
        scope,
        sources,
        brainCompanyMemoryPrefix,
        "company"
      )
    : [];
};

/** Whether `error` refuses the Brain's read, rather than failing it. */
const isBrainRefusal = (error: unknown): boolean =>
  brainErrors.codeOf(error) === "brain.denied" ||
  permissionErrors.codeOf(error) === "permission.denied";

/** Whether the Brain's recall admits `reader` now. */
const holdsBrainGrant = async <C>(
  store: BrainStore<C>,
  reader: C
): Promise<boolean> => {
  try {
    await store.requireBrainGrant(reader);
    return true;
  } catch (error) {
    if (isBrainRefusal(error)) {
      return false;
    }
    throw error;
  }
};

/**
 * Of the Brain reads in `sources`, those the agent may make for its person
 * now, read as its delegate as a recall is: the grant, while the Brain's
 * recall admits the agent; each document version, while it is in its
 * collection, the agent may read it there, and no purge rewrote it since
 * it was pinned (one query, whatever their number).
 */
const readableBrain = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  sources: readonly string[]
): Promise<string[]> => {
  const grant = sources.includes(brainGrantRead);
  const refs = sources.flatMap((source) => {
    const pin = brainDocumentOf(source);
    return pin === undefined ? [] : [{ source, pin }];
  });
  if (!grant && refs.length === 0) {
    return [];
  }
  const store = d1BrainStore(brainOf(env));
  return await readAsDelegate(
    env,
    chatAuthority(scope),
    chatContext(scope),
    undefined,
    async (reader) => {
      const [granted, unchanged] = await Promise.all([
        grant ? holdsBrainGrant(store, reader) : false,
        store.unchangedPins(
          reader,
          refs.map(({ pin }) => pin)
        ),
      ]);
      return [
        ...(granted ? [brainGrantRead] : []),
        ...refs.flatMap(({ source, pin }) =>
          unchanged.includes(pin) ? [source] : []
        ),
      ];
    }
  );
};

/** How a run read an App, each checked as a read made now would be. */
const appReads = {
  /**
   * One of its queries answered: the agent's `read` grant on it, the
   * person's role, as the call needed.
   */
  query: "app-query",
  /** A mutation or action answered: the agent's `write` grant, the person's role. */
  write: "app-write",
  /** Its files or versions: the person builds it, as `env.apps` reads them. */
  build: "app-build",
} as const;

type AppRead = keyof typeof appReads;

/** The source a run read of App `appId` is recorded as. */
export const appRead = (read: AppRead, appId: string): string =>
  `${appReads[read]}:${appId}`;

const appReadOf = (
  source: string
): { read: AppRead; appId: string } | undefined => {
  for (const read of ["query", "write", "build"] as const) {
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
): { granted: boolean; role: MemberRole } => {
  if (read === "build") {
    // The person's own Apps, which the agent reads as them with no
    // permission of its own (agent-apps.ts).
    return { granted: true, role: "builder" };
  }
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
};

/** Each kind of read a source is, as the withheld event counts them. */
type WithheldKind =
  | "memories"
  | "passages"
  | "documents"
  | "grants"
  | "connections"
  | "apps"
  | "collections";

/** The kind of read `source` is: any it doesn't name, a collection, by its ID. */
const withheldKindOf = (source: string): WithheldKind => {
  if (
    source.startsWith(brainMemoryPrefix) ||
    source.startsWith(brainCompanyMemoryPrefix)
  ) {
    return "memories";
  }
  if (
    [
      brainVersionPrefix,
      brainTeamVersionPrefix,
      brainCompanyVersionPrefix,
    ].some((prefix) => source.startsWith(prefix))
  ) {
    return "passages";
  }
  if (source.startsWith(brainDocumentPrefix)) {
    return "documents";
  }
  if (source === brainGrantRead) {
    return "grants";
  }
  if (connectionReadOf(source) !== undefined) {
    return "connections";
  }
  return appReadOf(source) === undefined ? "collections" : "apps";
};

/**
 * What the audit says of the reads a history check newly withheld
 * (`chat.history_withheld`, one event a check, GRA-1882): how many runs
 * it newly withheld (`runs`: none an earlier event withheld, so the
 * events of a chat add up), how many sources, and how many of each kind,
 * never which; and, when it cut what a recall as the company handed over
 * for the chat's audience, why (`audience`, `AudienceCut`). A source
 * names what was read (a memory, a version of a producer's source, a
 * document with its text): every other cause (a narrowed source, a
 * revoked grant, a person out of a team) is audited where it happened,
 * and this records its effect on the chat, which the event's target
 * names. A pin is counted under the kind its prefix names, parsed or
 * not; one with none a collection's, as a bare ID is.
 */
export const withheldDetail = ({
  runs,
  sources,
  audience,
}: {
  runs: number;
  sources: readonly string[];
  audience: AudienceCut | undefined;
}): Record<string, number | string> => {
  const distinct = [...new Set(sources)];
  const detail: Record<string, number | string> = {
    runs,
    sources: distinct.length,
  };
  for (const source of distinct) {
    const kind = withheldKindOf(source);
    detail[kind] = Number(detail[kind] ?? 0) + 1;
  }
  if (audience !== undefined && distinct.some(isCompanyPin)) {
    detail.audience = audience;
  }
  return detail;
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
 * agent's grants and the person's role in the App allow now; a Brain
 * read, while the Brain's recall admits the agent and each document it
 * was handed is still in its collection for it to read, unpurged; a
 * version of the new Brain, while the person may read it (their teams and
 * the company, for what code's recall handed over); a memory of the new
 * Brain, while the person (or, as the company read it, the company) may
 * read it and its writer has not retired it, replaced or expired or not.
 * Anything else, an unknown source or a bare connection included, is
 * not. With why the chat's audience cuts what a recall as the company
 * handed over, when it holds any (`audience`). Throws what the reads
 * throw (a person who left, a database away): the caller withholds
 * everything then.
 */
export const readableSources = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  sourceIds: readonly string[]
): Promise<{ readable: Set<string>; audience?: AudienceCut }> => {
  if (sourceIds.length === 0) {
    return { readable: new Set() };
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
  // Read once for both kinds of company pin, so they agree.
  const cut = audienceCut(env, scope, sourceIds);
  // `readableBrain` reads today's Brain, and goes with it (GRA-1735).
  const [
    apps,
    connections,
    brain,
    versions,
    teamVersions,
    companyVersions,
    memories,
    companyMemories,
  ] = await Promise.all([
    readableApps(env, scope, sourceIds),
    readableConnections(env, scope, sourceIds),
    readableBrain(env, scope, sourceIds),
    readableBrainVersions(env, scope, sourceIds),
    readableAt(env, scope, sourceIds, brainTeamVersionPrefix, "teams"),
    readableBrainCompanyVersions(env, scope, sourceIds, cut),
    readableBrainMemories(env, scope, sourceIds),
    readableBrainCompanyMemories(env, scope, sourceIds, cut),
  ]);
  const audience = await cut;
  const readable = new Set([
    ...known.flatMap(({ id, readable: may }) => (may === 1 ? [id] : [])),
    ...apps,
    ...connections,
    ...brain,
    ...versions,
    ...teamVersions,
    ...companyVersions,
    ...memories,
    ...companyMemories,
  ]);
  return audience === undefined ? { readable } : { readable, audience };
};
