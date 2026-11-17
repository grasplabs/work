// A person's erasure in the shared store (erasure.ts `erasePersonShared`,
// people.ts): what the store derived about them and what is in their own
// word goes, the documents stay. The threat model is on GRA-1747. Each
// test has its own people, groups and entities, so what others left in
// the shared store is hidden from it; the export test, which restores the
// store from empty, comes last.
import { erasedConfirmer, restoringNow } from "@grasp-os/brain-next/contract";
import type {
  Identifier,
  NewEntity,
  NewMemories,
  NewMemory,
  Reader,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import { replayHashesPerStep } from "../src/people.ts";
import type { BrainStore } from "../src/store.ts";
import { exportSettled, restoredAfterLoss, tick } from "./export-reads.ts";
import { copyOf, restore } from "./store-copy.ts";
import type { Copy } from "./store-copy.ts";

type Store = DurableObjectStub<BrainStore>;

const shared = (): Store => env.BRAIN_STORE.getByName("brain");
const unique = (name: string): string => `${name}${crypto.randomUUID()}`;
/** A word of letters only, so a find by name takes it as one name. */
const word = (): string =>
  `w${crypto.randomUUID().replaceAll("-", "").replaceAll(/\d/gu, "")}`.slice(
    0,
    14
  );

/** A memory of `about`, in `person`'s word, resting on `basis`. */
const said = (
  about: string,
  statement: string,
  person: string,
  basis: NewMemory["basis"],
  extra: Partial<NewMemory> = {}
): NewMemory => ({
  about,
  type: "fact",
  statement,
  speaker: { kind: "internal", person },
  basis,
  ...extra,
});

/** Adds `memories` about `entities` to the shared store for `group`. */
const remember = async (
  group: string,
  entities: NewEntity[],
  memories: NewMemory[]
) =>
  await shared().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group },
    entities,
    memories,
  });

/** A document of `group`'s holding `text`: its key and version. */
const document = async (group: string, text: string) => {
  const source = unique("upload:");
  const { version } = await shared().addSource({
    source,
    change: crypto.randomUUID(),
    text,
    access: { kind: "audience", group },
  });
  return { source, version };
};

/** How an add is refused for its memory at `place` resting on a version the store doesn't hold. */
const missingMemory = (place: number): string =>
  `memory ${place} rests on a version this store doesn't hold`;

/** When a read was answered, as its answer says it. */
const readAt = /"at":"[^"]*"/gu;

/** A fact `statement` about `about`, in an App's own word. */
const fromApp = (about: string, statement: string): NewMemory => ({
  about,
  type: "fact",
  statement,
  speaker: { kind: "agent", agent: "app:hr" },
  basis: { kind: "writer", writer: "app:hr" },
});

/** A basis on `doc`, quoting `quote`. */
const on = (
  doc: { source: string; version: number },
  quote: string
): NewMemory["basis"] => ({ kind: "source", ...doc, quote });

const email = (local: string): Identifier => ({
  type: "email",
  value: `${local}@acme.test`,
});

/** `name` of `target`, as it has it. */
const readOf = (target: object, name: string | symbol): unknown => {
  const value: unknown = Reflect.get(target, name, target);
  return value;
};

/** Erases `person`, whose identifier is `identifier`, from the shared store. */
const erase = async (person: string, identifiers: Identifier[]) => {
  await shared().erasePersonShared({
    person,
    identifiers,
    reason: "person_erased",
  });
};

/**
 * Everything `reader` reads of `entities` and by `names`, as text: each
 * one's memories with history, its entity, names and card; a find by each
 * name and identifier; its contested facts; and a recall of the names.
 */
const everything = async (
  reader: Reader,
  entities: readonly string[],
  names: readonly string[],
  identifiers: readonly Identifier[] = []
): Promise<string> => {
  const store = shared();
  const reads = await Promise.all([
    ...entities.flatMap((entity) => [
      store.readMemories({ entity, reader, history: true }),
      store.readEntity({ entity, reader }),
      store.readEntityNames({ entity, reader }),
      store.readCard({ entity, reader }),
      store.listContested({ reader, entity }),
    ]),
    ...names.map(async (name) => await store.findEntities({ reader, name })),
    ...identifiers.map(
      async (identifier) => await store.findEntities({ reader, identifier })
    ),
    (async () => {
      const pack = await store.recall({
        question: names.join(" "),
        reader,
        budget: { tokens: 4000 },
      });
      return pack.memories;
    })(),
  ]);
  return JSON.stringify(reads);
};

/** Whether `adding` is refused for what an erasure took (`"refused"`), added, or what else it threw. */
const refused = async (adding: () => Promise<unknown>) =>
  await adding().then(
    () => "added",
    (error: unknown) =>
      error instanceof Error && error.message.includes("an erasure took")
        ? "refused"
        : String(error)
  );

/** The text of `doc`, as `reader` reads it. */
const textOf = async (
  doc: { source: string; version: number },
  reader: Reader
): Promise<string | undefined> => {
  const read = await shared().readVersion({ ...doc, reader });
  return read?.text;
};

/** Export `id`'s status. */
const statusOf = async (id: string) => await shared().exportStatus({ id });

/** The statements about `entity` `reader` reads, with history. */
const statementsOf = async (entity: string, reader: Reader) => {
  const { memories } = await shared().readMemories({
    entity,
    reader,
    history: true,
  });
  return memories.map(({ statement }) => statement).toSorted();
};

/** How many rows of the store still hold `needle`, by table: whatever is left of a person. */
const rowsHolding = async (needle: string): Promise<Record<string, number>> =>
  await runInDurableObject(shared(), (_instance, state) => {
    const found: Record<string, number> = {};
    for (const table of [
      "memories",
      "entity_names",
      "memory_confirmations",
      "person_erasure_memories",
    ]) {
      for (const row of state.storage.sql
        .exec(`SELECT * FROM "${table}"`)
        .toArray()) {
        if (JSON.stringify(row).includes(needle)) {
          found[table] = (found[table] ?? 0) + 1;
        }
      }
    }
    return found;
  });

/** How many memories people's erasures still hide. */
const hidden = async (): Promise<number> =>
  await runInDurableObject(
    shared(),
    (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM person_erasure_memories"
        )
        .one().count
  );

/**
 * Anna, Bob and a team: Bob's note about her (her name and address), her
 * own note, and from them memories about her, one in her word about a
 * project, Bob's about the project which she confirmed, and Bob's manager
 * being her; and a colleague with her first name but another address.
 */
