import { env } from "cloudflare:workers";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { ensureCollection } from "../src/collections.ts";
import { brainErrors } from "../src/contract.ts";
import { brainMentions } from "../src/db/schema.ts";
import { writeVersion } from "../src/documents.ts";
import {
  decideEntityMatch,
  entitiesFor,
  entitiesWithSources,
  entityMatchProposals,
  entitySources,
  linkCoverage,
  linkProposals,
  mentionsPerSource,
  runLinking,
  sameAsFor,
  settleMs,
  sweepLinking,
} from "../src/entities.ts";
import type { IndexStep } from "../src/indexing.ts";
import { purgedMarker } from "../src/knowledge.ts";
import {
  memoriesProposeChange,
  memoriesPublish,
  memoriesRetire,
  remember,
} from "../src/memories.ts";
import { preparePurge, purge } from "../src/purge.ts";
import type { Caller, StartedJob } from "./host.ts";
import { newCollection, noCopies, testHost, writerOf } from "./host.ts";

// Entity linking, through the Brain's own boundaries: a save, a remember,
// and the linking job the host runs, swept by the clock. The model is the
// one outside provider, faked as a gazetteer: it names each entity of its
// list whose name the text holds, as a model would, and answers as told
// for the noisy cases. The ways linking could fail, tried below:
// 1. A change is never linked: a save or a remember with no relationship
//    call leaves nothing to find.
// 2. Identity drifts: a rename gets a new ID, or two people of the same
//    name become one.
// 3. A stale generation wins: a late extractor restores what a newer
//    version replaced, or a removed source's links outlive it.
// 4. A hidden source leaks: its entities shape a reader's counts, labels,
//    suggestions or ambiguity.
// 5. A failed job is lost: nothing runs it again, or its progress can't
//    be seen.
// 6. A match across collections (GRA-1080) is made, shown or counted for
//    a reader who can't read both sides, so a member learns whether a
//    collection hidden from them holds a name (the probe #1203 closed); or
//    two of a name are merged on the name alone; or a decision on one is
//    made without reading both sides or evidence, shows to a reader of one
//    side, rewrites an ID, or outlives an erased entity.

/** An entity as the fake model knows it. */
interface Known {
  kind: string;
  name: string;
  identifiers?: string[];
}

/** A model that names every one of `known` whose name `text` holds. */
const gazetteer =
  (known: readonly Known[]) =>
  async (text: string): Promise<unknown> => {
    await Promise.resolve();
    const lower = text.toLowerCase();
    return {
      entities: known.filter(({ name }) => lower.includes(name.toLowerCase())),
    };
  };

/** How many entity rows and keys the Brain keeps for `entityId`. */
const rowsOf = async (
  entityId: string
): Promise<{ entities: number; keys: number }> => {
  const count = async (table: string, column: string) => {
    const row = await env.BRAIN.prepare(
      `SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`
    )
      .bind(entityId)
      .first<{ n: number }>();
    return row?.n ?? -1;
  };
  return {
    entities: await count("brain_entities", "id"),
    keys: await count("brain_entity_keys", "entity_id"),
  };
};

/** How many entities no mention names, in the whole test database. */
const unnamedEntities = async (): Promise<number> => {
  const row = await env.BRAIN.prepare(
    "SELECT count(*) AS n FROM brain_entities WHERE NOT EXISTS (SELECT 1 FROM brain_mentions WHERE brain_mentions.entity_id = brain_entities.id)"
  ).first<{ n: number }>();
  return row?.n ?? -1;
};

/** Whether `entityId` was made before the fenced commit's test began. */
let fencedStart = 0;
const entitiesMadeBefore = async (entityId: string): Promise<boolean> => {
  const row = await env.BRAIN.prepare(
    "SELECT created_at AS at FROM brain_entities WHERE id = ?"
  )
    .bind(entityId)
    .first<{ at: number }>();
  return row === null || row.at < fencedStart;
};

