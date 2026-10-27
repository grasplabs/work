import { describe, expect, it } from "vite-plus/test";

import type { MemoryPack } from "../src/contract.ts";
import { writeVersion } from "../src/documents.ts";
import { runLinking } from "../src/entities.ts";
import { collectionIdSchema } from "../src/ids.ts";
import type { IndexStep } from "../src/indexing.ts";
import { recall } from "../src/recall.ts";
import type { Caller } from "./host.ts";
import { newCollection, testHost, writerOf } from "./host.ts";

// A recall's network route (GRA-307, its threat model), through the
// Brain's own boundaries: saves, the linking job, and the recall. The model
// is the one outside provider, faked: it names the relations each text
// states. The ways the route could fail, tried here:
// 1. It adds a relation no source states, or calls a model to find one.
// 2. It takes a hop the reader may not, or reaches a readable relation
//    only through one they may not.
// 3. Hidden relations change what the reader sees, a cap included.
// 4. A recall bound to collections follows relations outside them.
// 5. It reads without bound, or hides that a bound cut it.
// 6. It follows a relation its source no longer states.

/** A word no other test's text has. */
const word = () => `w${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;

/** A step that runs once, as a run without retries would. */
const once: IndexStep = { do: async (_name, _config, fn) => await fn() };

/** A relation as the fake model states it. */
interface Stated {
  subject: string;
  predicate: string;
  object: string;
  evidence: string;
}

/** A relation stated by its passage, `subject predicate object.` */
const stated = (
  subject: string,
  predicate: string,
  object: string
): Stated => ({
  subject,
  predicate,
  object,
  evidence: `${subject} ${predicate.replaceAll("_", " ")} ${object}.`,
});

/**
 * A model that answers each text by the relations whose passages it holds,
 * counting its calls.
 */
const modelOf = (relations: readonly Stated[]) => {
  const calls = { count: 0 };
  const model = async (text: string): Promise<unknown> => {
    calls.count += 1;
    await Promise.resolve();
    const found = relations.filter(({ evidence }) => text.includes(evidence));
    const names = [
      ...new Set(found.flatMap(({ subject, object }) => [subject, object])),
    ];
    return {
      entities: names.map((name) => ({ kind: "thing", name })),
      relations: found,
    };
  };
  return { model, calls };
};

type Host = ReturnType<typeof testHost>;
type Collection = Awaited<ReturnType<typeof newCollection>>;

/** Saves `text` at `path` and links it, as version `ifVersion + 1`. */
const saved = async (
  host: Host,
  collection: Collection,
  path: string,
  text: string,
  ifVersion = 0
): Promise<void> => {
  const written = await writeVersion(host.brain, writerOf("writer"), {
    collection,
    path,
    text,
    ifVersion,
    message: null,
    restoredFrom: null,
  });
  await runLinking(
    host.brain,
    { source: `doc:${written.id}`, version: written.currentVersion },
    once
  );
};

/** What a pack's network route added: each item's path, read as text. */
const routed = (pack: MemoryPack): string[] =>
  (pack.network?.paths ?? [])
    .map(({ seed, steps }) =>
      [
        `from ${seed.name}:`,
        ...steps.map(
          ({ subject, predicate, object }) =>
            `${subject.name} ${predicate} ${object.name}`
        ),
      ].join(" ")
    )
    .toSorted((a, b) => a.localeCompare(b));

/** Why a pack's network route left out what it might have followed. */
const cutsOf = (pack: MemoryPack): string[] =>
  pack.coverage.omittedRoutes
    .filter(({ route }) => route === "network")
    .map(({ reason }) => reason)
    .toSorted();

/** A pack as a reader sees it, without what differs between two recalls. */
const seen = (pack: MemoryPack) => ({
  items: pack.items.map(({ statement, sourceRefs }) => ({
    statement,
    sourceRefs,
  })),
  paths: pack.network?.paths,
  coverage: pack.coverage,
  truncated: pack.truncated,
});

/**
 * A team's notes: the one a recall finds says Anna owns onboarding; the
 * handbook says onboarding uses a tool, and infrastructure notes that the
 * tool runs on a cloud; a memo some can't read says onboarding uses a
 * secret tool.
 */
const team = async (
  /** More relations the model states, of onboarding's name. */
  more: (thing: string) => Stated[] = () => []
) => {
  const query = word();
  const thing = `Onboarding ${word()}`;
  const tool = `Personio ${word()}`;
  const cloud = `Cloud ${word()}`;
  const secret = `Vault ${word()}`;
  const owns = stated("Anna", "owns", thing);
  const uses = stated(thing, "uses", tool);
  const runs = stated(tool, "runs_on", cloud);
  const hidden = stated(thing, "uses", secret);
  const extra = more(thing);
  const { model, calls } = modelOf([owns, uses, runs, hidden, ...extra]);
  const host = testHost(model);
  const notes = await newCollection(host.brain, "Operations");
  await saved(host, notes, "team.md", `# Team\n${query}: ${owns.evidence}`);
  await saved(host, notes, "handbook.md", uses.evidence);
  await saved(host, notes, "infra.md", runs.evidence);
  await saved(host, notes, "memo.md", hidden.evidence);
  const everyone: Caller = { userId: "reader", reads: [notes.id] };
  const some: Caller = {
    userId: "other",
    reads: [notes.id],
    only: { [notes.id]: ["team.md", "handbook.md", "infra.md"] },
  };
  return {
    host,
    notes,
    calls,
    query,
    names: { thing, tool, cloud, secret },
    passages: { uses, runs },
    extra,
    everyone,
    some,
  };
};

