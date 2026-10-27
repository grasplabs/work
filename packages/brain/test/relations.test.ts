import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { brainErrors } from "../src/contract.ts";
import { writeVersion } from "../src/documents.ts";
import {
  entitiesFor,
  entitySources,
  runLinking,
  settleMs,
  sweepLinking,
} from "../src/entities.ts";
import type { IndexStep } from "../src/indexing.ts";
import { remember } from "../src/memories.ts";
import { preparePurge, purge } from "../src/purge.ts";
import { relationsExplain, relationsFor } from "../src/relations.ts";
import type { Caller, StartedJob } from "./host.ts";
import { newCollection, noCopies, testHost, writerOf } from "./host.ts";

// Typed, source-backed relations (GRA-306, its threat model), through the
// Brain's own boundaries: a save, the linking job, and the read. The model
// is the one outside provider, faked: it names the entities and relations
// each text was written with, and invents some for the noisy cases. The
// ways it could fail, tried here:
// 1. A present or past question gets the wrong answer, or one without the
//    passage that says it.
// 2. A correction rewrites what was known before it.
// 3. Two sources that disagree are folded into one answer.
// 4. A hidden source changes a visible answer.
// 5. An invented relation, quote or date is kept.
// 6. An erasure leaves a relation's quote behind, in history too.