/** A word no other test's text has. */
const word = () => `w${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

/** An email address no other test uses. */
const email = (name: string) => `${name}.${word()}@example.org`;

/** A step that runs once, as a run without retries would. */
const once: IndexStep = {
  do: async (_name, _config, fn) => await fn(),
};

/** A minute past every source's settling, as the clock would see it. */
const later = () => new Date(Date.now() + settleMs + 60_000);

/**
 * Has the clock sweep, then runs every linking job the sweep started that
 * this test hasn't run yet: what the host's job runner would do.
 */
const settle = async (
  host: ReturnType<typeof testHost>,
  ran: Set<string>,
  at = later()
): Promise<void> => {
  await sweepLinking(host.brain, at);
  const pending = host.started.filter(
    ({ id, job }: StartedJob) => !ran.has(id) && "source" in job
  );
  for (const { id, job } of pending) {
    ran.add(id);
    // oxlint-disable-next-line no-await-in-loop -- one job after another
    await runLinking(host.brain, job, once);
  }
};

/** Saves `text` at `path`, as version `ifVersion + 1`. */
const save = async (
  host: ReturnType<typeof testHost>,
  collection: Awaited<ReturnType<typeof newCollection>>,
  path: string,
  text: string,
  ifVersion = 0
): Promise<Awaited<ReturnType<typeof writeVersion>>> =>
  await writeVersion(host.brain, writerOf("writer"), {
    collection,
    path,
    text,
    ifVersion,
    message: null,
    restoredFrom: null,
  });

/** Runs one document version's linking job directly, as the host would. */
const link = async (
  host: ReturnType<typeof testHost>,
  documentId: string,
  version: number
): Promise<void> => {
  await runLinking(host.brain, { source: `doc:${documentId}`, version }, once);
};

/** The code `promise` was refused with, or "ok". */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return brainErrors.codeOf(error) ?? String(error);
  }
};

/** Text in its order, as `toSorted` takes a comparison. */
const byText = (a: string, b: string) => a.localeCompare(b);

describe("entity linking", () => {
  it("links a saved document's entities without any relationship call", async () => {
    const anna = {
      kind: "person",
      name: "Anna Jansen",
      identifiers: [email("anna")],
    };
    const onboarding = { kind: "Process", name: `Onboarding ${word()}` };
    const host = testHost(gazetteer([anna, onboarding]));
    const collection = await newCollection(host.brain, "Handbook");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    const saved = await save(
      host,
      collection,
      "onboarding.md",
      `# ${onboarding.name}\n${anna.name} (${anna.identifiers[0]}) owns it.`
    );
    const before = await linkCoverage(host.brain, reader);
    await settle(host, new Set());
    const found = await entitiesFor(host.brain, reader);

    expect({
      before,
      after: await linkCoverage(host.brain, reader),
      found: found.map(({ kind, label, sources }) => ({
        kind,
        label,
        sources,
      })),
      sources: await entitySources(host.brain, reader, {
        entityId: found[0]?.id ?? "-",
      }),
    }).toStrictEqual({
      before: { sources: 1, linked: 0, pending: 1, failed: 0, partial: 0 },
      after: { sources: 1, linked: 1, pending: 0, failed: 0, partial: 0 },
      found: [
        { kind: "person", label: "Anna Jansen", sources: 1 },
        { kind: "process", label: onboarding.name, sources: 1 },
      ].toSorted((a, b) => a.label.localeCompare(b.label)),
      sources: [
        {
          kind: "document",
          documentId: saved.id,
          collectionId: collection.id,
          version: 1,
        },
      ],
    });
  });

  it("links a document that names as many entities as a source may hold, each with its identifier", async () => {
    // More than a source keeps: it keeps the first `mentionsPerSource`.
    const people = Array.from({ length: 200 }, (_, index) => ({
      kind: "person",
      name: `Person ${index} ${word()}`,
      identifiers: [email(`p${index}`)],
    }));
    const host = testHost(gazetteer(people));
    const collection = await newCollection(host.brain, "Directory");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    const saved = await save(
      host,
      collection,
      "directory.md",
      people
        .map(({ name, identifiers }) => `${name} (${identifiers[0]})`)
        .join("\n")
    );
    await settle(host, new Set());
    const found = await entitiesFor(host.brain, reader, { limit: 50 });
    // What was kept, row by row: an insert chunk dropped or cut short
    // would leave its people out.
    const kept = await host.brain.db
      .select({
        name: brainMentions.name,
        state: brainMentions.state,
        entityId: brainMentions.entityId,
      })
      .from(brainMentions)
      .where(eq(brainMentions.documentId, saved.id))
      .orderBy(asc(brainMentions.position));

    expect({
      coverage: await linkCoverage(host.brain, reader),
      found: found.length,
      mentions: kept.map(({ name }) => name),
      linked: kept.filter(({ state }) => state === "linked").length,
      entities: new Set(kept.map(({ entityId }) => entityId)).size,
    }).toStrictEqual({
      coverage: { sources: 1, linked: 1, pending: 0, failed: 0, partial: 0 },
      found: 50,
      mentions: people.slice(0, mentionsPerSource).map(({ name }) => name),
      linked: mentionsPerSource,
      entities: mentionsPerSource,
    });
  });

  it("says which collections and documents named the entities it listed, and only those", async () => {
    const anna = { kind: "person", name: `Anna ${word()}` };
    const ben = { kind: "person", name: `Ben ${word()}` };
    const host = testHost(gazetteer([anna, ben]));
    const [handbook, wiki] = await Promise.all([
      newCollection(host.brain, "Handbook"),
      newCollection(host.brain, "Wiki"),
    ]);
    const reader: Caller = { userId: "reader", reads: [handbook.id, wiki.id] };
    const named = await save(
      host,
      handbook,
      "anna.md",
      `${anna.name} owns it.`
    );
    await save(host, wiki, "ben.md", `${ben.name} owns it.`);
    await settle(host, new Set());

    const { entities, sources, truncated } = await entitiesWithSources(
      host.brain,
      reader,
      {
        query: anna.name,
      }
    );

    expect({
      labels: entities.map(({ label }) => label),
      sources,
      truncated,
    }).toStrictEqual({
      labels: [anna.name],
      sources: {
        collections: [handbook.id],
        documents: [
          { documentId: named.id, collectionId: handbook.id, version: 1 },
        ],
      },
      truncated: false,
    });
  });

  it("links remembered statements by their identifier within the person's own memories, never to a collection's", async () => {
    const userId = `person-${word()}`;
    const address = email("anna");
    const anna = {
      kind: "person",
      name: "Anna Jansen",
      identifiers: [address],
    };
    const host = testHost(gazetteer([anna]));
    const collection = await newCollection(host.brain, "Team");
    const reader: Caller = { userId, reads: [collection.id] };
    await save(host, collection, "team.md", `${anna.name}, ${address}`);
    for (const text of [
      `Ask ${anna.name} (${address}) before Fridays.`,
      `${anna.name} (${address}) signs off travel.`,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await remember(
        host.brain,
        reader,
        { kind: "preference", text },
        { idempotencyKey: word() }
      );
    }
    await settle(host, new Set());
    const found = await entitiesFor(host.brain, reader);
    const kinds = await Promise.all(
      found.map(async ({ id }) => {
        const refs = await entitySources(host.brain, reader, { entityId: id });
        return refs.map(({ kind }) => kind);
      })
    );
    const stranger = await entitiesFor(host.brain, {
      userId: "stranger",
      reads: [],
    });

    expect({
      found: found.map(({ label, sources }) => ({ label, sources })),
      kinds,
      stranger,
    }).toStrictEqual({
      found: [
        { label: "Anna Jansen", sources: 2 },
        { label: "Anna Jansen", sources: 1 },
      ],
      kinds: [["memory", "memory"], ["document"]],
      stranger: [],
    });
  });

  it("keeps an entity's ID through a rename that keeps its identifier", async () => {
    const address = email("anna");
    const host = testHost(
      gazetteer([
        { kind: "person", name: "Anna Jansen", identifiers: [address] },
        { kind: "person", name: "Anna de Vries", identifiers: [address] },
      ])
    );
    const collection = await newCollection(host.brain, "People");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    const ran = new Set<string>();
    const first = await save(
      host,
      collection,
      "anna.md",
      `Anna Jansen, ${address}`
    );
    await settle(host, ran);
    const [before] = await entitiesFor(host.brain, reader);
    await save(host, collection, "anna.md", `Anna de Vries, ${address}`, 1);
    await settle(host, ran);
    const [after, ...others] = await entitiesFor(host.brain, reader);

    expect({
      same: before !== undefined && before.id === after?.id,
      label: after?.label,
      names: after?.names,
      others,
      sources: await entitySources(host.brain, reader, {
        entityId: after?.id ?? "-",
      }),
    }).toStrictEqual({
      same: true,
      label: "Anna de Vries",
      names: ["Anna de Vries"],
      others: [],
      sources: [
        {
          kind: "document",
          documentId: first.id,
          collectionId: collection.id,
          version: 2,
        },
      ],
    });
  });

  it("never merges two people of the same name, and keeps a bare mention of either a proposal", async () => {
    const name = `Anna ${word()}`;
    const first = email("anna");
    const second = email("anna");
    const host = testHost(async (text) => {
      await Promise.resolve();
      const identifiers = [first, second].filter((id) => text.includes(id));
      return { entities: [{ kind: "person", name, identifiers }] };
    });
    const collection = await newCollection(host.brain, "People");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    const saved = [
      await save(host, collection, "a.md", `${name} <${first}> runs payroll.`),
      await save(host, collection, "b.md", `${name} <${second}> joined sales.`),
    ];
    const bare = await save(host, collection, "c.md", `${name} will present.`);
    // In the order they were saved: a name is resolved by what its
    // partition knows when it is linked.
    for (const { id } of [...saved, bare]) {
      // oxlint-disable-next-line no-await-in-loop -- in order, on purpose
      await link(host, id, 1);
    }
    const found = await entitiesFor(host.brain, reader, { query: name });
    const proposals = await linkProposals(host.brain, reader);

    expect({
      entities: found.map(({ label, sources }) => ({ label, sources })),
      distinct: new Set(found.map(({ id }) => id)).size,
      proposals: proposals.map(({ sourceRef, name: said, candidates }) => ({
        document: sourceRef.kind === "document" ? sourceRef.documentId : null,
        said,
        candidates: candidates.toSorted(),
      })),
    }).toStrictEqual({
      entities: [
        { label: name, sources: 1 },
        { label: name, sources: 1 },
      ],
      distinct: 2,
      proposals: [
        {
          document: bare.id,
          said: name,
          candidates: found.map(({ id }) => id).toSorted(),
        },
      ],
    });
  });

  it("fences out a late extractor, so it never restores an older version's mentions", async () => {
    const old = `Ben ${word()}`;
    const current = `Cleo ${word()}`;
    const gate = Promise.withResolvers<null>();
    const model = gazetteer([
      { kind: "person", name: old },
      { kind: "person", name: current },
    ]);
    const host = testHost(async (text) => {
      if (text.includes(old)) {
        // The first version's extraction answers only after the second
        // version is linked.
        await gate.promise;
      }
      return await model(text);
    });
    const collection = await newCollection(host.brain, "Owners");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    const saved = await save(host, collection, "owner.md", `${old} owns it.`);
    const late = link(host, saved.id, 1);
    await save(host, collection, "owner.md", `${current} owns it.`, 1);
    await link(host, saved.id, 2);
    gate.resolve(null);
    await late;
    const found = await entitiesFor(host.brain, reader);
    const held = await entitySources(host.brain, reader, {
      entityId: found[0]?.id ?? "-",
    });

    expect({
      labels: found.map(({ label }) => label),
      versions: held.map((ref) =>
        ref.kind === "document" ? ref.version : null
      ),
      coverage: await linkCoverage(host.brain, reader),
    }).toStrictEqual({
      labels: [current],
      versions: [2],
      coverage: { sources: 1, linked: 1, pending: 0, failed: 0, partial: 0 },
    });
  });

  it("drops a source's links as soon as it changes, and with it when it is removed", async () => {
    const userId = `person-${word()}`;
    const address = email("dana");
    const dana = {
      kind: "person",
      name: `Dana ${word()}`,
      identifiers: [address],
    };
    const host = testHost(gazetteer([dana]));
    const collection = await newCollection(host.brain, "Notes");
    const reader: Caller = { userId, reads: [collection.id] };
    const ran = new Set<string>();
    const saved = await save(
      host,
      collection,
      "note.md",
      `${dana.name} (${address}) called.`
    );
    await remember(
      host.brain,
      reader,
      { kind: "fact", text: `${dana.name} prefers email at ${address}.` },
      { idempotencyKey: word() }
    );
    await settle(host, ran);
    const linked = await entitiesFor(host.brain, reader);
    // A new version without the name: its old mentions count no more.
    await save(
      host,
      collection,
      "note.md",
      "Nobody called.",
      saved.currentVersion
    );
    const changed = await entitiesFor(host.brain, reader);
    // The person's memories purged: their mentions go with them.
    const writer = writerOf("admin");
    const input = { type: "personal", userId, reason: "erasure_request" };
    const { token } = await preparePurge(host.brain, writer, input, noCopies);
    await purge(host.brain, writer, input, token, noCopies);
    await settle(host, ran);

    expect({
      linked: linked.map(({ sources }) => sources),
      changed: changed.map(({ sources }) => sources),
      removed: await entitiesFor(host.brain, reader),
      // The note and the memory are two partitions: two entities.
    }).toStrictEqual({ linked: [1, 1], changed: [1], removed: [] });
  });

  it("lets no hidden collection shape a reader's counts, labels, suggestions or ambiguity", async () => {
    const name = `Eva ${word()}`;
    const known = email("eva");
    const other = email("eva");
    const secret = `Project ${word()}`;
    const host = testHost(async (text) => {
      await Promise.resolve();
      const identifiers = [known, other].filter((id) => text.includes(id));
      return {
        entities: [
          { kind: "person", name, identifiers },
          ...(text.includes(secret) ? [{ kind: "project", name: secret }] : []),
        ],
      };
    });
    const open = await newCollection(host.brain, "Open");
    const hidden = await newCollection(host.brain, "Hidden");
    const reader: Caller = { userId: "reader", reads: [open.id] };
    const saved = [
      await save(host, open, "eva.md", `${name}, ${known}.`),
      await save(host, hidden, "eva.md", `${name}, ${known}, on ${secret}.`),
      await save(host, hidden, "eva-2.md", `${name}, ${known}, on ${secret}.`),
      await save(host, hidden, "other.md", `${name}, ${other}, on ${secret}.`),
      await save(host, hidden, "bare.md", `${name} on ${secret}.`),
      await save(host, open, "meeting.md", `${name} chairs the meeting.`),
    ];
    for (const { id } of saved) {
      // oxlint-disable-next-line no-await-in-loop -- in order, on purpose
      await link(host, id, 1);
    }
    const found = await entitiesFor(host.brain, reader);
    const everyone = await entitiesFor(host.brain, {
      userId: "admin",
      reads: [open.id, hidden.id],
    });

    expect({
      found: found.map(({ label, names, sources }) => ({
        label,
        names,
        sources,
      })),
      suggested: await entitiesFor(host.brain, reader, {
        query: secret.slice(0, 9),
      }),
      proposals: await linkProposals(host.brain, reader),
      everyone: everyone.map(({ label, sources }) => ({ label, sources })),
    }).toStrictEqual({
      // The bare mention in Open is Eva by her one name there; the other
      // Eva of the same name, in Hidden, decides nothing in Open.
      found: [{ label: name, names: [name], sources: 2 }],
      suggested: [],
      proposals: [],
      // Her address names her in each collection apart: Open's Eva, and
      // Hidden's two (one ambiguous bare mention there).
      everyone: [
        { label: secret, sources: 4 },
        { label: name, sources: 2 },
        { label: name, sources: 2 },
        { label: name, sources: 1 },
      ],
    });
  });

  it("repairs a failed job: the clock runs it again, and its progress shows", async () => {
    const fay = { kind: "person", name: `Fay ${word()}` };
    let up = false;
    const model = gazetteer([fay]);
    const host = testHost(async (text) => {
      if (!up) {
        throw new Error("The provider is down");
      }
      return await model(text);
    });
    const collection = await newCollection(host.brain, "Desk");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    const ran = new Set<string>();
    await save(host, collection, "desk.md", `${fay.name} sits here.`);
    await settle(host, ran);
    const failed = await linkCoverage(host.brain, reader);
    up = true;
    // Before its backoff has passed, nothing reruns; after it, the next run.
    await settle(host, ran);
    const waiting = await linkCoverage(host.brain, reader);
    await settle(host, ran, new Date(Date.now() + 60 * 60_000));
    const found = await entitiesFor(host.brain, reader);

    expect({
      failed,
      waiting,
      repaired: await linkCoverage(host.brain, reader),
      found: found.map(({ label }) => label),
    }).toStrictEqual({
      failed: { sources: 1, linked: 0, pending: 0, failed: 1, partial: 0 },
      waiting: { sources: 1, linked: 0, pending: 0, failed: 1, partial: 0 },
      repaired: { sources: 1, linked: 1, pending: 0, failed: 0, partial: 0 },
      found: [fay.name],
    });
  });

  it("keeps only what the text bears out: an invented name or identifier links nothing", async () => {
    const real = { kind: "person", name: `Gus ${word()}` };
    const victim = email("victim");
    // An address the text holds only inside a longer one.
    const inside = email("anna");
    const anna = {
      kind: "person",
      name: `Anna ${word()}`,
      identifiers: [inside],
    };
    const host = testHost(async (text) => {
      await Promise.resolve();
      if (text.includes(anna.name)) {
        return { entities: [anna] };
      }
      return {
        entities: [
          // Identifiers the text doesn't hold whole, to merge Gus with
          // someone: one not there at all, one only inside a longer one.
          { ...real, identifiers: [victim, inside] },
          // A name the text holds only inside a longer word.
          { kind: "person", name: real.name.slice(0, -2) },
          { kind: "person", name: `Invented ${word()}` },
        ],
      };
    });
    const collection = await newCollection(host.brain, "Desk");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    const annas = await save(
      host,
      collection,
      "anna.md",
      `${anna.name}, ${inside}.`
    );
    await link(host, annas.id, 1);
    const saved = await save(
      host,
      collection,
      "gus.md",
      `${real.name} is new; write to jo${inside}.`
    );
    await link(host, saved.id, 1);
    const found = await entitiesFor(host.brain, reader);

    expect(
      found
        .map(({ label, sources }) => ({ label, sources }))
        .toSorted((a, b) => a.label.localeCompare(b.label))
    ).toStrictEqual([
      { label: anna.name, sources: 1 },
      { label: real.name, sources: 1 },
    ]);
  });

  it("never links what the host alone writes, as copies of what it keeps elsewhere", async () => {
    const hal = { kind: "person", name: `Hal ${word()}` };
    const host = testHost(gazetteer([hal]));
    const skills = await ensureCollection(
      host.brain,
      {
        id: crypto.randomUUID(),
        name: "Grasp skills",
        description: "",
        owner: "grasp",
        access: "everyone",
        sensitive: false,
        source: "grasp",
        createdAt: new Date(),
      },
      { type: "system" }
    );
    const reader: Caller = { userId: "reader", reads: [skills.id] };
    await writeVersion(host.brain, writerOf("grasp"), {
      collection: skills,
      path: "skill.md",
      text: `# Skill\nAsk ${hal.name}.`,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
      sync: true,
    });
    await settle(host, new Set());

    expect({
      coverage: await linkCoverage(host.brain, reader),
      found: await entitiesFor(host.brain, reader),
    }).toStrictEqual({
      coverage: { sources: 0, linked: 0, pending: 0, failed: 0, partial: 0 },
      found: [],
    });
  });

  it("links a corrected or published memory anew, and drops a retired one's links", async () => {
    const userId = `person-${word()}`;
    const ivo = { kind: "person", name: `Ivo ${word()}` };
    const jan = { kind: "person", name: `Jan ${word()}` };
    const kay = { kind: "person", name: `Kay ${word()}` };
    const host = testHost(gazetteer([ivo, jan, kay]));
    const reader: Caller = { userId, reads: [] };
    const ran = new Set<string>();
    const remembered = await remember(
      host.brain,
      reader,
      { kind: "fact", text: `${ivo.name} approves leave.` },
      { idempotencyKey: word() }
    );
    await settle(host, ran);
    const before = await entitiesFor(host.brain, reader);
    const [first] = remembered.resourceRefs;
    await memoriesProposeChange(
      host.brain,
      reader,
      {
        memoryId: first?.kind === "memory" ? first.memoryId : "",
        statement: `${jan.name} approves leave.`,
      },
      { idempotencyKey: word(), expectedRevision: 1 }
    );
    await settle(host, ran);
    const after = await entitiesFor(host.brain, reader);
    const published = await memoriesPublish(
      host.brain,
      reader,
      {
        scope: "team",
        scopeId: `team-${word()}`,
        kind: "fact",
        text: `${kay.name} runs payroll.`,
      },
      { idempotencyKey: word() }
    );
    await settle(host, ran);
    const shared = await entitiesFor(host.brain, reader);
    const [made] = published.resourceRefs;
    await memoriesRetire(
      host.brain,
      reader,
      { memoryId: made?.kind === "memory" ? made.memoryId : "" },
      { idempotencyKey: word(), expectedRevision: 1 }
    );
    const left = await entitiesFor(host.brain, reader);

    expect({
      before: before.map(({ label }) => label),
      after: after.map(({ label }) => label),
      shared: shared.map(({ label }) => label).toSorted(),
      retired: left.map(({ label }) => label),
    }).toStrictEqual({
      before: [ivo.name],
      after: [jan.name],
      shared: [jan.name, kay.name].toSorted(),
      retired: [jan.name],
    });
  });

  it("never tells a reader whether an identifier is in a source they can't read", async () => {
    const mine = email("probe");
    const secret = email("zed");
    const host = testHost(async (text) => {
      await Promise.resolve();
      const identifiers = [mine, secret].filter((id) => text.includes(id));
      return {
        entities: [
          {
            kind: "person",
            name: text.includes("Zed") ? "Zed" : "Probe",
            identifiers,
          },
        ],
      };
    });
    const hidden = await newCollection(host.brain, "Hidden");
    const own = await newCollection(host.brain, "Own");
    const reader: Caller = { userId: "prober", reads: [own.id] };
    // The probe: an address of their own, then the same with the one they
    // ask about. Matched across collections, the second turns ambiguous
    // when the address is in Hidden, and its proposal says so.
    const saved = [
      await save(host, hidden, "zed.md", `Zed, ${secret}.`),
      await save(host, own, "probe.md", `Probe, ${mine}.`),
      await save(host, own, "probe-2.md", `Probe, ${mine}, ${secret}.`),
    ];
    for (const { id } of saved) {
      // oxlint-disable-next-line no-await-in-loop -- in order, on purpose
      await link(host, id, 1);
    }
    const found = await entitiesFor(host.brain, reader);

    expect({
      proposals: await linkProposals(host.brain, reader),
      found: found.map(({ label, sources }) => ({ label, sources })),
    }).toStrictEqual({
      proposals: [],
      found: [{ label: "Probe", sources: 2 }],
    });
  });

  it("refuses to merge two people a shared identifier names, and keeps the refusal a proposal", async () => {
    const desk = email("desk");
    // A word in common ("de"), but not the same name.
    const anna = "Jan de Vries";
    const bram = "Piet de Boer";
    const host = testHost(async (text) => {
      await Promise.resolve();
      if (text.includes(anna)) {
        return {
          entities: [{ kind: "person", name: anna, identifiers: [desk] }],
        };
      }
      if (text.includes(bram)) {
        return {
          entities: [{ kind: "person", name: bram, identifiers: [desk] }],
        };
      }
      return {
        entities: [{ kind: "team", name: "Front desk", identifiers: [desk] }],
      };
    });
    const collection = await newCollection(host.brain, "Desk");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    const saved = [
      await save(host, collection, "anna.md", `${anna} answers ${desk}.`),
      await save(host, collection, "bram.md", `${bram} answers ${desk} too.`),
      await save(host, collection, "desk.md", `Front desk: ${desk}.`),
    ];
    for (const { id } of saved) {
      // oxlint-disable-next-line no-await-in-loop -- in order, on purpose
      await link(host, id, 1);
    }
    const found = await entitiesFor(host.brain, reader);
    const proposals = await linkProposals(host.brain, reader);

    expect({
      found: found.map(({ label, sources }) => ({ label, sources })),
      proposals: proposals
        .map(({ name, candidates }) => ({ name, candidates }))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    }).toStrictEqual({
      found: [{ label: anna, sources: 1 }],
      // Another name, and another kind.
      proposals: [
        { name: "Front desk", candidates: [found[0]?.id] },
        { name: bram, candidates: [found[0]?.id] },
      ],
    });
  });

  it("erases the entities an erased source alone named, so its identifier never gets its old ID back", async () => {
    const userId = `person-${word()}`;
    const lena = `Lena ${word()}`;
    const address = email("lena");
    const mo = `Mo ${word()}`;
    const moAddress = email("mo");
    const host = testHost(async (text) => {
      await Promise.resolve();
      const identifiers = [address, moAddress].filter((id) =>
        text.includes(id)
      );
      return {
        entities: [
          { kind: "person", name: text.includes(mo) ? mo : lena, identifiers },
        ],
      };
    });
    const collection = await newCollection(host.brain, "People");
    const reader: Caller = { userId, reads: [collection.id] };
    const ran = new Set<string>();
    const saved = await save(
      host,
      collection,
      "lena.md",
      `${lena} (${address}) leads it.`
    );
    await remember(
      host.brain,
      reader,
      { kind: "fact", text: `${mo} (${moAddress}) books rooms.` },
      { idempotencyKey: word() }
    );
    await settle(host, ran);
    const linked = await entitiesFor(host.brain, reader);
    const [lenaBefore, moBefore] = linked
      .toSorted((a, b) => a.label.localeCompare(b.label))
      .map(({ id }) => id);
    // A content purge of her name: its rewrite takes what was linked of
    // the text, and the entity only it named, at once.
    const writer = writerOf("admin");
    const content = {
      type: "content",
      documentIds: [saved.id],
      terms: [lena],
      reason: "erasure_request",
    };
    const prepared = await preparePurge(host.brain, writer, content, noCopies);
    await purge(host.brain, writer, content, prepared.token, noCopies);
    const lenaErased = await rowsOf(lenaBefore ?? "");
    // The person purged: their records' entities go with them.
    const personal = { type: "personal", userId, reason: "erasure_request" };
    const again = await preparePurge(host.brain, writer, personal, noCopies);
    await purge(host.brain, writer, personal, again.token, noCopies);
    const moErased = await rowsOf(moBefore ?? "");
    // Her address mentioned again: a new entity, with a new ID.
    await save(host, collection, "lena-2.md", `${lena} (${address}) is back.`);
    await settle(host, ran);
    const after = await entitiesFor(host.brain, reader);

    expect({
      lenaErased,
      moErased,
      back: after.length,
      sameId: after.some(({ id }) => id === lenaBefore),
    }).toStrictEqual({
      lenaErased: { entities: 0, keys: 0 },
      moErased: { entities: 0, keys: 0 },
      back: 1,
      sameId: false,
    });
  });

  it("leaves nothing of a commit a purge fenced out, so the identifier returns under a new ID", async () => {
    const nia = `Nia ${word()}`;
    const address = email("nia");
    const host = testHost(
      gazetteer([
        { kind: "person", name: nia, identifiers: [address] },
        { kind: "person", name: purgedMarker, identifiers: [address] },
      ])
    );
    const collection = await newCollection(host.brain, "People");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    const saved = await save(
      host,
      collection,
      "nia.md",
      `${nia} (${address}).`
    );
    const writer = writerOf("admin");
    const content = {
      type: "content",
      documentIds: [saved.id],
      terms: [nia],
      reason: "erasure_request",
    };
    const { token } = await preparePurge(host.brain, writer, content, noCopies);
    // The purge lands after the run extracted and resolved, just before
    // its commit's batch: the first key the commit asks for runs it.
    const { keys } = host.brain.ports;
    const real = keys.hmac;
    let purged = false;
    keys.hmac = async (purpose, usages) => {
      if (!purged && purpose === "grasp-os brain entity key") {
        purged = true;
        await purge(host.brain, writer, content, token, noCopies);
      }
      return await real(purpose, usages);
    };
    const unnamedBefore = await unnamedEntities();
    fencedStart = Date.now();
    try {
      await link(host, saved.id, 1);
    } finally {
      keys.hmac = real;
    }
    const unnamedAfter = await unnamedEntities();
    const fenced = await entitiesFor(host.brain, reader);
    // The purged version's own run: the address alone is left.
    await link(host, saved.id, 2);
    const after = await entitiesFor(host.brain, reader);
    const createdBefore = await entitiesMadeBefore(after[0]?.id ?? "");

    expect({
      purged,
      leftBehind: unnamedAfter - unnamedBefore,
      fenced,
      back: after.length,
      madeBeforeThePurge: createdBefore,
    }).toStrictEqual({
      purged: true,
      leftBehind: 0,
      fenced: [],
      back: 1,
      madeBeforeThePurge: false,
    });
  });

  it("proposes entities of one kind and name in two collections to a reader of both, never merging them, and to no one else", async () => {
    const concept = `Onboarding ${word()}`;
    const person = `Eva ${word()}`;
    const host = testHost(async (text) => {
      await Promise.resolve();
      return {
        entities: [
          ...(text.includes(concept)
            ? [{ kind: "concept", name: concept }]
            : []),
          ...(text.includes(person) ? [{ kind: "person", name: person }] : []),
          // The same name as another kind: never the same thing.
          ...(text.includes("as a team")
            ? [{ kind: "team", name: concept }]
            : []),
        ],
      };
    });
    const sales = await newCollection(host.brain, "Sales");
    const support = await newCollection(host.brain, "Support");
    const saved = [
      await save(host, sales, "a.md", `${concept} with ${person}.`),
      await save(host, support, "b.md", `${concept} with ${person}.`),
      await save(host, support, "c.md", `${concept} as a team.`),
    ];
    for (const { id } of saved) {
      // oxlint-disable-next-line no-await-in-loop -- in order, on purpose
      await link(host, id, 1);
    }
    const both: Caller = { userId: "admin", reads: [sales.id, support.id] };
    const proposals = await entityMatchProposals(host.brain, both);
    const linked = await entitiesFor(host.brain, both, { query: person });

    expect({
      proposals: proposals.map(({ kind, name, basis, entities }) => ({
        kind,
        name,
        basis,
        sides: entities
          .flatMap(({ collectionIds }) => collectionIds)
          .toSorted(byText),
      })),
      salesOnly: await entityMatchProposals(host.brain, {
        userId: "member",
        reads: [sales.id],
      }),
      // Proposed, never merged: still two of her.
      people: linked.length,
    }).toStrictEqual({
      proposals: [
        {
          kind: "concept",
          name: concept,
          basis: "name",
          sides: [sales.id, support.id].toSorted(byText),
        },
        {
          kind: "person",
          name: person,
          basis: "name",
          sides: [sales.id, support.id].toSorted(byText),
        },
      ].toSorted((a, b) => a.name.localeCompare(b.name)),
      salesOnly: [],
      people: 2,
    });
  });

  it("never lets a member learn whether a collection they can't read holds a name they know", async () => {
    const name = `Zed ${word()}`;
    const host = testHost(gazetteer([{ kind: "person", name }]));
    const own = await newCollection(host.brain, "Own");
    const hidden = await newCollection(host.brain, "Hidden");
    const member: Caller = { userId: "prober", reads: [own.id] };
    const seen = async () => ({
      proposals: await entityMatchProposals(host.brain, member),
      entities: await entitiesFor(host.brain, member),
      suggested: await entitiesFor(host.brain, member, { query: name }),
    });
    const mine = await save(host, own, "zed.md", `${name} joined.`);
    await link(host, mine.id, 1);
    const before = await seen();
    // The collection hidden from them gains the name they asked about.
    const theirs = await save(host, hidden, "zed.md", `${name} left.`);
    await link(host, theirs.id, 1);
    const after = await seen();
    const admin = await entityMatchProposals(host.brain, {
      userId: "admin",
      reads: [own.id, hidden.id],
    });

    expect({
      same: after,
      before: before.proposals,
      admin: admin.map(({ name: proposed, entities }) => ({
        name: proposed,
        sides: entities.length,
      })),
    }).toStrictEqual({
      same: before,
      before: [],
      admin: [{ name, sides: 2 }],
    });
  });

  it("decides a match only for a person who reads both sides, `same` only with evidence they read, audited, and shows it only to readers of both", async () => {
    const person = `Ada ${word()}`;
    const concept = `Payroll ${word()}`;
    // A second person only Sales names.
    const colleague = `Cy ${word()}`;
    const host = testHost(
      gazetteer([
        { kind: "person", name: person },
        { kind: "concept", name: concept },
        { kind: "person", name: colleague },
      ])
    );
    const sales = await newCollection(host.brain, "Sales");
    const support = await newCollection(host.brain, "Support");
    const saved = [
      await save(host, sales, "a.md", `${person} runs ${concept}.`),
      await save(host, support, "b.md", `${person} asks about ${concept}.`),
      await save(
        host,
        sales,
        "hr.md",
        "HR confirms both notes are about one person."
      ),
      await save(host, sales, "d.md", `${colleague} joined.`),
    ];
    for (const { id } of saved) {
      // oxlint-disable-next-line no-await-in-loop -- in order, on purpose
      await link(host, id, 1);
    }
    const admin: Caller = { userId: "admin", reads: [sales.id, support.id] };
    const member: Caller = { userId: "member", reads: [sales.id] };
    const proposals = await entityMatchProposals(host.brain, admin);
    const pairOf = (kind: string): [string, string] => {
      const ids = proposals
        .find((proposal) => proposal.kind === kind)
        ?.entities.map(({ id }) => id);
      return [ids?.[0] ?? "", ids?.[1] ?? ""];
    };
    const people = pairOf("person");
    const concepts = pairOf("concept");
    const salesPerson =
      proposals
        .find((proposal) => proposal.kind === "person")
        ?.entities.find(({ collectionIds }) => collectionIds.includes(sales.id))
        ?.id ?? "";
    const [onlySales] = await entitiesFor(host.brain, admin, {
      query: colleague,
    });
    const evidence = { documentId: saved[2]?.id ?? "", version: 1 };
    const decide = async (caller: Caller, input: unknown) =>
      await outcome(decideEntityMatch(host.brain, caller, input));
    const refused = {
      // They read one side: the other isn't there, as for an ID that's no entity.
      byMember: await decide(member, {
        entities: people,
        decision: "same",
        evidence,
      }),
      noSuchEntity: await decide(admin, {
        entities: [people[0], "nobody"],
        decision: "different",
      }),
      // A name alone never makes two people one.
      noEvidence: await decide(admin, { entities: people, decision: "same" }),
      // Two entities only one collection links: no match across collections.
      sameCollection: await decide(admin, {
        entities: [salesPerson, onlySales?.id ?? ""],
        decision: "different",
      }),
    };
    const accepted = await decideEntityMatch(host.brain, admin, {
      entities: people,
      decision: "same",
      evidence,
    });
    await decideEntityMatch(host.brain, admin, {
      entities: concepts,
      decision: "different",
    });
    const named = await entitiesFor(host.brain, admin, { query: person });
    const audited = host.events.filter(
      ({ action }) => action === "brain.entity_match.decided"
    );

    expect({
      refused,
      accepted: accepted.decision,
      left: await entityMatchProposals(host.brain, admin),
      sameForAdmin: await sameAsFor(host.brain, admin, people[0]),
      sameForMember: await sameAsFor(host.brain, member, people[0]),
      differentIsNotSame: await sameAsFor(host.brain, admin, concepts[0]),
      // Never rewritten: still two of her, by their own IDs.
      ids: named.map(({ id }) => id).toSorted(byText),
      audited: audited.map(({ detail }) => detail?.decision),
    }).toStrictEqual({
      refused: {
        byMember: "brain.not_found",
        noSuchEntity: "brain.not_found",
        noEvidence: "brain.invalid",
        sameCollection: "brain.invalid",
      },
      accepted: "same",
      left: [],
      sameForAdmin: [people[1]],
      sameForMember: [],
      differentIsNotSame: [],
      ids: [...people].toSorted(byText),
      audited: ["same", "different"],
    });
  });

  it("shows every counterpart decided the same, however many there are", async () => {
    const hub = `Hub ${word()}`;
    const many = Array.from({ length: 45 }, (_, i) => `Pat${i} ${word()}`);
    const host = testHost(
      gazetteer(
        [hub, ...many].map((name) => ({ kind: "person", name }) as const)
      )
    );
    const sales = await newCollection(host.brain, "Sales");
    const support = await newCollection(host.brain, "Support");
    const proof = await save(host, sales, "proof.md", "All the same caller.");
    const saved = [proof, await save(host, sales, "hub.md", `${hub} called.`)];
    for (const [i, name] of many.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- in order, on purpose
      saved.push(await save(host, support, `p${i}.md`, `${name} called.`));
    }
    for (const { id } of saved) {
      // oxlint-disable-next-line no-await-in-loop -- in order, on purpose
      await link(host, id, 1);
    }
    const admin: Caller = { userId: "admin", reads: [sales.id, support.id] };
    const [hubEntity] = await entitiesFor(host.brain, admin, { query: hub });
    const everyone = await entitiesFor(host.brain, admin, { limit: 100 });
    const others = everyone
      .filter(({ id }) => id !== hubEntity?.id)
      .map(({ id }) => id);
    for (const other of others) {
      // oxlint-disable-next-line no-await-in-loop -- in order, on purpose
      await decideEntityMatch(host.brain, admin, {
        entities: [hubEntity?.id ?? "", other],
        decision: "same",
        evidence: { documentId: proof.id, version: 1 },
      });
    }

    expect({
      decided: others.length,
      same: await sameAsFor(host.brain, admin, hubEntity?.id ?? ""),
    }).toStrictEqual({ decided: many.length, same: others.toSorted() });
  });

  it("honours a `same` only for a reader of its evidence, and lets only its decider or an admin replace a decision, audited", async () => {
    const person = `Ida ${word()}`;
    const host = testHost(gazetteer([{ kind: "person", name: person }]));
    const sales = await newCollection(host.brain, "Sales");
    const support = await newCollection(host.brain, "Support");
    const hr = await newCollection(host.brain, "HR");
    const saved = [
      await save(host, sales, "a.md", `${person} called.`),
      await save(host, support, "b.md", `${person} called back.`),
      await save(host, hr, "proof.md", "Both calls were from one person."),
    ];
    for (const { id } of saved) {
      // oxlint-disable-next-line no-await-in-loop -- in order, on purpose
      await link(host, id, 1);
    }
    const decider: Caller = {
      userId: "hr-lead",
      reads: [sales.id, support.id, hr.id],
    };
    // Reads both people, but not the HR note that says they are one.
    const broad: Caller = { userId: "broad", reads: [sales.id, support.id] };
    const admin: Caller = {
      userId: "boss",
      reads: [sales.id, support.id, hr.id],
      admin: true,
    };
    const [proposal] = await entityMatchProposals(host.brain, decider);
    const [a = "", b = ""] = proposal?.entities.map(({ id }) => id) ?? [];
    const evidence = { documentId: saved[2]?.id ?? "", version: 1 };
    await decideEntityMatch(host.brain, decider, {
      entities: [a, b],
      decision: "same",
      evidence,
    });
    const broadProposals = await entityMatchProposals(host.brain, broad);
    const seen = {
      byDecider: await sameAsFor(host.brain, decider, a),
      byBroad: await sameAsFor(host.brain, broad, a),
      // Still an open question to them: nothing they read decides it.
      broadProposals: broadProposals.length,
    };
    const byBroad = await outcome(
      decideEntityMatch(host.brain, broad, {
        entities: [a, b],
        decision: "different",
      })
    );
    const ownChange = await decideEntityMatch(host.brain, decider, {
      entities: [a, b],
      decision: "different",
    });
    const byAdmin = await decideEntityMatch(host.brain, admin, {
      entities: [a, b],
      decision: "same",
      evidence,
    });
    const audited = host.events
      .filter(({ action }) => action === "brain.entity_match.decided")
      .map(({ detail }) => ({
        decision: detail?.decision,
        replaced: detail?.replaced,
        previousDecider: detail?.previousDecider,
      }));

    expect({
      seen,
      byBroad,
      ownChange: ownChange.decision,
      byAdmin: byAdmin.decision,
      audited,
    }).toStrictEqual({
      seen: { byDecider: [b], byBroad: [], broadProposals: 1 },
      byBroad: "brain.denied",
      ownChange: "different",
      byAdmin: "same",
      audited: [
        { decision: "same", replaced: null, previousDecider: null },
        { decision: "different", replaced: "same", previousDecider: null },
        {
          decision: "same",
          replaced: "different",
          previousDecider: "hr-lead",
        },
      ],
    });
  });

  it("drops a decision with an entity an erasure removes, so none outlives it", async () => {
    const person = `Bo ${word()}`;
    const host = testHost(gazetteer([{ kind: "person", name: person }]));
    const sales = await newCollection(host.brain, "Sales");
    const support = await newCollection(host.brain, "Support");
    const first = await save(host, sales, "a.md", `${person} called.`);
    const second = await save(host, support, "b.md", `${person} called back.`);
    const proof = await save(host, sales, "proof.md", "The same caller.");
    for (const { id } of [first, second, proof]) {
      // oxlint-disable-next-line no-await-in-loop -- in order, on purpose
      await link(host, id, 1);
    }
    const admin: Caller = { userId: "admin", reads: [sales.id, support.id] };
    const [proposal] = await entityMatchProposals(host.brain, admin);
    const [a = "", b = ""] = proposal?.entities.map(({ id }) => id) ?? [];
    await decideEntityMatch(host.brain, admin, {
      entities: [a, b],
      decision: "same",
      evidence: { documentId: proof.id, version: 1 },
    });
    const count = async () => {
      const row = await env.BRAIN.prepare(
        "SELECT count(*) AS n FROM brain_entity_matches WHERE entity_a IN (?, ?) OR entity_b IN (?, ?)"
      )
        .bind(a, b, a, b)
        .first<{ n: number }>();
      return row?.n ?? -1;
    };
    const before = await count();
    const writer = writerOf("admin");
    const content = {
      type: "content",
      documentIds: [first.id],
      terms: [person],
      reason: "erasure_request",
    };
    const prepared = await preparePurge(host.brain, writer, content, noCopies);
    await purge(host.brain, writer, content, prepared.token, noCopies);

    expect({ before, after: await count() }).toStrictEqual({
      before: 1,
      after: 0,
    });
  });

  /** Ada in Sales and in Support, linked; their match's two entity IDs. */
  const adaTwice = async () => {
    const person = `Ada ${word()}`;
    const host = testHost(gazetteer([{ kind: "person", name: person }]));
    const sales = await newCollection(host.brain, "Sales");
    const support = await newCollection(host.brain, "Support");
    const saved = [
      await save(host, sales, "a.md", `${person} called.`),
      await save(host, support, "b.md", `${person} called back.`),
      await save(host, sales, "proof.md", "Both calls were from one person."),
    ];
    for (const { id } of saved) {
      // oxlint-disable-next-line no-await-in-loop -- in order, on purpose
      await link(host, id, 1);
    }
    const admin: Caller = { userId: "admin", reads: [sales.id, support.id] };
    const [proposal] = await entityMatchProposals(host.brain, admin);
    const ids = proposal?.entities.map(({ id }) => id) ?? [];
    const pair: [string, string] = [ids[0] ?? "", ids[1] ?? ""];
    return { host, admin, pair, sales, proof: saved[2]?.id ?? "" };
  };

  it("refuses a replacement made from a decision replaced meanwhile, by the same person too", async () => {
    const { host, admin, pair, proof } = await adaTwice();
    await decideEntityMatch(host.brain, admin, {
      entities: pair,
      decision: "different",
    });
    let meanwhile = false;
    // The same person's other request lands between this one's read and write.
    const racing = {
      ...host.brain,
      db: new Proxy(host.brain.db, {
        get: (target, property): unknown => {
          const value: unknown = Reflect.get(target, property);
          if (property === "batch" && typeof value === "function") {
            return async (...args: unknown[]): Promise<unknown> => {
              if (!meanwhile) {
                meanwhile = true;
                await decideEntityMatch(host.brain, admin, {
                  entities: pair,
                  decision: "same",
                  evidence: { documentId: proof, version: 1 },
                });
              }
              return await Reflect.apply(value, target, args);
            };
          }
          return typeof value === "function"
            ? (...args: unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        },
      }),
    };
    const late = await outcome(
      decideEntityMatch(racing, admin, {
        entities: pair,
        decision: "different",
      })
    );

    expect({
      late,
      same: await sameAsFor(host.brain, admin, pair[0]),
    }).toStrictEqual({
      late: "brain.revision_conflict",
      // The decision made meanwhile stands.
      same: [pair[1]],
    });
  });

  it("forgets a `same` whose evidence a purge rewrites, though both entities stay", async () => {
    const { host, admin, pair, proof } = await adaTwice();
    await decideEntityMatch(host.brain, admin, {
      entities: pair,
      decision: "same",
      evidence: { documentId: proof, version: 1 },
    });
    const before = await sameAsFor(host.brain, admin, pair[0]);
    const writer = writerOf("admin");
    // Only the evidence's words go: both people stay mentioned elsewhere.
    const content = {
      type: "content",
      documentIds: [proof],
      terms: ["calls"],
      reason: "erasure_request",
    };
    const prepared = await preparePurge(host.brain, writer, content, noCopies);
    await purge(host.brain, writer, content, prepared.token, noCopies);

    const proposals = await entityMatchProposals(host.brain, admin);

    expect({
      before,
      after: await sameAsFor(host.brain, admin, pair[0]),
      // An open question again.
      proposals: proposals.length,
    }).toStrictEqual({ before: [pair[1]], after: [], proposals: 1 });
  });

  it("decides a pair though one side has more readable mentions than one read takes", async () => {
    const { host, admin, pair } = await adaTwice();
    // Thousands of newer mentions of one side, as many sources would give.
    await env.BRAIN.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
       INSERT INTO brain_mentions SELECT m.source, m.position + 1000 + n.i, m.document_id, m.memory_id, m.version, m.partition, m.kind, m.name, m.alias, m.entity_id, m.state, m.resolution, m.candidates
       FROM n, (SELECT * FROM brain_mentions WHERE entity_id = ? LIMIT 1) AS m`
    )
      .bind(pair[0])
      .run();
    const decided = await outcome(
      decideEntityMatch(host.brain, admin, {
        entities: pair,
        decision: "different",
      })
    );

    expect(decided).toBe("ok");
  });

  it("closes a proposal once every pair across collections is decided, a pair only one collection links aside", async () => {
    const name = `Ana ${word()}`;
    const first = email("ana");
    const second = email("ana");
    const host = testHost(async (text) => {
      await Promise.resolve();
      const identifiers = [first, second].filter((id) => text.includes(id));
      return { entities: [{ kind: "person", name, identifiers }] };
    });
    const sales = await newCollection(host.brain, "Sales");
    const support = await newCollection(host.brain, "Support");
    // Two people of one name in Sales, one in Support.
    const saved = [
      await save(host, sales, "a.md", `${name} <${first}> runs payroll.`),
      await save(host, sales, "b.md", `${name} <${second}> joined.`),
      await save(host, support, "c.md", `${name} called.`),
    ];
    for (const { id } of saved) {
      // oxlint-disable-next-line no-await-in-loop -- in order, on purpose
      await link(host, id, 1);
    }
    const admin: Caller = { userId: "admin", reads: [sales.id, support.id] };
    const [proposal] = await entityMatchProposals(host.brain, admin);
    const inSupport =
      proposal?.entities.find(({ collectionIds }) =>
        collectionIds.includes(support.id)
      )?.id ?? "";
    const inSales = (proposal?.entities ?? [])
      .filter(({ id }) => id !== inSupport)
      .map(({ id }) => id);
    for (const id of inSales) {
      // oxlint-disable-next-line no-await-in-loop -- one pair at a time
      await decideEntityMatch(host.brain, admin, {
        entities: [id, inSupport],
        decision: "different",
      });
    }

    expect({
      salesPeople: inSales.length,
      left: await entityMatchProposals(host.brain, admin),
    }).toStrictEqual({ salesPeople: 2, left: [] });
  });
});
