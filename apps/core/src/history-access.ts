import type { Permission } from "@grasp-os/shared/permissions";
import type { MemberRole } from "@grasp-os/shared/subject-members";
import { z } from "zod";

import { connectionGrants } from "./agent-connections.ts";
import { chatAuthority, chatContext, connectionReadOf } from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import { appFor } from "./apps.ts";
import { memberOf } from "./auth/identity.ts";
import {
  erasedForGoodAs,
  readableMemoriesAs,
  readableVersionsAs,
  versionRefSchema,
} from "./brain-next.ts";
import type {
  MemoryBasis,
  RecalledMemory,
  StoredMemoryPlace,
  SourceVersionRef,
} from "./brain-next.ts";
import { audienceOf } from "./chat-audiences.ts";
import { connectionOwnersOf } from "./connections.ts";
import { grantedPermissions, hasBrainGrant } from "./permissions.ts";

// What a chat's earlier code results may still send to the model (GRA-690).
// A result rests on what its run read, each recorded with the run: each
// connection call, with the action and resource its grant allowed
// (`recordSources`), an App's answer or files (`recordRunReads`), and what
// it read of the Brain (below). Before every model request the chat asks
// which of those its agent may still read for its person, as a read made
// now would be decided, and withholds the results of every run that read
// one it may not (`withheld` in chat-agent.ts, then `rebase`): a person
// who left a team or an App, an agent whose grant was revoked (the one a
// connection call was made under, whatever other grant on that connection
// stays), an App deleted. A source no check here names (one an earlier
// release recorded, a Knowledge collection or document say) is never
// readable: its run is withheld.
//
// What a run read under the agent's `brain` grant is pinned with that
// grant (`brainGrantRead`), so its results are withheld once the grant is
// revoked.

/** The source a run's read of the Brain under the agent's `brain` grant is recorded as. */
export const brainGrantRead = "brain-grant";

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
export const brainMemoryPrefix = "brain-memory:";
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

// A pin carries what its memory rests on as the recall read it
// (`MemoryBasis`): the source it was drawn from, its writer, and when the
// store learned it. That is what an erasure of it is told by
// (`erasedSources`): the erasure ledger names those, and outlives a lost
// storage, which a memory's row doesn't. A pin of a memory handed over
// without them (what names an entity a chat's code read rests on) holds
// `null`, and is never told erased.

/** What a pinned memory rests on, and none when it was handed over without it. */
export interface MemoryPin extends StoredMemoryPlace {
  basis: MemoryBasis | null;
}

/** The pin of `memory` as a recall handed it over, with what it rests on. */
export const recalledMemoryPin = (memory: RecalledMemory): MemoryPin => ({
  store: memory.store,
  memory: memory.memory,
  basis: {
    source: memory.source?.source ?? null,
    writer: memory.writer,
    learnedAt: memory.learnedAt.getTime(),
  },
});

/** The source a memory the new Brain handed a run is recorded as. */
export const brainMemoryRead = ({ store, memory, basis }: MemoryPin): string =>
  `${brainMemoryPrefix}${JSON.stringify([
    store,
    memory,
    basis === null
      ? null
      : [
          basis.source === null
            ? null
            : [basis.source.producer, basis.source.id],
          basis.writer,
          basis.learnedAt,
        ],
  ])}`;

/** The source a memory a recall as the company handed a run is recorded as. */
export const brainCompanyMemoryRead = (pin: MemoryPin): string =>
  `${brainCompanyMemoryPrefix}${brainMemoryRead(pin).slice(brainMemoryPrefix.length)}`;

/** A memory's place in a pin: its store, and its id, a UUID as the Brain's are. */
export const brainMemorySchema = z.tuple([z.enum(["own", "shared"]), z.uuid()]);

/** What a memory rests on, as a pin holds it (`brainMemoryRead`). */
const memoryBasisSchema = z
  .tuple([
    z.tuple([z.unknown(), z.unknown()]).nullable(),
    z.string().min(1).nullable(),
    z.int().nonnegative(),
  ])
  .transform(([source, writer, learnedAt], context) => {
    if (source === null) {
      return { source: null, writer, learnedAt };
    }
    const ref = versionRefSchema.shape.source.safeParse({
      producer: source[0],
      id: source[1],
    });
    if (!ref.success) {
      context.addIssue({ code: "custom", message: "Not a source" });
      return z.NEVER;
    }
    return { source: ref.data, writer, learnedAt };
  });

/** A memory's pin: its place, and what it rests on, or none. */
const memoryPinSchema = z.tuple([
  z.enum(["own", "shared"]),
  z.uuid(),
  memoryBasisSchema.nullable(),
]);