/** A word no other test's text has. */
const word = () => `w${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;

/** What `promise` came to: "ok", or the Brain's code it was refused with. */
const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return brainErrors.codeOf(error) ?? String(error);
  }
};

/** A step that runs once, as a run without retries would. */
const once: IndexStep = { do: async (_name, _config, fn) => await fn() };

/** What the fake model answers for a text holding a key of `answers`. */
type Answers = Record<
  string,
  {
    entities: { kind: string; name: string }[];
    relations?: {
      subject: string;
      predicate: string;
      object: string;
      validFrom?: string | null;
      validTo?: string | null;
      evidence: string;
    }[];
  }
>;

/** A model that answers each text by the marker it holds. */
const modelOf =
  (answers: Answers) =>
  async (text: string): Promise<unknown> => {
    await Promise.resolve();
    const found = Object.entries(answers).find(([marker]) =>
      text.includes(marker)
    );
    return found?.[1] ?? { entities: [] };
  };

/** Saves `text` and links it, as version `ifVersion + 1`. */
const savedAndLinked = async (
  host: ReturnType<typeof testHost>,
  collection: Awaited<ReturnType<typeof newCollection>>,
  path: string,
  text: string,
  ifVersion = 0
) => {
  const saved = await writeVersion(host.brain, writerOf("writer"), {
    collection,
    path,
    text,
    ifVersion,
    message: null,
    restoredFrom: null,
  });
  await runLinking(
    host.brain,
    { source: `doc:${saved.id}`, version: saved.currentVersion },
    once
  );
  return saved;
};

/** The ID of the entity `reader` sees under `name`. */
const entityOf = async (
  host: ReturnType<typeof testHost>,
  reader: Caller,
  name: string
): Promise<string> => {
  const [found] = await entitiesFor(host.brain, reader, { query: name });
  return found?.id ?? "";
};

/** Who `entityId` is related to by `owns`, as `reader` asks. */
const owners = async (
  host: ReturnType<typeof testHost>,
  reader: Caller,
  entityId: string,
  asked: { at?: string; knownAt?: string } = {}
) => {
  const found = await relationsFor(host.brain, reader, {
    entityId,
    predicate: "owns",
    ...asked,
  });
  return found.map(({ subject, conflicting, evidence, sourceRef }) => ({
    owner: subject.name,
    conflicting,
    evidence,
    version: sourceRef.kind === "document" ? sourceRef.version : null,
  }));
};

describe("typed relations", () => {
  it("answer who owns something now and on a past date, each with the passage that says so", async () => {
    const thing = `Onboarding ${word()}`;
    const first = `Ben owns ${thing} until 2026-09-30.`;
    const handover = `Anna owns ${thing} from 2026-10-01.`;
    const host = testHost(
      modelOf({
        [handover]: {
          entities: [
            { kind: "person", name: "Ben" },
            { kind: "person", name: "Anna" },
            { kind: "thing", name: thing },
          ],
          relations: [
            {
              subject: "Ben",
              predicate: "owns",
              object: thing,
              validTo: "2026-09-30",
              evidence: first,
            },
            {
              subject: "Anna",
              predicate: "owns",
              object: thing,
              validFrom: "2026-10-01",
              evidence: handover,
            },
          ],
        },
      })
    );
    const collection = await newCollection(host.brain, "Operations");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    await savedAndLinked(
      host,
      collection,
      "decision.md",
      `${first}\n${handover}`
    );
    const onboarding = await entityOf(host, reader, thing);

    expect({
      now: await owners(host, reader, onboarding, { at: "2026-10-06" }),
      past: await owners(host, reader, onboarding, { at: "2026-09-25" }),
    }).toStrictEqual({
      now: [
        { owner: "Anna", conflicting: false, evidence: handover, version: 1 },
      ],
      past: [{ owner: "Ben", conflicting: false, evidence: first, version: 1 }],
    });
  });

  it("keep every relation of a source that states as many as it may hold", async () => {
    const thing = `Directory ${word()}`;
    const people = Array.from({ length: 50 }, (_, index) => `Person ${index}`);
    const lines = people.map((name) => `${name} owns ${thing}.`);
    const host = testHost(
      modelOf({
        [thing]: {
          entities: [
            ...people.map((name) => ({ kind: "person", name })),
            { kind: "thing", name: thing },
          ],
          relations: people.map((name, index) => ({
            subject: name,
            predicate: "owns",
            object: thing,
            evidence: lines[index] ?? "",
          })),
        },
      })
    );
    const collection = await newCollection(host.brain, "Directory");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    await savedAndLinked(host, collection, "owners.md", lines.join("\n"));
    const owned = await owners(
      host,
      reader,
      await entityOf(host, reader, thing)
    );

    expect(owned.map(({ owner }) => owner).toSorted()).toStrictEqual(
      people.toSorted()
    );
  });

  it("keep what was known before a correction, which supersedes it without rewriting it", async () => {
    const thing = `Payroll ${word()}`;
    const wrong = `Ben owns ${thing}.`;
    const right = `Anna owns ${thing}.`;
    const answer = (owner: string, evidence: string) => ({
      entities: [
        { kind: "person", name: owner },
        { kind: "thing", name: thing },
      ],
      relations: [
        { subject: owner, predicate: "owns", object: thing, evidence },
      ],
    });
    const host = testHost(
      modelOf({ [wrong]: answer("Ben", wrong), [right]: answer("Anna", right) })
    );
    const collection = await newCollection(host.brain, "Finance");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    await savedAndLinked(host, collection, "payroll.md", wrong);
    await scheduler.wait(5);
    const before = new Date().toISOString();
    await scheduler.wait(5);
    await savedAndLinked(host, collection, "payroll.md", right, 1);
    const payroll = await entityOf(host, reader, thing);

    expect({
      now: await owners(host, reader, payroll),
      knownBefore: await owners(host, reader, payroll, { knownAt: before }),
    }).toStrictEqual({
      now: [{ owner: "Anna", conflicting: false, evidence: right, version: 2 }],
      knownBefore: [
        { owner: "Ben", conflicting: false, evidence: wrong, version: 1 },
      ],
    });
  });

  it("return two sources that disagree side by side, never one picked, and let no hidden source change that", async () => {
    const thing = `Invoicing ${word()}`;
    const says = (owner: string) => `${owner} owns ${thing}.`;
    const answer = (owner: string) => ({
      entities: [
        { kind: "person", name: owner },
        { kind: "thing", name: thing },
      ],
      relations: [
        {
          subject: owner,
          predicate: "owns",
          object: thing,
          evidence: says(owner),
        },
      ],
    });
    const host = testHost(
      modelOf({
        [says("Anna")]: answer("Anna"),
        [says("Bram")]: answer("Bram"),
        [says("Cleo")]: answer("Cleo"),
      })
    );
    const team = await newCollection(host.brain, "Team");
    await savedAndLinked(host, team, "policy.md", says("Anna"));
    await savedAndLinked(host, team, "memo.md", says("Bram"));
    await savedAndLinked(host, team, "note.md", says("Cleo"));
    // A reader of the collection's policy alone (a per-path audience, as
    // the host's `authorize` may give): the memo and the note are hidden
    // from them, though in the same collection, about the same entity.
    const lead: Caller = {
      userId: "lead",
      reads: [team.id],
      only: { [team.id]: ["policy.md", "memo.md"] },
    };
    const reader: Caller = {
      userId: "reader",
      reads: [team.id],
      only: { [team.id]: ["policy.md"] },
    };
    const invoicing = await entityOf(host, lead, thing);
    const leadOwners = await owners(host, lead, invoicing);
    const readerOwners = await owners(host, reader, invoicing);

    expect({
      lead: leadOwners
        .map(({ owner, conflicting }) => `${owner} ${conflicting}`)
        .toSorted((a, b) => a.localeCompare(b)),
      // Bram's and Cleo's claims are in documents the reader can't read:
      // Anna's stands alone for them, not in conflict.
      reader: readerOwners.map(
        ({ owner, conflicting }) => `${owner} ${conflicting}`
      ),
    }).toStrictEqual({
      lead: ["Anna true", "Bram true"],
      reader: ["Anna false"],
    });
  });

  it("keep no relation the text doesn't bear out: an invented quote, end or date", async () => {
    const thing = `Hiring ${word()}`;
    const text = `Dana leads ${thing}.`;
    const host = testHost(
      modelOf({
        [text]: {
          entities: [
            { kind: "person", name: "Dana" },
            { kind: "thing", name: thing },
          ],
          relations: [
            // A quote the text doesn't hold.
            {
              subject: "Dana",
              predicate: "owns",
              object: thing,
              evidence: `Dana owns ${thing}.`,
            },
            // An end that isn't one of its entities.
            {
              subject: "Eve",
              predicate: "leads",
              object: thing,
              evidence: text,
            },
            // A month that doesn't exist, which must not stop the rest.
            {
              subject: "Dana",
              predicate: "leads",
              object: thing,
              validTo: "2026-13-01",
              evidence: text,
            },
            // A date that isn't one.
            {
              subject: "Dana",
              predicate: "leads",
              object: thing,
              validFrom: "2026-02-30",
              evidence: text,
            },
            // Bears out: kept.
            {
              subject: "Dana",
              predicate: "Leads",
              object: thing,
              evidence: text,
            },
          ],
        },
      })
    );
    const collection = await newCollection(host.brain, "People");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    await savedAndLinked(host, collection, "hiring.md", text);
    const found = await relationsFor(host.brain, reader, {
      entityId: await entityOf(host, reader, thing),
    });

    expect(
      found.map(({ subject, predicate, validFrom }) => [
        subject.name,
        predicate,
        validFrom,
      ])
    ).toStrictEqual([["Dana", "leads", null]]);
  });

  it("erase every relation a purged source stated, superseded ones included", async () => {
    const name = `Finn ${word()}`;
    const thing = `Expenses ${word()}`;
    const said = (version: number) =>
      `${name} owns ${thing}, version ${version}.`;
    const answer = (version: number) => ({
      entities: [
        { kind: "person", name },
        { kind: "thing", name: thing },
      ],
      relations: [
        {
          subject: name,
          predicate: "owns",
          object: thing,
          evidence: said(version),
        },
      ],
    });
    const host = testHost(
      modelOf({ [said(1)]: answer(1), [said(2)]: answer(2) })
    );
    const collection = await newCollection(host.brain, "Finance");
    const saved = await savedAndLinked(
      host,
      collection,
      "expenses.md",
      said(1)
    );
    await savedAndLinked(host, collection, "expenses.md", said(2), 1);
    const kept = async () => {
      const row = await env.BRAIN.prepare(
        "SELECT count(*) AS n FROM brain_assertions WHERE source = ?"
      )
        .bind(`doc:${saved.id}`)
        .first<{ n: number }>();
      return row?.n ?? -1;
    };
    const before = await kept();
    const writer = writerOf("admin");
    const input = {
      type: "content",
      documentIds: [saved.id],
      terms: [name],
      reason: "erasure_request",
    };
    const { token } = await preparePurge(host.brain, writer, input, noCopies);
    await purge(host.brain, writer, input, token, noCopies);

    expect({ before, after: await kept() }).toStrictEqual({
      before: 2,
      after: 0,
    });
  });

  it("quote the source's own words, byte for byte, whatever case or spacing the extractor's copy has", async () => {
    const thing = `Onboarding ${word()}`;
    const said = `Anna   Jansen owns ${thing} from 2026-10-01.`;
    const host = testHost(
      modelOf({
        [thing]: {
          entities: [
            { kind: "person", name: "Anna Jansen" },
            { kind: "process", name: thing },
          ],
          relations: [
            {
              subject: "Anna Jansen",
              predicate: "owns",
              object: thing,
              validFrom: "2026-10-01",
              // Its own copy: other case, other spacing.
              evidence: ` anna jansen OWNS ${thing.toUpperCase()} from 2026-10-01. `,
            },
          ],
        },
      })
    );
    const collection = await newCollection(host.brain, "Operations");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    await savedAndLinked(host, collection, "owner.md", `# Owner\n${said}\n`);
    const [found] = await relationsFor(host.brain, reader, {
      entityId: await entityOf(host, reader, thing),
    });

    expect(found?.evidence).toBe(said);
  });

  it("refuse a caller the host doesn't let read the Brain, and list no caller that isn't a person every name", async () => {
    const host = testHost();
    const collection = await newCollection(host.brain, "Desk");
    const reader: Caller = { userId: "reader", reads: [collection.id] };
    const { recall } = host.brain.ports;
    const refused = {
      ...host,
      brain: {
        ...host.brain,
        ports: {
          ...host.brain.ports,
          recall: {
            ...recall,
            require: async () => {
              await Promise.resolve();
              throw new Error("no brain grant");
            },
            isRefusal: () => true,
          },
        },
      },
    };
    const agent = {
      ...host,
      brain: {
        ...host.brain,
        ports: {
          ...host.brain.ports,
          ownerOf: (): string => {
            throw brainErrors.create("brain.denied");
          },
        },
      },
    };
    const id = crypto.randomUUID();

    expect({
      relations: await code(
        relationsFor(refused.brain, reader, { entityId: id })
      ),
      entities: await code(entitiesFor(refused.brain, reader, { query: "An" })),
      sources: await code(
        entitySources(refused.brain, reader, { entityId: id })
      ),
      everyName: await code(entitiesFor(agent.brain, reader, {})),
      oneLetter: await code(entitiesFor(agent.brain, reader, { query: "a" })),
      byStart: await code(entitiesFor(agent.brain, reader, { query: "an" })),
      person: await code(entitiesFor(host.brain, reader, {})),
    }).toStrictEqual({
      relations: "brain.denied",
      entities: "brain.denied",
      sources: "brain.denied",
      everyName: "brain.invalid",
      oneLetter: "brain.invalid",
      byStart: "ok",
      person: "ok",
    });
  });
});

