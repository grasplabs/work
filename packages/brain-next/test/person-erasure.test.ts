// A person's erasure in the shared store (erasure.ts `erasePersonShared`,
// people.ts): what the store derived about them and what is in their own
// word goes, the documents stay. The threat model is on GRA-1747. Each
// test has its own people, groups and entities, so what others left in
// the shared store is hidden from it; the export test, which restores the
// store from empty, comes last.
import { erasedConfirmer } from "@grasp-os/brain-next/contract";
import type {
  Identifier,
  NewEntity,
  NewMemory,
  Reader,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

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

  it("on an entity that also holds another identifier, takes only the memories that gave theirs", async () => {
    const group = unique("g");
    const reader: Reader = { person: unique("p"), groups: [group] };
    const anna = unique("anna-");
    const local = word();
    const desk = word();
    const marker = word();
    const { entities } = await remember(
      group,
      [
        {
          key: "box",
          kind: "team",
          names: [`Finance desk ${marker}`],
          identifiers: [email(local), email(desk)],
        },
      ],
      [
        {
          about: "box",
          type: "fact",
          statement: `The desk answers within a day ${marker}`,
          speaker: { kind: "system" },
          basis: { kind: "writer", writer: "app:desk" },
        },
      ]
    );
    const box = entities.box ?? "";
    await remember(
      group,
      [
        {
          key: "box",
          id: box,
          kind: "team",
          names: [`Desk ${marker}`],
          identifiers: [email(desk)],
        },
      ],
      [
        {
          about: "box",
          type: "fact",
          statement: `The desk sits in Utrecht ${marker}`,
          speaker: { kind: "system" },
          basis: { kind: "writer", writer: "app:desk" },
        },
      ]
    );

    await erase(anna, [email(local)]);
    const names = await shared().readEntityNames({ entity: box, reader });

    expect({
      statements: await statementsOf(box, reader),
      names: names.names.map(({ value }) => value).toSorted(),
    }).toStrictEqual({
      statements: [`The desk sits in Utrecht ${marker}`],
      names: [`Desk ${marker}`, `${desk}@acme.test`].toSorted(),
    });
  });

  it("refuses an add naming their identifier, their entity or their word, and adds a colleague's with their first name", async () => {
    const at = await annaAndBob();
    await erase(at.anna, [email(at.local)]);
    const fact = (person: string): NewMemory => ({
      about: "p",
      type: "fact",
      statement: `Again ${at.marker}`,
      speaker: { kind: "internal", person },
      basis: { kind: "writer", writer: "app:hr" },
    });
    expect({
      identifier: await refused(
        async () =>
          await remember(
            at.group,
            [
              {
                key: "p",
                kind: "person",
                names: [at.name],
                identifiers: [email(at.local)],
              },
            ],
            [fact(at.bob)]
          )
      ),
      entity: await refused(
        async () =>
          await remember(
            at.group,
            [{ key: "p", id: at.entities.anna, kind: "person", names: [] }],
            [fact(at.bob)]
          )
      ),
      word: await refused(
        async () =>
          await remember(
            at.group,
            [{ key: "p", kind: "project", names: [`Orion ${at.marker}`] }],
            [fact(at.anna)]
          )
      ),
      colleague: await refused(
        async () =>
          await remember(
            at.group,
            [
              {
                key: "p",
                kind: "person",
                names: [`${at.name.split(" ")[0]} Visser`],
                identifiers: [email(word())],
              },
            ],
            [fact(at.bob)]
          )
      ),
    }).toStrictEqual({
      identifier: "refused",
      entity: "refused",
      word: "refused",
      colleague: "added",
    });
  });

  it("replays after an older copy of the store comes back: what it took stays hidden, the confirmer stays replaced, and the identifier stays closed", async () => {
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
    await tick(shared());
    expect({
      seen: [at.name, `${at.local}@acme.test`, at.anna].filter((needle) =>
        seen.includes(needle)
      ),
      by: atlas.memories.map(({ confirmed }) => confirmed?.by ?? null),
      again,
      left: await rowsHolding(at.anna),
    }).toStrictEqual({
      seen: [],
      by: [erasedConfirmer],
      again: "refused",
      left: {},
    });
    // Repeating it is the same erasure: nothing more, nothing failed.
    await expect(erase(at.anna, [email(at.local)])).resolves.toBeUndefined();
    await restore(shared(), after);
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