const annaAndBob = async () => {
  const group = unique("g");
  const anna = unique("anna-");
  const bob = unique("bob-");
  const first = word();
  const name = `${first} ${word()}`;
  const local = word();
  const marker = word();
  const bobsNote = await document(
    group,
    `${name} (${local}@acme.test) leads finance ${marker}.`
  );
  const annasNote = await document(
    group,
    `I am on leave in March. Atlas ships in May ${marker}.`
  );
  const added = await remember(
    group,
    [
      {
        key: "anna",
        kind: "person",
        names: [name],
        identifiers: [email(local)],
      },
      { key: "atlas", kind: "project", names: [`Atlas ${marker}`] },
      { key: "bob", kind: "person", names: [`Bob ${marker}`] },
    ],
    [
      said(
        "anna",
        `${name} leads finance ${marker}`,
        bob,
        on(bobsNote, "leads finance"),
        {
          attribute: "role",
          value: "finance lead",
        }
      ),
      said(
        "anna",
        `${name} is on leave in March ${marker}`,
        anna,
        on(annasNote, "I am on leave in March"),
        {
          attribute: "availability",
          value: "on leave in March",
        }
      ),
      said(
        "atlas",
        `Atlas ships in May, says ${marker}`,
        anna,
        on(annasNote, "Atlas ships in May")
      ),
      said(
        "atlas",
        `Atlas has a finance lead ${marker}`,
        bob,
        on(bobsNote, "leads finance")
      ),
      said(
        "bob",
        `Bob reports to her ${marker}`,
        bob,
        on(bobsNote, "leads finance"),
        {
          attribute: "manager",
          object: "anna",
        }
      ),
    ]
  );
  const otherLocal = word();
  const colleague = await remember(
    group,
    [
      {
        key: "other",
        kind: "person",
        names: [`${first} ${word()}`],
        identifiers: [email(otherLocal)],
      },
    ],
    [
      said("other", `${first} joins sales ${marker}`, bob, {
        kind: "writer",
        writer: "app:hr",
      }),
    ]
  );
  const reader: Reader = { person: bob, groups: [group] };
  const bobsAtlas = added.memories.at(3);
  await shared().confirmMemory({
    memory: bobsAtlas ?? "",
    reader: { person: anna, groups: [group] },
  });
  return {
    group,
    anna,
    bob,
    name,
    local,
    marker,
    reader,
    bobsNote,
    annasNote,
    entities: {
      anna: added.entities.anna ?? "",
      atlas: added.entities.atlas ?? "",
      bob: added.entities.bob ?? "",
      other: colleague.entities.other ?? "",
    },
  };
};