/** A path as names: each relation's subject, predicate and object, then where it ends. */
const named = (explanation: Awaited<ReturnType<typeof relationsExplain>>) =>
  explanation.paths.map(({ relations, to }) => [
    ...relations.map(
      ({ subject, predicate, object }) =>
        `${subject.name} ${predicate} ${object.name}`
    ),
    `→ ${to.name}`,
  ]);

/** The Brain's error code a read was refused with, or `read`. */
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "read";
  } catch (error) {
    return brainErrors.codeOf(error);
  }
};

/** Paths in one order, whatever order they were found in. */
const inOrder = (paths: string[][]): string[][] =>
  paths.toSorted((a, b) => a.join("\n").localeCompare(b.join("\n")));

describe("explained relations", () => {
  /**
   * A team's handbook where Anna owns onboarding, onboarding uses Personio,
   * and, in a memo only some may read, onboarding uses a secret tool.
   */
  const handbook = async () => {
    const thing = `Onboarding ${word()}`;
    const tool = `Personio ${word()}`;
    const secret = `Vault ${word()}`;
    const owns = `Anna owns ${thing}.`;
    const uses = `${thing} uses ${tool}.`;
    const hidden = `${thing} uses ${secret}.`;
    const host = testHost(
      modelOf({
        [owns]: {
          entities: [
            { kind: "person", name: "Anna" },
            { kind: "process", name: thing },
            { kind: "tool", name: tool },
          ],
          relations: [
            {
              subject: "Anna",
              predicate: "owns",
              object: thing,
              evidence: owns,
            },
            { subject: thing, predicate: "uses", object: tool, evidence: uses },
          ],
        },
        [hidden]: {
          entities: [
            { kind: "process", name: thing },
            { kind: "tool", name: secret },
          ],
          relations: [
            {
              subject: thing,
              predicate: "uses",
              object: secret,
              evidence: hidden,
            },
          ],
        },
      })
    );
    const team = await newCollection(host.brain, "Operations");
    await savedAndLinked(host, team, "handbook.md", `${owns}\n${uses}`);
    await savedAndLinked(host, team, "memo.md", hidden);
    const everyone: Caller = { userId: "reader", reads: [team.id] };
    const some: Caller = {
      userId: "other",
      reads: [team.id],
      only: { [team.id]: ["handbook.md"] },
    };
    const anna = await entityOf(host, everyone, "Anna");
    return { host, everyone, some, anna, thing, tool, secret };
  };

  it("follows an entity's relations two hops out, each path with its passages, only through what the reader may read", async () => {
    const { host, everyone, some, anna, thing, tool, secret } =
      await handbook();

    const [all, narrowed, oneHop] = await Promise.all([
      relationsExplain(host.brain, everyone, { entityId: anna }),
      relationsExplain(host.brain, some, { entityId: anna }),
      relationsExplain(host.brain, everyone, { entityId: anna, hops: 1 }),
    ]);

    expect({
      all: inOrder(named(all)),
      narrowed: named(narrowed),
      oneHop: named(oneHop),
      evidence: all.paths[0]?.relations[0]?.evidence,
      truncated: [all.truncated, narrowed.truncated],
    }).toStrictEqual({
      all: inOrder([
        [`Anna owns ${thing}`, `→ ${thing}`],
        [`Anna owns ${thing}`, `${thing} uses ${secret}`, `→ ${secret}`],
        [`Anna owns ${thing}`, `${thing} uses ${tool}`, `→ ${tool}`],
      ]),
      // The memo is none of theirs: its relation neither shows nor counts.
      narrowed: [
        [`Anna owns ${thing}`, `→ ${thing}`],
        [`Anna owns ${thing}`, `${thing} uses ${tool}`, `→ ${tool}`],
      ],
      oneHop: [[`Anna owns ${thing}`, `→ ${thing}`]],
      evidence: `Anna owns ${thing}.`,
      truncated: [false, false],
    });
  });

  it("stops at its budget of paths or its deadline, and says it was cut", async () => {
    const { host, everyone, anna } = await handbook();
    // A clock that has run past any deadline by the second hop.
    let calls = 0;
    const late = {
      ...host.brain,
      ports: {
        ...host.brain.ports,
        clock: () => {
          calls += 1;
          return new Date(Date.now() + (calls === 1 ? 0 : 10_000));
        },
      },
    };

    const [few, slow] = await Promise.all([
      relationsExplain(host.brain, everyone, {
        entityId: anna,
        budget: { maxPaths: 1 },
      }),
      relationsExplain(late, everyone, { entityId: anna }),
    ]);

    expect({
      few: { paths: few.paths.length, truncated: few.truncated },
      slow: { paths: slow.paths.length, truncated: slow.truncated },
    }).toStrictEqual({
      few: { paths: 1, truncated: true },
      slow: { paths: 1, truncated: true },
    });
  });

  it("takes no graph expression, and nothing without the Brain's gate", async () => {
    const { host, anna } = await handbook();

    await expect(
      Promise.all([
        refusal(
          relationsExplain(
            host.brain,
            { userId: "reader", reads: [] },
            {
              entityId: anna,
              hops: 3,
            }
          )
        ),
        refusal(
          relationsExplain(
            host.brain,
            { userId: "reader", reads: [] },
            {
              entityId: anna,
              where: "1 = 1",
            }
          )
        ),
      ])
    ).resolves.toStrictEqual(["brain.invalid", "brain.invalid"]);
  });
});

