import { and, desc, eq, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { allowedFor } from "./authorize.ts";
import type { Brain } from "./brain.ts";
import type {
  MemoryItem,
  NetworkPath,
  NetworkStep,
  RelationView,
} from "./contract.ts";
import { inList } from "./db/d1.ts";
import { brainAssertions, collections, documents } from "./db/schema.ts";
import { toHex } from "./encoding.ts";
import type { Provenance } from "./knowledge.ts";
import { currentRelations, readable, readRowsMax } from "./relations.ts";
import type { ReadRelation, ReadScope, ReadSource } from "./relations.ts";

// A recall's network route (GRA-307, the Brain design's bounded activation):
// from the entities the sources a recall found name, along the relations
// the Brain stored from sources' passages, one hop or two, each relation
// the caller may read becoming evidence of its own, with its exact path.
//
// It invents nothing. It reads `brain_assertions` alone: relations stored
// from a source's own passage, each with that passage. It calls no model,
// scores nothing and makes no edge; an item's statement is the passage.
//
// Every hop is a read as `relations.get` reads (relations.ts, `readable`):
// what the caller may read now, its access filter inside the SQL before
// every cap, so a relation it can't read never shows, never leads anywhere,
// and never takes a place under a cap. A recall bound to collections (an
// App's binding, a filter) follows relations in those alone. Relations
// from memory records aren't followed: a recall in a shared chat serves
// the chat's audience, and the relation reads' scope is a person's own
// memories (a later slice, with an audience-aware scope).
//
// Bounded: hops, the entities gone on from at each, the rows each read
// takes, the recall's deadline and its items. Each cut is reported, and a
// cut proves nothing missing.

/** The policy that follows the paths: plain traversal, version 1. */
export const networkPolicyVersion = "traversal@1";

/** The most entities the route goes on from, at each hop. */
export const networkFanOut = 20;

/** Why the route left out what it might have followed. */
export type NetworkCut = "deadline" | "fan_out" | "rows" | "items";

/** A document the recall found, at the version it found it. */
export interface FoundDocument {
  documentId: string;
  version: number;
}

/** What the network route answers: its items, their paths, what it read. */
export interface NetworkFound {
  items: { item: MemoryItem; path: NetworkPath }[];
  cuts: NetworkCut[];
  provenance: Provenance;
}

/** What the route reads with, past the recall's own checks. */
export interface NetworkQuery {
  hops: 1 | 2;
  /** The documents the recall's full-text route found. */
  found: readonly FoundDocument[];
  /** The collections the recall is bound to; undefined: all it may read. */
  within: readonly string[] | undefined;
  /** When the recall's deadline passes, on the host's clock. */
  deadline: number;
  /** The most items it may add. */
  maxItems: number;
}

/** Longest statement an item carries, as recall's own. */
const statementMaxLength = 4000;

/** An entity a relation names, as its source names it. */
type End = RelationView["subject"];

/** A relation's identity: its source version and what it relates. */
const keyOf = (view: RelationView): string =>
  JSON.stringify([
    view.sourceRef,
    view.subject.entityId,
    view.predicate,
    view.object.entityId,
  ]);

/** Whether `view` comes from a document version the recall found. */
const fromFound = (view: RelationView, found: ReadonlySet<string>): boolean =>
  view.sourceRef.kind === "document" &&
  found.has(`${view.sourceRef.documentId}@${view.sourceRef.version}`);

/** The entity at `view`'s other end from `entityId`. */
const otherEnd = (view: RelationView, entityId: string): End =>
  view.subject.entityId === entityId ? view.object : view.subject;

/** `view` as a path's step. */
const stepOf = (view: RelationView): NetworkStep => ({
  kind: "typed_assertion",
  subject: view.subject,
  predicate: view.predicate,
  object: view.object,
  sourceRef: view.sourceRef,
});

/** A relation's validity bound as an instant, when it reads as one. */
const instantOf = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }
  const at = new Date(/^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}Z` : value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

/** A short, stable item ID for the relation `key` names. */
const itemIdOf = async (key: string): Promise<string> => {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key)
  );
  return `relation:${toHex(new Uint8Array(hash)).slice(0, 32)}`;
};

/** A path's relations, read as a sentence, for its applicability. */
const said = (steps: readonly NetworkStep[]): string =>
  steps
    .map(({ subject, predicate, object }) =>
      [subject.name, predicate.replaceAll("_", " "), object.name].join(" ")
    )
    .join("; ");

/** The relation at the end of `steps` as a pack's item, with its path. */
const itemOf = async (
  view: RelationView,
  seed: End,
  steps: NetworkStep[]
): Promise<{ item: MemoryItem; path: NetworkPath }> => {
  const id = await itemIdOf(keyOf(view));
  const revision =
    view.sourceRef.kind === "document"
      ? view.sourceRef.version
      : view.sourceRef.revision;
  return {
    item: {
      id,
      revision,
      kind: "fact",
      statement: view.evidence.slice(0, statementMaxLength),
      sourceRefs: [view.sourceRef],
      authorityState: "source",
      validFrom: instantOf(view.validFrom),
      validTo: instantOf(view.validTo),
      recordedAt: view.recordedAt,
      applicability: `${seed.name}, named in evidence the recall found, is related by stored relation${steps.length === 1 ? "" : "s"}: ${said(steps)}.`,
      citationLocator: [],
    },
    path: { itemId: id, seed, steps },
  };
};

/**
 * Relations of `found`, each at its version, bound as one parameter
 * (`inList`) however many there are: the last `@` of each key parts the
 * document's ID from its version, a whole number.
 */
const ofFound = (found: readonly FoundDocument[]): SQL =>
  inList(
    sql`${brainAssertions.documentId} || '@' || ${brainAssertions.version}`,
    found.map(({ documentId, version }) => `${documentId}@${version}`)
  );

/**
 * The entities the relations of `found` name, that `scope` may read now,
 * newest relation first, each once: where the route starts. Whether the
 * read's cap left any out (`cut`).
 */
const seedsOf = async <C>(
  brain: Brain<C>,
  scope: ReadScope,
  query: NetworkQuery
): Promise<{ seeds: End[]; cut: boolean }> => {
  const rows = await brain.db
    .select({
      subjectEntityId: brainAssertions.subjectEntityId,
      subjectName: brainAssertions.subjectName,
      objectEntityId: brainAssertions.objectEntityId,
      objectName: brainAssertions.objectName,
    })
    .from(brainAssertions)
    .innerJoin(documents, eq(documents.id, brainAssertions.documentId))
    .innerJoin(collections, eq(collections.id, documents.collectionId))
    .where(
      and(
        scope.allowed.documents(),
        eq(collections.sensitive, false),
        query.within === undefined
          ? undefined
          : inList(collections.id, query.within),
        currentRelations(),
        ofFound(query.found)
      )
    )
    .orderBy(desc(brainAssertions.recordedAt))
    .limit(readRowsMax + 1);
  const seeds = new Map<string, End>();
  for (const row of rows.slice(0, readRowsMax)) {
    for (const end of [
      { entityId: row.subjectEntityId, name: row.subjectName },
      { entityId: row.objectEntityId, name: row.objectName },
    ]) {
      if (!seeds.has(end.entityId)) {
        seeds.set(end.entityId, end);
      }
    }
  }
  return { seeds: [...seeds.values()], cut: rows.length > readRowsMax };
};

/**
 * Reports what the route read to the host, as every Brain read is: every
 * row its hops considered (`considered`, past a cap too, as relations.ts
 * reports them), and how many relations it kept.
 */
const reported = async <C>(
  brain: Brain<C>,
  reader: C,
  considered: readonly ReadSource[],
  kept: number
): Promise<Provenance> => {
  const collectionIds = [
    ...new Set(considered.flatMap(({ collectionId }) => collectionId ?? [])),
  ];
  const documentIds = [
    ...new Set(considered.flatMap(({ documentId }) => documentId ?? [])),
  ];
  return await brain.ports.onRead(
    reader,
    {
      action: "knowledge.read",
      documentIds: documentIds.slice(0, 20),
      detail: {
        read: "recall.network",
        relations: kept,
        considered: considered.length,
        documents: documentIds.length,
      },
    },
    ...collectionIds.map((id) => ({ id, sensitive: false }))
  );
};

/** `read`'s value, wrapped, so a race tells it from an expiry. */
const answered = async <T>(read: Promise<T>): Promise<{ value: T }> => ({
  value: await read,
});

/** `null`, once `ms` milliseconds have passed. */
const expired = async (ms: number): Promise<null> => {
  await scheduler.wait(ms);
  return null;
};

/**
 * `read`, or undefined once the deadline passes first: a read that would
 * outlast it is given up on (its rows are left unread), as the recall's
 * own full-text read is.
 */
const beforeDeadline = async <C, T>(
  brain: Brain<C>,
  deadline: number,
  read: Promise<T>
): Promise<T | undefined> => {
  const remaining = deadline - brain.ports.clock().getTime();
  if (remaining <= 0) {
    return undefined;
  }
  const settled = await Promise.race([answered(read), expired(remaining)]);
  return settled?.value;
};

/**
 * Each entity of `starts` once, as first reached: an entity two relations
 * reach is one start, so it takes one of a hop's `networkFanOut` places.
 */
const distinct = (starts: readonly Start[]): Start[] => {
  const byEntity = new Map<string, Start>();
  for (const start of starts) {
    if (!byEntity.has(start.entity.entityId)) {
      byEntity.set(start.entity.entityId, start);
    }
  }
  return [...byEntity.values()];
};

/** One hop's start: an entity, how the path reached it, and from where. */
interface Start {
  entity: End;
  seed: End;
  steps: NetworkStep[];
  /** The entities on the path so far, which it never goes back to. */
  passed: ReadonlySet<string>;
}

/** A relation the route reached: from which seed, along which steps. */
interface Reached {
  view: RelationView;
  seed: End;
  steps: NetworkStep[];
}

/**
 * The relations of `relations`, read from `start`, that the route takes:
 * never one from a document the recall found (its passage is there
 * already), one taken before (`seen`, which it adds to), or one back along
 * the path. Each is reached, and its far end is the next hop's start
 * unless it is a seed, gone on from as one already.
 */
const steppedFrom = (
  start: Start,
  relations: readonly ReadRelation[],
  {
    found,
    seen,
    seedIds,
  }: {
    found: ReadonlySet<string>;
    seen: Set<string>;
    seedIds: ReadonlySet<string>;
  }
): { reached: Reached[]; next: Start[] } => {
  const reached: Reached[] = [];
  const next: Start[] = [];
  for (const { view } of relations) {
    const to = otherEnd(view, start.entity.entityId);
    const key = keyOf(view);
    const back =
      start.passed.has(to.entityId) || to.entityId === start.entity.entityId;
    if (fromFound(view, found) || seen.has(key) || back) {
      continue;
    }
    seen.add(key);
    const steps = [...start.steps, stepOf(view)];
    reached.push({ view, seed: start.seed, steps });
    if (!seedIds.has(to.entityId)) {
      next.push({
        entity: to,
        seed: start.seed,
        steps,
        passed: new Set([...start.passed, to.entityId]),
      });
    }
  }
  return { reached, next };
};

/**
 * The network route of a recall by `reader`, from what its full-text route
 * `found` (see the header): the relations it may read, one or two hops out
 * from the entities those name, as items with their paths, at most
 * `maxItems`, and every cut. Reads nothing once the deadline has passed.
 */
export const networkOf = async <C>(
  brain: Brain<C>,
  reader: C,
  query: NetworkQuery
): Promise<NetworkFound> => {
  const none: NetworkFound = {
    items: [],
    cuts: [],
    provenance: { collectionIds: [], sensitive: false, restricted: false },
  };
  if (query.found.length === 0 || query.within?.length === 0) {
    return none;
  }
  // No room for an item: nothing is read, so nothing labels the pack.
  if (query.maxItems <= 0) {
    return { ...none, cuts: ["items"] };
  }
  if (brain.ports.clock().getTime() >= query.deadline) {
    return { ...none, cuts: ["deadline"] };
  }
  // The documents the caller may read, and no memory record's relations.
  const scope: ReadScope = {
    allowed: await allowedFor(brain.ports, reader),
    owner: undefined,
    ownerReads: [],
  };
  const cuts = new Set<NetworkCut>();
  const seeded = await beforeDeadline(
    brain,
    query.deadline,
    seedsOf(brain, scope, query)
  );
  if (seeded === undefined) {
    return { ...none, cuts: ["deadline"] };
  }
  const { seeds, cut } = seeded;
  if (cut) {
    cuts.add("rows");
  }
  const found = new Set(
    query.found.map(({ documentId, version }) => `${documentId}@${version}`)
  );
  const seen = new Set<string>();
  const considered: ReadSource[] = [];
  const reached: { view: RelationView; seed: End; steps: NetworkStep[] }[] = [];
  const seedIds = new Set(seeds.map(({ entityId }) => entityId));
  let starts: Start[] = seeds.map((seed) => ({
    entity: seed,
    seed,
    steps: [],
    passed: new Set([seed.entityId]),
  }));
  for (let hop = 1; hop <= query.hops && starts.length > 0; hop += 1) {
    if (starts.length > networkFanOut) {
      cuts.add("fan_out");
    }
    const next: Start[] = [];
    for (const start of starts.slice(0, networkFanOut)) {
      if (reached.length > query.maxItems) {
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- one read at a time, within the deadline
      const hopRead = await beforeDeadline(
        brain,
        query.deadline,
        readable(
          brain,
          scope,
          { entityId: start.entity.entityId },
          query.within
        )
      );
      if (hopRead === undefined) {
        cuts.add("deadline");
        break;
      }
      considered.push(...hopRead.considered);
      if (hopRead.cut) {
        cuts.add("rows");
      }
      const stepped = steppedFrom(start, hopRead.relations, {
        found,
        seen,
        seedIds,
      });
      reached.push(...stepped.reached);
      next.push(...stepped.next);
    }
    starts = distinct(next);
  }
  if (reached.length > query.maxItems) {
    cuts.add("items");
  }
  const items = await Promise.all(
    reached
      .slice(0, query.maxItems)
      .map(async ({ view, seed, steps }) => await itemOf(view, seed, steps))
  );
  return {
    items,
    cuts: [...cuts],
    provenance:
      considered.length === 0
        ? none.provenance
        : await reported(brain, reader, considered, reached.length),
  };
};