describe("a recall's network route", () => {
  it("follows what the evidence names along stored relations, each item its source's own passage and exact path, without a model", async () => {
    const { host, calls, query, names, everyone, some } = await team();
    const { thing, tool, cloud, secret } = names;
    const callsBefore = calls.count;

    const [plain, all, narrowed, oneHop] = await Promise.all([
      recall(host.brain, everyone, { query }),
      recall(host.brain, everyone, { query, network: {} }),
      recall(host.brain, some, { query, network: {} }),
      recall(host.brain, everyone, { query, network: { hops: 1 } }),
    ]);

    expect({
      plain: [plain.items.length, plain.network, plain.retrievalPolicyVersion],
      all: routed(all),
      narrowed: routed(narrowed),
      oneHop: routed(oneHop),
      statements: all.items
        .slice(1)
        .map(({ statement }) => statement)
        .toSorted(),
      policy: all.retrievalPolicyVersion,
      coverage: all.coverage,
      truncated: all.truncated,
      modelCalls: calls.count - callsBefore,
    }).toStrictEqual({
      plain: [1, undefined, "fulltext@3"],
      all: [
        `from ${thing}: ${thing} uses ${secret}`,
        `from ${thing}: ${thing} uses ${tool}`,
        `from ${thing}: ${thing} uses ${tool} ${tool} runs_on ${cloud}`,
      ].toSorted((a, b) => a.localeCompare(b)),
      // The memo is none of theirs: its relation neither shows nor leads.
      narrowed: [
        `from ${thing}: ${thing} uses ${tool}`,
        `from ${thing}: ${thing} uses ${tool} ${tool} runs_on ${cloud}`,
      ],
      oneHop: [
        `from ${thing}: ${thing} uses ${secret}`,
        `from ${thing}: ${thing} uses ${tool}`,
      ].toSorted((a, b) => a.localeCompare(b)),
      statements: [
        `${thing} uses ${secret}.`,
        `${thing} uses ${tool}.`,
        `${tool} runs on ${cloud}.`,
      ].toSorted(),
      policy: "fulltext@3+traversal@1",
      coverage: {
        state: "complete",
        queriedRoutes: ["fulltext", "network"],
        omittedRoutes: [{ route: "semantic", reason: "not_enabled" }],
      },
      truncated: false,
      modelCalls: 0,
    });
  });

  it("never reaches a relation the reader may read through one they may not", async () => {
    const query = word();
    const payroll = `Payroll ${word()}`;
    const leads = stated("Anna", "leads", `Ops ${word()}`);
    const mentors = stated("Anna", "mentors", "Bob");
    const owns = stated("Bob", "owns", payroll);
    const host = testHost(modelOf([leads, mentors, owns]).model);
    const notes = await newCollection(host.brain, "People");
    await saved(host, notes, "team.md", `${query}: ${leads.evidence}`);
    await saved(host, notes, "memo.md", mentors.evidence);
    await saved(host, notes, "handbook.md", owns.evidence);
    const everyone: Caller = { userId: "reader", reads: [notes.id] };
    const some: Caller = {
      userId: "other",
      reads: [notes.id],
      only: { [notes.id]: ["team.md", "handbook.md"] },
    };

    const [all, narrowed] = await Promise.all([
      recall(host.brain, everyone, { query, network: {} }),
      recall(host.brain, some, { query, network: {} }),
    ]);

    expect({ all: routed(all), narrowed: routed(narrowed) }).toStrictEqual({
      all: [
        "from Anna: Anna mentors Bob",
        `from Anna: Anna mentors Bob Bob owns ${payroll}`,
      ],
      narrowed: [],
    });
  });

  it("answers the same, cap and all, however many relations the reader can't read surround what they can", async () => {
    // As many relations of onboarding as fill a read's cap and more, in
    // notes of the same collection the reader may not read (a per-path
    // audience): the same entity, so the same reads meet them.
    const { host, notes, query, extra, some } = await team((thing) =>
      Array.from({ length: 200 }, (_, index) =>
        stated(thing, "relates_to", `Hidden ${index} ${word()}`)
      )
    );
    const before = await recall(host.brain, some, { query, network: {} });
    for (let file = 0; file < 4; file += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await saved(
        host,
        notes,
        `hidden-${file}.md`,
        extra
          .slice(file * 50, file * 50 + 50)
          .map(({ evidence }) => evidence)
          .join("\n")
      );
    }

    const after = await recall(host.brain, some, { query, network: {} });

    expect(seen(after)).toStrictEqual(seen(before));
  });

  it("follows relations inside a bound recall's collections, and never across collections, whose entities are their own", async () => {
    const query = word();
    const thing = `Invoicing ${word()}`;
    const owns = stated("Anna", "owns", thing);
    const uses = stated(thing, "uses", `Exact ${word()}`);
    const elsewhere = stated(thing, "uses", `Twinfield ${word()}`);
    const host = testHost(modelOf([owns, uses, elsewhere]).model);
    const finance = await newCollection(host.brain, "Finance");
    const tools = await newCollection(host.brain, "Tools");
    await saved(host, finance, "team.md", `${query}: ${owns.evidence}`);
    await saved(host, finance, "stack.md", uses.evidence);
    await saved(host, tools, "stack.md", elsewhere.evidence);
    const reader: Caller = { userId: "reader", reads: [finance.id, tools.id] };

    const [unbound, bound, filtered] = await Promise.all([
      recall(host.brain, reader, { query, network: {} }),
      recall(host.brain, reader, { query, network: {} }, [
        collectionIdSchema.parse(finance.id),
      ]),
      recall(host.brain, reader, {
        query,
        network: {},
        filters: { collectionIds: [finance.id] },
      }),
    ]);

    // The same name in Tools is another entity there: no path reaches it.
    const expected = [`from ${thing}: ${uses.subject} uses ${uses.object}`];
    expect({
      unbound: routed(unbound),
      bound: routed(bound),
      filtered: routed(filtered),
    }).toStrictEqual({
      unbound: expected,
      bound: expected,
      filtered: expected,
    });
  });

  it("goes on from twenty entities at most, stays in its budget of items, and says what each cut", async () => {
    const query = word();
    const hub = `Hub ${word()}`;
    const members = Array.from({ length: 21 }, (_, index) =>
      stated(`Member ${index} ${word()}`, "belongs_to", hub)
    );
    const elsewhere = members.map(({ subject }) =>
      stated(subject, "works_in", `Office ${word()}`)
    );
    const host = testHost(modelOf([...members, ...elsewhere]).model);
    const notes = await newCollection(host.brain, "Directory");
    await saved(
      host,
      notes,
      "hub.md",
      `${query}\n${members.map(({ evidence }) => evidence).join("\n")}`
    );
    await saved(
      host,
      notes,
      "offices.md",
      elsewhere.map(({ evidence }) => evidence).join("\n")
    );
    const reader: Caller = { userId: "reader", reads: [notes.id] };

    const [wide, small] = await Promise.all([
      recall(host.brain, reader, {
        query,
        network: { hops: 1 },
        budget: { maxItems: 50 },
      }),
      recall(host.brain, reader, {
        query,
        network: { hops: 1 },
        budget: { maxItems: 3 },
      }),
    ]);

    expect({
      wide: [cutsOf(wide), routed(wide).length, wide.truncated],
      small: [cutsOf(small), small.items.length, small.truncated],
      states: [wide.coverage.state, small.coverage.state],
    }).toStrictEqual({
      // 22 seeds (21 members and the hub), 20 gone on from: the hub's
      // relations are all the found note's own, so 19 offices are reached.
      wide: [["fan_out"], 19, true],
      small: [["fan_out", "items"], 3, true],
      states: ["bounded", "bounded"],
    });
  });

  it("no longer follows a relation once its source's new version doesn't state it", async () => {
    const { host, notes, query, names, passages, everyone } = await team();
    await saved(host, notes, "handbook.md", `${names.tool} is retired.`, 1);

    const pack = await recall(host.brain, everyone, { query, network: {} });

    expect(pack.items.map(({ statement }) => statement)).not.toContain(
      passages.uses.evidence
    );
  });
});