describe("relations in a person's own memory", () => {
  it("follow what the record rests on: once the owner can't read its source, neither its entities nor its relations are theirs to read", async () => {
    const thing = `Payroll ${word()}`;
    const remembered = `Mia owns ${thing}.`;
    const host = testHost(
      modelOf({
        [remembered]: {
          entities: [
            { kind: "person", name: "Mia" },
            { kind: "process", name: thing },
          ],
          relations: [
            {
              subject: "Mia",
              predicate: "owns",
              object: thing,
              evidence: remembered,
            },
          ],
        },
      })
    );
    const collection = await newCollection(host.brain, "HR");
    const source = await writeVersion(host.brain, writerOf("writer"), {
      collection,
      path: "owners.md",
      text: "Payroll changes hands this month.",
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const userId = `person-${word()}`;
    const reads: Caller = { userId, reads: [collection.id] };
    await remember(
      host.brain,
      reads,
      {
        kind: "preference",
        text: remembered,
        sourceRefs: [
          {
            kind: "document",
            documentId: source.id,
            collectionId: collection.id,
            version: source.currentVersion,
          },
        ],
      },
      { idempotencyKey: word() }
    );
    await sweepLinking(host.brain, new Date(Date.now() + settleMs + 60_000));
    for (const { job } of host.started.filter(
      (started: StartedJob) => "source" in started.job
    )) {
      // oxlint-disable-next-line no-await-in-loop -- one job after another
      await runLinking(host.brain, job, once);
    }
    // The same person, once they no longer read the collection it rests on.
    const lost: Caller = { userId, reads: [] };
    const read = async (caller: Caller) => {
      const [found] = await entitiesFor(host.brain, caller, { query: thing });
      const related = await owners(host, caller, found?.id ?? "-");
      return {
        entity: found?.label,
        owners: related.map(({ owner }) => owner),
      };
    };

    await expect(Promise.all([read(reads), read(lost)])).resolves.toStrictEqual(
      [
        { entity: thing, owners: ["Mia"] },
        { entity: undefined, owners: [] },
      ]
    );
  });
});