/** The memory `source`, pinned under `prefix`, names, if it is one. */
export const brainMemoryOf = (
  source: string,
  prefix: string
): MemoryPin | undefined => {
  if (!source.startsWith(prefix)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.slice(prefix.length));
  } catch {
    return undefined;
  }
  const pin = memoryPinSchema.safeParse(parsed);
  if (!pin.success) {
    return undefined;
  }
  const [store, memory, basis] = pin.data;
  return { store, memory, basis };
};

/** A memory's place, as one string. */
const placeKeyOf = ({ store, memory }: StoredMemoryPlace): string =>
  JSON.stringify([store, memory]);

/**
 * Of the memories in `sources` pinned under `prefix`, those `reach` may
 * still read (`readableMemoriesAs`), in one read of each store per 500. A
 * pin that names no memory's place is read by no one: its run is withheld.
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
    pins.map(({ pin: { store, memory } }) => ({ store, memory })),
    { reach }
  );
  const readable = new Set(memories.map((place) => placeKeyOf(place)));
  return pins.flatMap(({ source, pin }) =>
    readable.has(placeKeyOf(pin)) ? [source] : []
  );
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

/**
 * Of the Brain reads in `sources`, the agent's `brain` grant, while it
 * holds it (`hasBrainGrant`), as the Brain's recall decides it.
 */
const readableBrain = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  sources: readonly string[]
): Promise<string[]> =>
  sources.includes(brainGrantRead) &&
  (await hasBrainGrant(env, chatAuthority(scope)))
    ? [brainGrantRead]
    : [];

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
  | "grants"
  | "connections"
  | "apps"
  | "unknown";

/** The kind of read `source` is: `unknown` for any no check names. */
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
  if (source === brainGrantRead) {
    return "grants";
  }
  if (connectionReadOf(source) !== undefined) {
    return "connections";
  }
  return appReadOf(source) === undefined ? "unknown" : "apps";
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
 * not; one with none as `unknown`.
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
 * connection call a grant the agent holds in this chat now covers, on a
 * connection not disconnected that the person may use themselves; an App
 * read the agent's grants and the person's role in the App allow now; the
 * agent's `brain` grant, while it holds it; a version of the Brain, while the person may read it (their teams and
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
  // Read once for both kinds of company pin, so they agree.
  const cut = audienceCut(env, scope, sourceIds);
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

/** The version a pin of the new Brain names, at whatever reach it was read. */
const versionPinOf = (source: string): SourceVersionRef | undefined => {
  const prefix = [
    brainVersionPrefix,
    brainTeamVersionPrefix,
    brainCompanyVersionPrefix,
  ].find((each) => source.startsWith(each));
  return prefix === undefined
    ? undefined
    : brainVersionOf(`${brainVersionPrefix}${source.slice(prefix.length)}`);
};

/** The memory a pin of the new Brain names, at whatever reach it was read. */
const memoryPinOf = (source: string): MemoryPin | undefined =>
  brainMemoryOf(source, brainMemoryPrefix) ??
  brainMemoryOf(source, brainCompanyMemoryPrefix);

/** A pinned version's source, as one string. */
const sourceKey = ({ producer, id }: SourceVersionRef["source"]): string =>
  JSON.stringify([producer, id]);

/**
 * Of the new Brain's pins in `sourceIds`, those whose content an erasure
 * took for good (`erasedForGoodAs`), at whatever reach the read pinned them: a
 * version whose source was erased, a memory an erasure deleted. What a
 * chat of `personId`'s shows of a run resting on one is replaced
 * (workspace.ts `#replaceErased`); one only no longer readable (narrowed,
 * retired, the person out of a team) never is, as the person saw it while
 * they could. Any other source, or a pin that names nothing, is not
 * erased here: its run is withheld from the model all the same
 * (`readableSources`). Throws what the Brain throws.
 */
export const erasedSources = async (
  env: Env,
  personId: string,
  sourceIds: readonly string[]
): Promise<Set<string>> => {
  const versions = sourceIds.flatMap((source) => {
    const pin = versionPinOf(source);
    return pin === undefined ? [] : [{ source, pin }];
  });
  // A memory pinned without what it rests on is never told erased.
  const memories = sourceIds.flatMap((source) => {
    const pin = memoryPinOf(source);
    return pin?.basis === undefined || pin.basis === null
      ? []
      : [{ source, pin: { ...pin, basis: pin.basis } }];
  });
  if (versions.length === 0 && memories.length === 0) {
    return new Set();
  }
  const erased = await erasedForGoodAs(env, personId, {
    sources: versions.map(({ pin }) => pin.source),
    memories: memories.map(({ pin }) => pin),
  });
  const keys = new Set(erased.sources.map((ref) => sourceKey(ref)));
  const places = new Set(erased.memories.map((place) => placeKeyOf(place)));
  return new Set([
    ...versions.flatMap(({ source, pin }) =>
      keys.has(sourceKey(pin.source)) ? [source] : []
    ),
    ...memories.flatMap(({ source, pin }) =>
      places.has(placeKeyOf(pin)) ? [source] : []
    ),
  ]);
};