describe("a person's erasure in the shared store", () => {
  /** The shared store before any test of this file added to it: empty. */
  let empty: Copy = { tables: [], others: [] };
  beforeAll(async () => {
    empty = await copyOf(shared());
  });

  it("hides at once what the store derived about them and their word, keeps the documents, everyone else's memories and their confirmations, and deletes what it hid at the next tick", async () => {
    const at = await annaAndBob();
    const { reader, entities } = at;

    await erase(at.anna, [email(at.local)]);

    const seen = await everything(
      reader,
      [entities.anna],
      [at.name],
      [email(at.local)]
    );
    const atlas = await shared().readMemories({
      entity: entities.atlas,
      reader,
    });
    const stillRead = {
      // Their entity, card and names: gone for a teammate.
      entity: await shared().readEntity({ entity: entities.anna, reader }),
      card: await shared().readCard({ entity: entities.anna, reader }),
      // Bob's own word stays, but not the relation to her, nor what is in
      // her word about the project.
      bob: await statementsOf(entities.bob, reader),
      atlas: atlas.memories.map(({ statement, confirmed }) => ({
        statement,
        by: confirmed?.by ?? null,
      })),
      // The colleague with her first name and another address is untouched.
      other: await statementsOf(entities.other, reader),
      // The documents stay, also where they name her.
      bobsNote: await textOf(at.bobsNote, reader),
      annasNote: await textOf(at.annasNote, reader),
    };
    await tick(shared());

    expect({
      seen: [
        at.name,
        `${at.local}@acme.test`,
        at.anna,
        "leave in March",
      ].filter((needle) => seen.includes(needle)),
      ...stillRead,
      hiddenAfter: await hidden(),
      left: {
        name: await rowsHolding(at.name),
        email: await rowsHolding(`${at.local}@acme.test`),
        person: await rowsHolding(at.anna),
      },
    }).toStrictEqual({
      seen: [],
      entity: null,
      card: null,
      bob: [],
      atlas: [
        {
          statement: `Atlas has a finance lead ${at.marker}`,
          by: erasedConfirmer,
        },
      ],
      other: [`${at.name.split(" ")[0]} joins sales ${at.marker}`],
      bobsNote: `${at.name} (${at.local}@acme.test) leads finance ${at.marker}.`,
      annasNote: `I am on leave in March. Atlas ships in May ${at.marker}.`,
      hiddenAfter: 0,
      left: { name: {}, email: {}, person: {} },
    });
  });

  it("takes only their address from a team, a project or a shared desk, keeps every fact others wrote about them, and keeps later writes about them", async () => {
    const group = unique("g");
    // The desk is another group's: one add of one group would join it to
    // the team on her address, as exact evidence.
    const desks = unique("g");
    const bob = unique("bob-");
    const anna = unique("anna-");
    const reader: Reader = { person: bob, groups: [group, desks] };
    const local = word();
    const desk = word();
    const carl = word();
    const marker = word();
    const crm = (about: string, statement: string): NewMemory => ({
      about,
      type: "fact",
      statement,
      speaker: { kind: "internal", person: bob },
      basis: { kind: "writer", writer: "app:crm" },
    });
    // A team and a project whose only contact address was hers, and a
    // desk that holds hers beside its own.
    const { entities } = await remember(
      group,
      [
        {
          key: "team",
          kind: "team",
          names: [`Finance team ${marker}`],
          identifiers: [email(local)],
        },
        {
          key: "proj",
          kind: "project",
          names: [`Project Phoenix ${marker}`],
          identifiers: [email(local)],
        },
      ],
      [
        crm("team", `The Finance team closes the books on day 5 ${marker}`),
        crm("proj", `Phoenix budget is 2M ${marker}`),
      ]
    );
    const { entities: deskEntities } = await remember(
      desks,
      [
        {
          key: "desk",
          kind: "team",
          names: [`Finance desk ${marker}`],
          identifiers: [email(desk), email(local)],
        },
      ],
      [
        crm("desk", `Desk answers within a day ${marker}`),
        crm("desk", `Desk is open 9 to 5 ${marker}`),
      ]
    );
    const team = entities.team ?? "";
    const proj = entities.proj ?? "";
    const box = deskEntities.desk ?? "";
    await remember(
      group,
      [
        {
          key: "team",
          id: team,
          kind: "team",
          names: [`Finance team ${marker}`],
        },
      ],
      [crm("team", `The Finance team approves invoices over 10k ${marker}`)]
    );

    await erase(anna, [email(local)]);
    // Later: a fact about the team by its id, and an App's re-sync that
    // still lists her address on the desk, beside a new colleague.
    const later = await refused(
      async () =>
        await remember(
          group,
          [{ key: "team", id: team, kind: "team", names: [] }],
          [crm("team", `The Finance team moved ${marker}`)]
        )
    );
    const resync = await refused(
      async () =>
        await remember(
          desks,
          [
            {
              key: "desk",
              kind: "team",
              names: [`Finance desk ${marker}`],
              identifiers: [email(desk), email(local)],
            },
            {
              key: "carl",
              kind: "person",
              names: [`Carl ${marker}`],
              identifiers: [email(carl)],
            },
          ],
          [
            crm("desk", `Desk moves to Utrecht ${marker}`),
            crm("carl", `Carl joins sales ${marker}`),
          ]
        )
    );
    const namesOf = async (entity: string) => {
      const read = await shared().readEntityNames({ entity, reader });
      return read.names.map(({ value }) => value).toSorted();
    };
    const byAddress = async (local_: string) => {
      const found = await shared().findEntities({
        reader,
        identifier: email(local_),
      });
      return found.entities.map(({ id }) => id);
    };

    expect({
      later,
      resync,
      team: await statementsOf(team, reader),
      proj: await statementsOf(proj, reader),
      desk: await statementsOf(box, reader),
      names: {
        team: await namesOf(team),
        proj: await namesOf(proj),
        desk: await namesOf(box),
      },
      hers: await byAddress(local),
      desksAddress: await byAddress(desk),
      carl: await byAddress(carl).then((found) => found.length),
    }).toStrictEqual({
      later: "added",
      resync: "added",
      team: [
        `The Finance team approves invoices over 10k ${marker}`,
        `The Finance team closes the books on day 5 ${marker}`,
        `The Finance team moved ${marker}`,
      ],
      proj: [`Phoenix budget is 2M ${marker}`],
      desk: [
        `Desk answers within a day ${marker}`,
        `Desk is open 9 to 5 ${marker}`,
        `Desk moves to Utrecht ${marker}`,
      ],
      names: {
        team: [`Finance team ${marker}`],
        proj: [`Project Phoenix ${marker}`],
        desk: [`${desk}@acme.test`, `Finance desk ${marker}`].toSorted(),
      },
      hers: [],
      desksAddress: [box],
      carl: 1,
    });
  });

  it("answers an App's write naming an erased member's address as one naming an address it never saw, and refuses one in their word", async () => {
    const at = await annaAndBob();
    await erase(at.anna, [email(at.local)]);
    const fresh = word();
    /** An App's write of a fact about a person named `name` with address `local`: what it answers, shaped. */
    const write = async (name: string, local_: string) => {
      const added = await remember(
        at.group,
        [
          {
            key: "p",
            kind: "person",
            names: [name],
            identifiers: [email(local_)],
          },
        ],
        [
          {
            about: "p",
            type: "fact",
            statement: `${name} joins sales ${at.marker}`,
            speaker: { kind: "agent", agent: "app:hr" },
            basis: { kind: "writer", writer: "app:hr" },
          },
        ]
      );
      const found = await shared().findEntities({ reader: at.reader, name });
      return {
        memories: added.memories.length,
        entities: Object.keys(added.entities),
        found: found.entities.length,
      };
    };
    expect({
      erased: await write(`Sam ${word()}`, at.local),
      neverSeen: await write(`Sam ${word()}`, fresh),
      word: await refused(
        async () =>
          await remember(
            at.group,
            [{ key: "p", kind: "project", names: [`Orion ${at.marker}`] }],
            [
              {
                about: "p",
                type: "fact",
                statement: `Orion starts ${at.marker}`,
                speaker: { kind: "internal", person: at.anna },
                basis: { kind: "writer", writer: "app:hr" },
              },
            ]
          )
      ),
    }).toStrictEqual({
      erased: { memories: 1, entities: ["p"], found: 1 },
      neverSeen: { memories: 1, entities: ["p"], found: 1 },
      word: "refused",
    });
  });

  it("replays after an older copy of the store comes back: what it took stays hidden, the confirmer stays replaced, and the address stays closed", async () => {
    const at = await annaAndBob();
    const before = await copyOf(shared());
    await erase(at.anna, [email(at.local)]);
    await tick(shared());
    const after = await copyOf(shared());

    await restore(shared(), before);
    const seen = await everything(
      at.reader,
      [at.entities.anna],
      [at.name],
      [email(at.local)]
    );
    const atlas = await shared().readMemories({
      entity: at.entities.atlas,
      reader: at.reader,
    });
    const again = await shared()
      .addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: at.group },
        entities: [
          {
            key: "p",
            kind: "person",
            names: [at.name],
            identifiers: [email(at.local)],
          },
        ],
        memories: [
          {
            about: "p",
            type: "fact",
            statement: `Back ${at.marker}`,
            speaker: { kind: "system" },
            basis: { kind: "writer", writer: "app:hr" },
          },
        ],
      })
      .then(
        () => "added",
        () => "refused"
      );
    // Kept, but never with her address: it stays closed.
    const byAddress = await shared().findEntities({
      reader: at.reader,
      identifier: email(at.local),
    });
    await tick(shared());
    expect({
      seen: [at.name, `${at.local}@acme.test`, at.anna].filter((needle) =>
        seen.includes(needle)
      ),
      by: atlas.memories.map(({ confirmed }) => confirmed?.by ?? null),
      again,
      byAddress: byAddress.entities.length,
      left: await rowsHolding(at.anna),
    }).toStrictEqual({
      seen: [],
      by: [erasedConfirmer],
      again: "added",
      byAddress: 0,
      left: {},
    });
    // Repeating it is the same erasure: nothing more, nothing failed.
    await expect(erase(at.anna, [email(at.local)])).resolves.toBeUndefined();
    await restore(shared(), after);
  });

  // GRA-1981: a host replaces what a chat showed of a memory the erasure
  // took, as the ledger says it, by what it pinned when the memory was
  // handed over: whose word it is, what it is about and relates to.
  it("answers a host's pins of what it took as erased for good, in their word or about or relating to their card, also once the tick deleted it, an older copy came back or the storage was lost; never another's word on their document; and refuses while a restore runs", async () => {
    const at = await annaAndBob();
    // Her note, in Bob's word: hers as a document, not as a word.
    await remember(
      at.group,
      [
        {
          key: "atlas",
          id: at.entities.atlas,
          kind: "project",
          names: [`Atlas ${at.marker}`],
        },
      ],
      [
        said(
          "atlas",
          `Bob says Atlas needs a review ${at.marker}`,
          at.bob,
          on(at.annasNote, "Atlas ships in May")
        ),
      ]
    );
    // Each memory Bob reads, as a host pinned it when it was handed over.
    const read = await Promise.all(
      Object.values(at.entities).map(async (entity) => {
        const { memories } = await shared().readMemories({
          entity,
          reader: at.reader,
        });
        return memories;
      })
    );
    const statements = new Map<string, string>();
    const asked = {
      sources: [],
      memories: read
        .flat()
        .flatMap(
          ({
            id,
            source,
            writer,
            learnedAt,
            speaker,
            about,
            object,
            statement,
          }) => {
            if (statements.has(id)) {
              return [];
            }
            statements.set(id, statement);
            return [
              {
                memory: id,
                source: source?.source ?? null,
                writer,
                learnedAt: learnedAt.getTime(),
                speaker,
                about,
                object,
              },
            ];
          }
        ),
    };
    const erasedNow = async (): Promise<string[]> => {
      const answer = await shared().erasedOf(asked);
      return answer.memories
        .map((memory) => (statements.get(memory) ?? "").replace(at.name, "her"))
        .toSorted();
    };
    const before = await copyOf(shared());
    const none = await erasedNow();

    await erase(at.anna, [email(at.local)]);
    const hiddenNow = await erasedNow();
    await tick(shared());
    const deleted = { left: await hidden(), erased: await erasedNow() };
    const after = await copyOf(shared());
    await restore(shared(), before);
    const olderCopy = await erasedNow();
    await restore(shared(), empty);
    const lost = await erasedNow();
    const restoreId = crypto.randomUUID();
    await runInDurableObject(shared(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO restores (export, checked, part, restored, state, started_at)
        VALUES (?, 0, 0, 0, 'running', ?)`,
        restoreId,
        Date.now()
      );
    });
    const restoring = await shared()
      .erasedOf(asked)
      .then(() => "answered", String);
    await restore(shared(), after);

    const taken = [
      `Atlas ships in May, says ${at.marker}`,
      `Bob reports to her ${at.marker}`,
      `her is on leave in March ${at.marker}`,
      `her leads finance ${at.marker}`,
    ].toSorted();
    expect({
      asked: [...statements.values()].length,
      none,
      hiddenNow,
      deleted,
      olderCopy,
      lost,
      restoring,
    }).toStrictEqual({
      asked: 7,
      none: [],
      hiddenNow: taken,
      deleted: { left: 0, erased: taken },
      olderCopy: taken,
      lost: taken,
      restoring: `Error: ${restoringNow}`,
    });
  });

  it("hides her card on a replay into an older copy taken before her address was on it, by the card the erasure closed", async () => {
    const group = unique("g");
    const reader: Reader = { person: unique("bob-"), groups: [group] };
    const local = word();
    const name = `Anna ${word()}`;
    const { entities } = await remember(
      group,
      [{ key: "a", kind: "person", names: [name] }],
      [fromApp("a", `${name} leads finance`)]
    );
    const card = entities.a ?? "";
    const before = await copyOf(shared());
    // Her address reaches the card later.
    await shared().addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group },
      reader,
      entities: [
        {
          key: "a",
          id: card,
          kind: "person",
          names: [name],
          identifiers: [email(local)],
        },
      ],
      memories: [fromApp("a", `${name} works from Utrecht`)],
    });
    await erase(unique("anna-"), [email(local)]);
    await tick(shared());
    const after = await copyOf(shared());

    await restore(shared(), before);
    const seen = await everything(reader, [card], [name], []);
    await restore(shared(), after);

    expect(
      [name, "leads finance", "works from Utrecht"].filter((needle) =>
        seen.includes(needle)
      )
    ).toStrictEqual([]);
  });

  it("keeps a fact she confirmed over her own conflicting one current and confirmed, by no one named, once she is erased", async () => {
    const group = unique("g");
    const anna = unique("anna-");
    const bob = unique("bob-");
    const reader: Reader = { person: bob, groups: [group] };
    const project = `Audit ${word()}`;
    const { entities, memories } = await remember(
      group,
      [{ key: "p", kind: "project", names: [project] }],
      [
        said(
          "p",
          `${project} is on track`,
          bob,
          { kind: "writer", writer: "app:plan" },
          { attribute: "status", value: "on track" }
        ),
        said(
          "p",
          `${project} is late`,
          anna,
          { kind: "writer", writer: "app:sheet" },
          { attribute: "status", value: "late" }
        ),
      ]
    );
    await shared().confirmMemory({
      memory: memories[0] ?? "",
      reader: { person: anna, groups: [group] },
    });
    await erase(anna, []);
    await tick(shared());
    const read = await shared().readMemories({
      entity: entities.p ?? "",
      reader,
    });

    expect(
      read.memories.map(({ statement, confirmed, contested }) => ({
        statement,
        by: confirmed?.by ?? null,
        contested,
      }))
    ).toStrictEqual([
      {
        statement: `${project} is on track`,
        by: erasedConfirmer,
        contested: false,
      },
    ]);
  });

  it("stops a replay's step at its share of hashes, and the next steps go on to the same end as one never stopped", async () => {
    const at = await annaAndBob();
    const before = await copyOf(shared());
    // Two person entries: the step's share is theirs together.
    await erase(unique("nobody-"), [email(word())]);
    await erase(at.anna, [email(at.local)]);
    await tick(shared());
    const after = await copyOf(shared());
    // The same copy, its names holding one identifier more than a step
    // hashes: so its replay takes more than one step.
    const names = before.tables.find(({ name }) => name === "entity_names");
    const [some] = names?.rows ?? [];
    const big: Copy = {
      ...before,
      tables: before.tables.map((table) =>
        table.name === "entity_names" && some !== undefined
          ? {
              ...table,
              rows: [
                ...table.rows,
                ...Array.from({ length: replayHashesPerStep + 1 }, (_, n) => ({
                  ...some,
                  type: "ref",
                  value: `test:${n}`,
                  folded: `test:${n}`,
                })),
              ],
            }
          : table
      ),
    };
    /** Calls until the store answers: whether it was replaying after its first step. */
    const replayed = async () => {
      const { ledgerReplay } = await shared().workOverview();
      for (;;) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one call at a time, as the replay goes on
          await shared().readEntityNames({
            entity: at.entities.atlas,
            reader: at.reader,
          });
          break;
        } catch (error) {
          if (!String(error).includes("applying its erasure ledger")) {
            throw error;
          }
        }
      }
      const read = await everything(
        at.reader,
        [at.entities.anna],
        [at.name],
        [email(at.local)]
      );
      return { ledgerReplay, seen: read.replaceAll(readAt, "") };
    };

    await restore(shared(), before);
    const straight = await replayed();
    await restore(shared(), big);
    const stepped = await replayed();
    await restore(shared(), after);

    expect({
      straight: straight.ledgerReplay,
      stepped: stepped.ledgerReplay,
      same: stepped.seen === straight.seen,
      her: [at.name, `${at.local}@acme.test`].filter((needle) =>
        stepped.seen.includes(needle)
      ),
    }).toStrictEqual({
      straight: "through",
      stepped: "replaying",
      same: true,
      her: [],
    });
  });

  it("fails while its ledger entry can't be written, hiding meanwhile, and the retry writes that same erasure", async () => {
    const at = await annaAndBob();
    const bucket = env.BRAIN_OBJECTS;
    const setBucket = async (broken: boolean) => {
      await runInDurableObject(shared(), (instance) => {
        const objectEnv: unknown = Reflect.get(instance, "env");
        if (typeof objectEnv !== "object" || objectEnv === null) {
          throw new TypeError("The store has no env");
        }
        Reflect.set(instance, "env", {
          ...objectEnv,
          BRAIN_OBJECTS: broken
            ? new Proxy(bucket, {
                get: (target, name) =>
                  name === "put"
                    ? async () => {
                        await Promise.resolve();
                        throw new Error("Broken by the test");
                      }
                    : readOf(target, name),
              })
            : bucket,
        });
      });
    };
    const entries = async () =>
      await runInDurableObject(shared(), (_instance, state) =>
        state.storage.sql
          .exec<{ confirmed: number }>(
            "SELECT confirmed FROM erasures WHERE kind = 'person' AND erased_at > 0 ORDER BY key"
          )
          .toArray()
          .map(({ confirmed }) => confirmed)
      );
    const earlier = await entries();
    const count = earlier.length;
    await setBucket(true);
    let failed: unknown;
    try {
      await erase(at.anna, [email(at.local)]);
    } catch (error) {
      failed = error;
    } finally {
      await setBucket(false);
    }
    const meanwhile = await shared().readEntity({
      entity: at.entities.anna,
      reader: at.reader,
    });
    await erase(at.anna, [email(at.local)]);
    expect({
      failed: failed instanceof Error ? failed.message : failed,
      meanwhile,
      recorded: await entries().then((all) => all.slice(count)),
    }).toStrictEqual({
      failed: "The Brain could not record the erasure: erase it again",
      meanwhile: null,
      recorded: [1],
    });
  });

  it("is the shared store's alone", async () => {
    const person = unique("p");
    const own = env.BRAIN_STORE.getByName(`person:${person}`);
    await expect(
      (async () => {
        await own.erasePersonShared({
          person,
          identifiers: [],
          reason: "person_erased",
        });
      })()
    ).rejects.toThrow("only the shared store takes this");
  });

  it("takes their person card whole, whatever other addresses it holds, also one joined with someone else's", async () => {
    const group = unique("g");
    const bob = unique("bob-");
    const anna = unique("anna-");
    const reader: Reader = { person: bob, groups: [group] };
    const local = word();
    const own = word();
    const bobs = word();
    const name = `Anna ${word()}`;
    const joined = `Anna ${word()}`;
    const fromCrm = (about: string, statement: string): NewMemory => ({
      about,
      type: "fact",
      statement,
      speaker: { kind: "internal", person: bob },
      basis: { kind: "writer", writer: "app:crm" },
    });
    const privateAddress: Identifier = {
      type: "email",
      value: `${own}@private.test`,
    };
    const { entities } = await remember(
      group,
      [
        {
          key: "a",
          kind: "person",
          names: [name],
          identifiers: [
            email(local),
            privateAddress,
            { type: "ref", value: `crm:${own}` },
          ],
        },
      ],
      [
        fromCrm("a", `${name} leads finance`),
        fromCrm("a", `${name} is on sick leave until May`),
      ]
    );
    // A card two people were joined on, by her address and Bob's.
    const other = await remember(
      unique("g"),
      [
        {
          key: "j",
          kind: "person",
          names: [joined],
          identifiers: [email(local), email(bobs)],
        },
      ],
      [fromCrm("j", `${joined} runs payroll`)]
    );

    await erase(anna, [email(local)]);
    await tick(shared());
    const seen = await everything(
      reader,
      [entities.a ?? "", other.entities.j ?? ""],
      [name, joined],
      [email(local), privateAddress, email(bobs)]
    );

    expect(
      [
        name,
        joined,
        `${local}@acme.test`,
        `${own}@private.test`,
        `crm:${own}`,
        "leads finance",
        "sick leave",
        "runs payroll",
      ].filter((needle) => seen.includes(needle))
    ).toStrictEqual([]);
  });

  it("leaves her card out of a write resting on a document, also one holding another address of hers, and keeps the rest of it", async () => {
    const group = unique("g");
    const bob = unique("bob-");
    const reader: Reader = { person: bob, groups: [group] };
    const local = word();
    const own = word();
    const name = `Anna ${word()}`;
    const project = `Audit ${word()}`;
    const privateAddress: Identifier = {
      type: "email",
      value: `${own}@private.test`,
    };
    await erase(unique("anna-"), [email(local)]);
    const note = await document(
      group,
      `${name} (${local}@acme.test, ${own}@private.test) leads the audit. ${project} starts in June.`
    );
    const added = await remember(
      group,
      [
        {
          key: "a",
          kind: "person",
          names: [name],
          identifiers: [email(local), privateAddress],
        },
        { key: "p", kind: "project", names: [project] },
      ],
      [
        said("a", `${name} leads the audit`, bob, on(note, "leads the audit")),
        said(
          "p",
          `${project} is led by her`,
          bob,
          on(note, "leads the audit"),
          {
            attribute: "owner",
            object: "a",
          }
        ),
        said("p", `${project} starts in June`, bob, on(note, "starts in June")),
      ]
    );
    const seen = await everything(
      reader,
      [],
      [name],
      [email(local), privateAddress]
    );

    expect({
      entities: Object.keys(added.entities),
      memories: added.memories.length,
      project: await statementsOf(added.entities.p ?? "", reader),
      seen: [
        name,
        `${local}@acme.test`,
        `${own}@private.test`,
        "leads the audit",
        "led by her",
      ].filter((needle) => seen.includes(needle)),
    }).toStrictEqual({
      entities: ["p"],
      memories: 1,
      project: [`${project} starts in June`],
      seen: [],
    });
  });

  it("keeps each fact's own restatement once her card is left out before it, so a new version restates the right facts", async () => {
    const group = unique("g");
    const bob = unique("bob-");
    const reader: Reader = { person: bob, groups: [group] };
    const local = word();
    const name = `Anna ${word()}`;
    const project = `Audit ${word()}`;
    const source = unique("upload:");
    const version = async (text: string) => {
      const added = await shared().addSource({
        source,
        change: crypto.randomUUID(),
        text,
        access: { kind: "audience", group },
      });
      return { source, version: added.version };
    };
    await erase(unique("anna-"), [email(local)]);
    /** Her card's fact first, if `her`, then two of the project's, on `doc`. */
    const drawnFrom = async (
      doc: { source: string; version: number },
      her: boolean
    ) => {
      const card: NewEntity = {
        key: "a",
        kind: "person",
        names: [name],
        identifiers: [email(local)],
      };
      return await remember(
        group,
        [
          ...(her ? [card] : []),
          { key: "p", kind: "project", names: [project] },
        ],
        [
          ...(her
            ? [
                said(
                  "a",
                  `${name} leads the audit`,
                  bob,
                  on(doc, "leads the audit")
                ),
              ]
            : []),
          said(
            "p",
            `${project} starts in June`,
            bob,
            on(doc, "starts in June")
          ),
          said("p", `${project} ends in May`, bob, on(doc, "ends in May")),
        ]
      );
    };
    const text = `${name} (${local}@acme.test) leads the audit. ${project} starts in June and ends in May.`;
    const first = await drawnFrom(await version(text), true);
    // The next version no longer names her.
    await drawnFrom(
      await version(`${project} starts in June and ends in May.`),
      false
    );
    const { memories } = await shared().readMemories({
      entity: first.entities.p ?? "",
      reader,
    });

    expect(memories.map(({ statement }) => statement).toSorted()).toStrictEqual(
      [`${project} ends in May`, `${project} starts in June`].toSorted()
    );
  });

  it("refuses a write resting on a version it doesn't hold as it would without her erasure, naming the memory by its place as asked", async () => {
    const group = unique("g");
    const bob = unique("bob-");
    const local = word();
    const name = `Anna ${word()}`;
    const project = `Audit ${word()}`;
    const note = await document(
      group,
      `${name} (${local}@acme.test) leads the audit. ${project} starts in June.`
    );
    const missing = { ...note, version: note.version + 50 };
    /** Her card's memory on `hers`, then the project's on `projects`: refused with what, or added. */
    const added = async (
      hers: typeof note,
      projects: typeof note
    ): Promise<string> =>
      await remember(
        group,
        [
          {
            key: "a",
            kind: "person",
            names: [name],
            identifiers: [email(local)],
          },
          { key: "p", kind: "project", names: [project] },
        ],
        [
          said(
            "a",
            `${name} leads the audit`,
            bob,
            on(hers, "leads the audit")
          ),
          said(
            "p",
            `${project} starts in June`,
            bob,
            on(projects, "starts in June")
          ),
        ]
      ).then(() => "added", String);
    const cases = async () => ({
      secondMissing: await added(note, missing),
      hersMissing: await added(missing, note),
    });
    const before = await cases();
    await erase(unique("anna-"), [email(local)]);
    const after = await cases();

    expect({
      refused: [
        before.secondMissing.includes(missingMemory(1)),
        before.hersMissing.includes(missingMemory(0)),
      ],
      after,
    }).toStrictEqual({ refused: [true, true], after: before });
  });

  it.each([
    ["her card under an id no entity has", "unknown", 0],
    ["a second entity under an id no entity has", "second", 1],
    ["her card under a project's id", "project", 0],
  ] as const)(
    "answers a write naming %s alike with and without her erasure",
    async (_case, shape, place) => {
      /** What a write of the shape answers in a store where her card is, erased or not. */
      const answered = async (erased: boolean): Promise<string> => {
        const group = unique("g");
        const local = word();
        const name = `Anna ${word()}`;
        const note = await document(group, `${name} leads finance.`);
        const fact = (about: string): NewMemory => ({
          about,
          type: "fact",
          statement: `${about} leads finance`,
          speaker: { kind: "agent", agent: "app:hr" },
          basis: on(note, "leads finance"),
        });
        const card: NewEntity = {
          key: "a",
          kind: "person",
          names: [name],
          identifiers: [email(local)],
        };
        await remember(group, [card], [fact("a")]);
        const project = await remember(
          group,
          [{ key: "p", kind: "project", names: [`Audit ${word()}`] }],
          [fact("p")]
        );
        if (erased) {
          await erase(unique("anna-"), [email(local)]);
        }
        const shapes = {
          unknown: {
            entities: [{ ...card, id: crypto.randomUUID() }],
            memories: [fact("a")],
          },
          second: {
            entities: [
              card,
              { key: "p", id: crypto.randomUUID(), kind: "project" as const },
            ],
            memories: [fact("a"), fact("p")],
          },
          project: {
            entities: [{ ...card, id: project.entities.p ?? "" }],
            memories: [fact("a")],
          },
        };
        const { entities, memories } = shapes[shape];
        return await remember(group, entities, memories).then(
          () => "added",
          String
        );
      };

      const refusal = `Error: The Brain refused it: entity ${place} names no entity of its kind`;

      expect({
        without: await answered(false),
        with: await answered(true),
      }).toStrictEqual({ without: refusal, with: refusal });
    }
  );

  it("answers a write resting on a document tried again with the same change as it was made, whether her erasure came before it or in between", async () => {
    /** Her card and a project's fact, written on a note; then tried again. */
    const triedAgain = async (erasedBetween: boolean) => {
      const group = unique("g");
      const bob = unique("bob-");
      const reader: Reader = { person: bob, groups: [group] };
      const local = word();
      const name = `Anna ${word()}`;
      const project = `Audit ${word()}`;
      if (!erasedBetween) {
        await erase(unique("anna-"), [email(local)]);
      }
      const note = await document(
        group,
        `${name} (${local}@acme.test) leads the audit. ${project} starts in June.`
      );
      const asked: NewMemories = {
        change: crypto.randomUUID(),
        access: { kind: "audience", group },
        entities: [
          {
            key: "a",
            kind: "person",
            names: [name],
            identifiers: [email(local)],
          },
          { key: "p", kind: "project", names: [project] },
        ],
        memories: [
          said(
            "a",
            `${name} leads the audit`,
            bob,
            on(note, "leads the audit")
          ),
          said(
            "p",
            `${project} starts in June`,
            bob,
            on(note, "starts in June")
          ),
        ],
      };
      const first = await shared().addMemories(asked);
      if (erasedBetween) {
        await erase(unique("anna-"), [email(local)]);
      }
      const again = await shared().addMemories(asked);
      const seen = await everything(reader, [], [name], [email(local)]);
      return {
        same: JSON.stringify(again) === JSON.stringify(first),
        her: [name, `${local}@acme.test`, "leads the audit"].filter((needle) =>
          seen.includes(needle)
        ),
        project: await statementsOf(again.entities.p ?? "", reader),
        projectLine: `${project} starts in June`,
      };
    };
    const before = await triedAgain(false);
    const between = await triedAgain(true);

    expect({ before, between }).toStrictEqual({
      before: {
        same: true,
        her: [],
        project: [before.projectLine],
        projectLine: before.projectLine,
      },
      between: {
        same: true,
        her: [],
        project: [between.projectLine],
        projectLine: between.projectLine,
      },
    });
  });

  it("leaves every earlier export when it changed nothing, and makes it stale when it did", async () => {
    const at = await annaAndBob();
    const { id } = await shared().startExport("test");
    await expect(exportSettled(shared, id)).resolves.toBe("done");

    await erase(unique("nobody-"), [email(word())]);
    const untouched = await statusOf(id);
    await erase(at.anna, [email(at.local)]);
    const touched = await statusOf(id);

    expect({
      untouched: untouched?.state,
      touched: touched?.state,
    }).toStrictEqual({ untouched: "done", touched: "erased" });
  });

  // It restores the store from empty, as the last test does.
  it("puts her address on nothing once an export from before the erasure is restored, and keeps it closed for good", async () => {
    const at = await annaAndBob();
    const desk = `Desk ${word()}`;
    const { entities } = await remember(
      at.group,
      [
        {
          key: "d",
          kind: "team",
          names: [desk],
          identifiers: [email(at.local)],
        },
      ],
      [fromApp("d", `${desk} handles invoices ${at.marker}`)]
    );
    const { id: older } = await shared().startExport("test");
    await expect(exportSettled(shared, older)).resolves.toBe("done");
    await erase(at.anna, [email(at.local)]);

    // The store's storage lost, the bucket kept (no tick since the export:
    // its files are still there): the ledger replays the erasure, and the
    // export from before writes nothing of her card or her address.
    const state = await restoredAfterLoss(shared, older, empty);
    const seen = await everything(at.reader, [], [at.name], []);
    const desks = await shared().findEntities({
      reader: at.reader,
      name: desk,
    });
    const deskNames = await Promise.all(
      desks.entities.map(async ({ id }) => {
        const { names } = await shared().readEntityNames({
          entity: id,
          reader: at.reader,
        });
        return names.map(({ value }) => value).toSorted();
      })
    );
    // Written again with her address by an App, as for a new hire: still
    // found by it nowhere.
    await remember(
      at.group,
      [
        {
          key: "n",
          kind: "person",
          names: [`Noor ${word()}`],
          identifiers: [email(at.local)],
        },
      ],
      [fromApp("n", `Noor joins finance ${at.marker}`)]
    );
    const byAddress = await shared().findEntities({
      reader: at.reader,
      identifier: email(at.local),
    });

    expect({
      state,
      seen: [at.name, `${at.local}@acme.test`].filter((needle) =>
        seen.includes(needle)
      ),
      desk: entities.d === undefined ? [] : deskNames,
      byAddress: byAddress.entities.length,
    }).toStrictEqual({
      state: "done",
      seen: [],
      desk: [[desk]],
      byAddress: 0,
    });
  });

  /** Ticks, an hour apart (past a retry's wait), until the restore of `id` is no longer running: its state then. */
  const restoreEnded = async (id: string): Promise<string | undefined> => {
    for (let ticks = 0; ticks < 40; ticks += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      const status = await shared().restoreStatus(id);
      if (status?.state !== "running") {
        return status?.state;
      }
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await tick(shared(), new Date(Date.now() + ticks * 3_600_000));
    }
    return "running";
  };

  /** What is left of her: her name, address, id or relations anywhere a teammate reads, or in a new export's memories. */
  const leftOf = async (at: Awaited<ReturnType<typeof annaAndBob>>) => {
    await tick(shared());
    const seen = await everything(
      at.reader,
      [at.entities.anna, at.entities.bob],
      [at.name],
      [email(at.local)]
    );
    const { id } = await shared().startExport("test");
    await expect(exportSettled(shared, id)).resolves.toBe("done");
    const status = await shared().exportStatus({ id });
    const files = await Promise.all(
      (status?.files ?? []).map(
        async (named) => (await shared().exportFile({ id, file: named })) ?? ""
      )
    );
    const memoryLines = files
      .join("\n")
      .split("\n")
      .filter(
        (line) =>
          line.includes('"kind":"memory"') ||
          line.includes('"kind":"confirmation"')
      )
      .join("\n");
    const needles = [
      at.name,
      `${at.local}@acme.test`,
      at.anna,
      "Bob reports to her",
    ];
    return {
      read: needles.filter((needle) => seen.includes(needle)),
      exported: needles.filter((needle) => memoryLines.includes(needle)),
    };
  };

  // Each restores the store from empty, as the last test does.
  it("refuses a person's erasure while the store restores an export, and erases her whole once the restore is through", async () => {
    const at = await annaAndBob();
    const { id } = await shared().startExport("test");
    await expect(exportSettled(shared, id)).resolves.toBe("done");
    await restore(shared(), empty);
    await shared().startRestore(id, "test");

    const meanwhile = await erase(at.anna, [email(at.local)]).then(
      () => "erased",
      String
    );
    const state = await restoreEnded(id);
    await erase(at.anna, [email(at.local)]);

    expect({ meanwhile, state, left: await leftOf(at) }).toStrictEqual({
      meanwhile: `Error: ${restoringNow}`,
      state: "done",
      left: { read: [], exported: [] },
    });
  });

  it("erases her whole after a rollback to a backup taken while a restore ran, the erasure asked meanwhile", async () => {
    const at = await annaAndBob();
    // More than one part, so the backup is taken with some of it restored.
    for (let more = 0; more < 55; more += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one document after another
      await document(at.group, `Filler ${more} ${at.marker}.`);
    }
    const { id } = await shared().startExport("test");
    await expect(exportSettled(shared, id)).resolves.toBe("done");
    await restore(shared(), empty);
    // The write pass's read of the second part (its second read) fails
    // once, so the restore stops there, its first part written.
    const bucket = env.BRAIN_OBJECTS;
    const held = { reads: 0 };
    Reflect.set(env, "BRAIN_OBJECTS", {
      head: async (key: string) => await bucket.head(key),
      list: async (options: R2ListOptions) => await bucket.list(options),
      put: async (key: string, value: string) => await bucket.put(key, value),
      delete: async (keys: string | string[]) => {
        await bucket.delete(keys);
      },
      get: async (key: string) => {
        if (key.endsWith(`exports/${id}/part-0001.jsonl`)) {
          held.reads += 1;
          if (held.reads === 2) {
            throw new Error("held by the test");
          }
        }
        return await bucket.get(key);
      },
    });
    let backup: Copy | undefined;
    try {
      await shared().startRestore(id, "test");
      for (let ticks = 0; ticks < 10 && held.reads < 2; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one tick after another
        await tick(shared());
      }
      const status = await shared().restoreStatus(id);
      if (status?.state === "running" && status.restored > 0) {
        backup = await copyOf(shared());
      }
    } finally {
      Reflect.set(env, "BRAIN_OBJECTS", bucket);
    }

    const meanwhile = await erase(at.anna, [email(at.local)]).then(
      () => "erased",
      String
    );
    await restore(shared(), backup ?? empty);
    const state = await restoreEnded(id);
    await erase(at.anna, [email(at.local)]);
    // Rolled back to the backup once more, after her erasure: the ledger,
    // replayed, takes her again, and the restore resumes without her.
    await restore(shared(), backup ?? empty);
    const resumed = await restoreEnded(id);

    expect({
      backup: backup !== undefined,
      meanwhile,
      state,
      resumed,
      left: await leftOf(at),
    }).toStrictEqual({
      backup: true,
      meanwhile: `Error: ${restoringNow}`,
      state: "done",
      resumed: "done",
      left: { read: [], exported: [] },
    });
  });

  it("runs a person's erasure once a restore that went nowhere is given up", async () => {
    const at = await annaAndBob();
    const { id } = await shared().startExport("test");
    await expect(exportSettled(shared, id)).resolves.toBe("done");
    await restore(shared(), empty);
    await shared().startRestore(id, "test");
    const meanwhile = await erase(at.anna, [email(at.local)]).then(
      () => "erased",
      String
    );
    // Its item gone, as one parked for good: the tick gives it up.
    await runInDurableObject(shared(), (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM work_items WHERE kind = 'brain.restore'"
      );
    });
    await tick(shared());
    const given = await shared().restoreStatus(id);
    const after = await erase(at.anna, [email(at.local)]).then(
      () => "erased",
      String
    );

    expect({ meanwhile, given: given?.state, after }).toStrictEqual({
      meanwhile: `Error: ${restoringNow}`,
      given: "failed",
      after: "erased",
    });
  });

  it("makes an export being written when her erasure lands stale, and the next holds nothing of her", async () => {
    const at = await annaAndBob();
    const { id } = await shared().startExport("test");
    const writing = await shared().exportStatus({ id });
    await erase(at.anna, [email(at.local)]);
    const state = await exportSettled(shared, id);

    expect({
      writing: writing?.state,
      state,
      left: await leftOf(at),
    }).toStrictEqual({
      writing: "writing",
      state: "erased",
      left: { read: [], exported: [] },
    });
  });

  // Last: it restores the store from empty.
  it("makes stale every export started before it; one from before restored into a store that lost its record writes nothing of them; one after holds nothing of them", async () => {
    const at = await annaAndBob();
    const { id: older } = await shared().startExport("test");
    await expect(exportSettled(shared, older)).resolves.toBe("done");
    const settled = await statusOf(older);
    const [file] = settled?.files ?? [];

    await erase(at.anna, [email(at.local)]);
    const stale = {
      status: await statusOf(older).then((status) => status?.state),
      file: await shared().exportFile({ id: older, file: file ?? "" }),
    };

    // The store's storage lost and put back empty, the bucket kept (no
    // tick since the erasure, so the export's files are still there): the
    // export from before, whose record went with it, is restored by the
    // ledger alone, and the person's entry, replayed first, leaves her out.
    const state = await restoredAfterLoss(shared, older, empty);
    const seen = await everything(at.reader, [], [at.name], [email(at.local)]);
    const atlas = await shared().findEntities({
      reader: at.reader,
      name: `Atlas ${at.marker}`,
    });
    const restored = await shared().readMemories({
      entity: atlas.entities[0]?.id ?? "",
      reader: at.reader,
    });

    const { id: newer } = await shared().startExport("test");
    await expect(exportSettled(shared, newer)).resolves.toBe("done");
    const status = await shared().exportStatus({ id: newer });
    const files = await Promise.all(
      (status?.files ?? []).map(
        async (named) =>
          (await shared().exportFile({ id: newer, file: named })) ?? ""
      )
    );
    const exported = files.join("\n");
    // Her name and address only in the documents' own text, never in a
    // memory, a name or a confirmation; her id nowhere.
    const lines = exported
      .split("\n")
      .filter(
        (line) =>
          line.includes('"kind":"memory"') ||
          line.includes('"kind":"confirmation"')
      );
    expect({
      stale,
      state,
      seen: [at.name, `${at.local}@acme.test`].filter((needle) =>
        seen.includes(needle)
      ),
      restored: restored.memories.map(({ statement, confirmed }) => ({
        statement,
        by: confirmed?.by ?? null,
      })),
      left: await rowsHolding(at.anna),
      newer: status?.state,
      id: exported.includes(at.anna),
      inMemories: [at.name, `${at.local}@acme.test`].filter((needle) =>
        lines.some((line) => line.includes(needle))
      ),
      documents: exported.includes(`${at.local}@acme.test) leads finance`),
    }).toStrictEqual({
      stale: { status: "erased", file: null },
      state: "done",
      seen: [],
      restored: [
        {
          statement: `Atlas has a finance lead ${at.marker}`,
          by: erasedConfirmer,
        },
      ],
      left: {},
      newer: "done",
      id: false,
      inMemories: [],
      documents: true,
    });
  });
});
