// A person's erasure in the shared store and a restore of a company export
// (restore.ts, people.ts; GRA-1747): an erasure recorded while her card is
// not in the store (the store lost, a restore given up or failed) is still
// whole once the export comes back, as the restore finds her cards in the
// export by the identifiers erasures closed before it writes any line.
// Each test restores the store from empty.
import type {
  Identifier,
  NewEntity,
  NewMemory,
  Reader,
} from "@grasp-os/brain-next/contract";
import { restoringNow } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { identifierSubjectOf } from "../src/people.ts";
import type { BrainStore } from "../src/store.ts";
import { exportSettled, tick } from "./export-reads.ts";
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
const email = (local: string): Identifier => ({
  type: "email",
  value: `${local}@acme.test`,
});
const fromApp = (
  about: string,
  statement: string,
  extra: Partial<NewMemory> = {}
): NewMemory => ({
  about,
  type: "fact",
  statement,
  speaker: { kind: "agent", agent: "app:hr" },
  basis: { kind: "writer", writer: "app:hr" },
  ...extra,
});
const erase = async (person: string, identifiers: Identifier[]) => {
  await shared().erasePersonShared({
    person,
    identifiers,
    reason: "person_erased",
  });
};
const erased = async (person: string, identifiers: Identifier[]) =>
  await erase(person, identifiers).then(() => "erased", String);

/**
 * A company's Brain: Anna's card by her name first, her address on it in a
 * later memory, Bob and Carl reporting to her; Greta's card holding Anna's
 * address too; a project holding it; Dora with her own address; and what
 * is no one's.
 */
const world = async () => {
  const group = unique("g");
  const reader: Reader = { person: unique("reader-"), groups: [group] };
  const anna = unique("anna-");
  const dora = unique("dora-");
  const annaLocal = word();
  const doraLocal = word();
  const annaName = `Anna ${word()}`;
  const doraName = `Dora ${word()}`;
  const bobName = `Bob ${word()}`;
  const gretaName = `Greta ${word()}`;
  const projectName = `Audit ${word()}`;
  // A marker for each memory of the world, by what it says.
  const mark = (): string => `mk${word()}`;
  const marker = {
    unrelated: mark(),
    nameOnly: mark(),
    tea: mark(),
    bobReports: mark(),
    address: mark(),
    budgets: mark(),
    carlReports: mark(),
    gretaSales: mark(),
    gretaDesk: mark(),
    projectBudget: mark(),
    projectContact: mark(),
    doraLegal: mark(),
    doraSigns: mark(),
    doraReviews: mark(),
    projectEnds: mark(),
    bobChess: mark(),
  };
  const add = async (entities: NewEntity[], memories: NewMemory[]) =>
    await shared().addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group },
      reader,
      entities,
      memories,
    });
  const first = await add(
    [{ key: "p", kind: "project", names: [projectName] }],
    [fromApp("p", `${projectName} starts ${marker.unrelated}`)]
  );
  const project = first.entities.p ?? "";
  const named = await add(
    [{ key: "a", kind: "person", names: [annaName] }],
    [fromApp("a", `${annaName} is on leave ${marker.nameOnly}`)]
  );
  const annaCard = named.entities.a ?? "";
  const bob = await add(
    [{ key: "b", kind: "person", names: [bobName] }],
    [fromApp("b", `${bobName} plays chess ${marker.bobChess}`)]
  );
  const bobCard = bob.entities.b ?? "";
  await add(
    [{ key: "a", id: annaCard, kind: "person" }],
    [fromApp("a", `${annaName} likes tea ${marker.tea}`)]
  );
  await add(
    [
      { key: "b", id: bobCard, kind: "person" },
      { key: "a", id: annaCard, kind: "person" },
    ],
    [
      fromApp("b", `${bobName} reports to ${annaName} ${marker.bobReports}`, {
        attribute: "manager",
        object: "a",
      }),
    ]
  );
  await add(
    [
      {
        key: "a",
        id: annaCard,
        kind: "person",
        identifiers: [email(annaLocal)],
      },
    ],
    [fromApp("a", `${annaName} leads finance ${marker.address}`)]
  );
  await add(
    [{ key: "a", id: annaCard, kind: "person" }],
    [fromApp("a", `${annaName} approves budgets ${marker.budgets}`)]
  );
  await add(
    [
      { key: "c", kind: "person", names: [`Carl ${word()}`] },
      { key: "a", id: annaCard, kind: "person" },
    ],
    [
      fromApp("c", `Carl reports to ${annaName} ${marker.carlReports}`, {
        attribute: "manager",
        object: "a",
      }),
    ]
  );
  const greta = await add(
    [{ key: "g", kind: "person", names: [gretaName] }],
    [fromApp("g", `${gretaName} runs sales ${marker.gretaSales}`)]
  );
  const gretaCard = greta.entities.g ?? "";
  await add(
    [
      {
        key: "g",
        id: gretaCard,
        kind: "person",
        identifiers: [email(annaLocal)],
      },
    ],
    [fromApp("g", `${gretaName} owns the desk ${marker.gretaDesk}`)]
  );
  await add(
    [{ key: "p", id: project, kind: "project" }],
    [fromApp("p", `${projectName} budget ${marker.projectBudget}`)]
  );
  await add(
    [
      {
        key: "p",
        id: project,
        kind: "project",
        identifiers: [email(annaLocal)],
      },
    ],
    [fromApp("p", `${projectName} contact ${marker.projectContact}`)]
  );
  const legal = await add(
    [{ key: "d", kind: "person", names: [doraName] }],
    [fromApp("d", `${doraName} works in legal ${marker.doraLegal}`)]
  );
  const doraCard = legal.entities.d ?? "";
  await add(
    [
      {
        key: "d",
        id: doraCard,
        kind: "person",
        identifiers: [email(doraLocal)],
      },
    ],
    [fromApp("d", `${doraName} signs ${marker.doraSigns}`)]
  );
  await add(
    [{ key: "d", id: doraCard, kind: "person" }],
    [fromApp("d", `${doraName} reviews ${marker.doraReviews}`)]
  );
  await add(
    [{ key: "p", id: project, kind: "project" }],
    [fromApp("p", `${projectName} ends ${marker.projectEnds}`)]
  );
  return {
    reader,
    anna,
    dora,
    annaLocal,
    doraLocal,
    annaName,
    doraName,
    bobName,
    gretaName,
    projectName,
    marker,
    cards: [annaCard, bobCard, gretaCard, doraCard, project],
  };
};
type World = Awaited<ReturnType<typeof world>>;

const exportNow = async (): Promise<string> => {
  const { id } = await shared().startExport("test");
  await expect(exportSettled(shared, id)).resolves.toBe("done");
  return id;
};

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

/** Starts restoring `id`, and lets it fail before it writes anything: its item gone, settled as failed by the tick. */
const failedRestore = async (id: string): Promise<string | undefined> => {
  await shared().startRestore(id, "test");
  await runInDurableObject(shared(), (_instance, state) => {
    state.storage.sql.exec(
      "DELETE FROM work_items WHERE kind = 'brain.restore'"
    );
  });
  await tick(shared());
  const status = await shared().restoreStatus(id);
  return status?.state;
};

/** What the export `id` serves once a restore of it is through: its state, the files it lists, and a file. */
const servedOf = async (id: string) => {
  const status = await shared().exportStatus({ id });
  const manifest = await shared().exportFile({ id, file: "manifest.json" });
  return { state: status?.state, files: status?.files.length, manifest };
};
const refusedForGood = { state: "erased", files: 0, manifest: null };

/** Every read a teammate makes of the world, as text. */
const reads = async (w: World): Promise<string> => {
  const store = shared();
  const { reader } = w;
  const all = await Promise.all([
    ...w.cards.flatMap((entity) => [
      store.readMemories({ entity, reader, history: true }),
      store.readEntity({ entity, reader }),
      store.readEntityNames({ entity, reader }),
      store.readCard({ entity, reader }),
    ]),
    ...[w.annaName, w.doraName, w.bobName, w.gretaName, w.projectName].map(
      async (name) => await store.findEntities({ reader, name })
    ),
    store.findEntities({ reader, identifier: email(w.annaLocal) }),
    store.findEntities({ reader, identifier: email(w.doraLocal) }),
    store.findEntities({ reader, kind: "person" }),
    store.recall({
      question: `${w.annaName} ${w.doraName} ${w.bobName}`,
      reader,
      budget: { tokens: 4000 },
    }),
  ]);
  return JSON.stringify(all);
};

/** A new export's lines, as text. */
const exported = async (): Promise<string> => {
  const id = await exportNow();
  const status = await shared().exportStatus({ id });
  const files = await Promise.all(
    (status?.files ?? []).map(
      async (file) => (await shared().exportFile({ id, file })) ?? ""
    )
  );
  return files.join("\n");
};

/** The rows of memories and names that hold any of `needles`. */
const rowsHolding = async (needles: readonly string[]): Promise<string[]> =>
  await runInDurableObject(shared(), (_instance, state) =>
    ["memories", "entity_names"]
      .flatMap((table) =>
        state.storage.sql
          .exec(`SELECT * FROM "${table}"`)
          .toArray()
          .flatMap((row) =>
            needles
              .filter((needle) => JSON.stringify(row).includes(needle))
              .map((needle) => `${table}:${needle}`)
          )
      )
      .toSorted()
  );

/** What is left of the erased (Anna, and Dora when `dora`) and of what is no one's, once the tick ran. */
const leftOf = async (w: World, dora: boolean) => {
  await tick(shared());
  await tick(shared());
  const seen = await reads(w);
  const text = await exported();
  const { marker } = w;
  const hers: string[] = [
    marker.nameOnly,
    marker.tea,
    marker.bobReports,
    marker.address,
    marker.budgets,
    marker.carlReports,
    w.annaName,
    w.annaLocal,
    marker.gretaSales,
    marker.gretaDesk,
    w.gretaName,
    ...(dora
      ? [
          marker.doraLegal,
          marker.doraSigns,
          marker.doraReviews,
          w.doraName,
          w.doraLocal,
        ]
      : []),
  ];
  const kept = [
    marker.unrelated,
    marker.projectBudget,
    marker.projectContact,
    marker.projectEnds,
    marker.bobChess,
    w.projectName,
    w.bobName,
  ];
  return {
    seen: hers.filter((needle) => seen.includes(needle)),
    exported: hers.filter((needle) => text.includes(needle)),
    rows: await rowsHolding(hers),
    kept: kept.filter((needle) => !seen.includes(needle)),
    keptExported: kept.filter((needle) => !text.includes(needle)),
  };
};
const gone = {
  seen: [],
  exported: [],
  rows: [],
  kept: [],
  keptExported: [],
};

/**
 * A company's Brain where her address comes late: her card by name, Bob's
 * and Carl's relations to her, then enough of a project's memories to fill
 * a part of an export, then her address on her card and on Greta's.
 */
const lateWorld = async () => {
  const group = unique("g");
  const reader: Reader = { person: unique("reader-"), groups: [group] };
  const local = word();
  const name = `Anna ${word()}`;
  const gretaName = `Greta ${word()}`;
  const filler = `Filler ${word()}`;
  const mark = (): string => `mk${word()}`;
  const marker = {
    nameOnly: mark(),
    bobReports: mark(),
    carlReports: mark(),
    address: mark(),
    gretaDesk: mark(),
    bobChess: mark(),
  };
  const add = async (entities: NewEntity[], memories: NewMemory[]) =>
    await shared().addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group },
      reader,
      entities,
      memories,
    });
  const her = await add(
    [{ key: "a", kind: "person", names: [name] }],
    [fromApp("a", `${name} is on leave ${marker.nameOnly}`)]
  );
  const card = her.entities.a ?? "";
  const bob = await add(
    [
      { key: "b", kind: "person", names: [`Bob ${word()}`] },
      { key: "a", id: card, kind: "person" },
    ],
    [
      fromApp("b", `Bob plays chess ${marker.bobChess}`),
      fromApp("b", `Bob reports to ${name} ${marker.bobReports}`, {
        attribute: "manager",
        object: "a",
      }),
    ]
  );
  await add(
    [
      { key: "c", kind: "person", names: [`Carl ${word()}`] },
      { key: "a", id: card, kind: "person" },
    ],
    [
      fromApp("c", `Carl reports to ${name} ${marker.carlReports}`, {
        attribute: "manager",
        object: "a",
      }),
    ]
  );
  const project = await add(
    [{ key: "f", kind: "project", names: [filler] }],
    [fromApp("f", `${filler} begins`)]
  );
  for (let batch = 0; batch < 6; batch += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one add after another
    await add(
      [{ key: "f", id: project.entities.f ?? "", kind: "project" }],
      Array.from({ length: 90 }, (_, n) =>
        fromApp("f", `${filler} step ${batch} ${n}`)
      )
    );
  }
  await add(
    [{ key: "a", id: card, kind: "person", identifiers: [email(local)] }],
    [fromApp("a", `${name} leads finance ${marker.address}`)]
  );
  await add(
    [
      {
        key: "g",
        kind: "person",
        names: [gretaName],
        identifiers: [email(local)],
      },
    ],
    [fromApp("g", `${gretaName} owns the desk ${marker.gretaDesk}`)]
  );
  return {
    reader,
    anna: unique("anna-"),
    local,
    name,
    marker,
    cards: [card, bob.entities.b ?? "", project.entities.f ?? ""],
    group,
  };
};
type LateWorld = Awaited<ReturnType<typeof lateWorld>>;

/** How many cards a restore's check recorded by `identifier` the store still keeps (`restore_cards`), or by any when none is named. */
const cardsKept = async (identifier?: Identifier): Promise<number> => {
  const subject =
    identifier === undefined ? null : await identifierSubjectOf(identifier);
  return await runInDurableObject(
    shared(),
    (_instance, state) =>
      state.storage.sql
        .exec(
          "SELECT 1 FROM restore_cards WHERE ?1 IS NULL OR subject = ?1",
          subject
        )
        .toArray().length
  );
};

/** What of her any read or raw row of the store shows. */
const herLeft = async (w: LateWorld): Promise<string[]> => {
  const store = shared();
  const { reader } = w;
  const seen = JSON.stringify(
    await Promise.all([
      ...w.cards.flatMap((entity) => [
        store.readMemories({ entity, reader, history: true }),
        store.readEntityNames({ entity, reader }),
        store.readCard({ entity, reader }),
      ]),
      store.findEntities({ reader, name: w.name }),
      store.findEntities({ reader, identifier: email(w.local) }),
      store.findEntities({ reader, kind: "person" }),
      store.recall({ question: w.name, reader, budget: { tokens: 4000 } }),
    ])
  );
  const raw = await runInDurableObject(shared(), (_instance, state) =>
    JSON.stringify([
      ...state.storage.sql.exec("SELECT * FROM memories").toArray(),
      ...state.storage.sql.exec("SELECT * FROM entity_names").toArray(),
    ])
  );
  const needles = [
    w.name,
    w.local,
    w.marker.nameOnly,
    w.marker.bobReports,
    w.marker.carlReports,
    w.marker.address,
    w.marker.gretaDesk,
  ];
  return [
    ...needles
      .filter((needle) => seen.includes(needle))
      .map((n) => `read:${n}`),
    ...needles.filter((needle) => raw.includes(needle)).map((n) => `raw:${n}`),
  ];
};

/**
 * Restores export `id` until its write pass reaches the part holding her
 * address, which never reads then; its item then gone, the tick settles it
 * as failed. The parts before are written.
 */
const failedAtHerAddress = async (
  id: string,
  local: string
): Promise<string | undefined> => {
  const bucket = env.BRAIN_OBJECTS;
  const partReads = new Map<string, number>();
  Reflect.set(env, "BRAIN_OBJECTS", {
    head: async (key: string) => await bucket.head(key),
    list: async (options: R2ListOptions) => await bucket.list(options),
    put: async (key: string, value: string) => await bucket.put(key, value),
    delete: async (keys: string | string[]) => {
      await bucket.delete(keys);
    },
    get: async (key: string) => {
      const object = await bucket.get(key);
      if (key.includes(`exports/${id}/part-`) && object !== null) {
        const text = await object.text();
        const seen = (partReads.get(key) ?? 0) + 1;
        partReads.set(key, seen);
        // Its check reads it once; the write pass's read never gets through.
        if (text.includes(local) && seen >= 2) {
          throw new Error("held by the test");
        }
        return await bucket.get(key);
      }
      return object;
    },
  });
  try {
    await shared().startRestore(id, "test");
    for (let ticks = 0; ticks < 8; ticks += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one tick after another
      await tick(shared());
    }
    await runInDurableObject(shared(), (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM work_items WHERE kind = 'brain.restore'"
      );
    });
    await tick(shared());
    const status = await shared().restoreStatus(id);
    return status?.state;
  } finally {
    Reflect.set(env, "BRAIN_OBJECTS", bucket);
  }
};

describe("a person's erasure and restores", () => {
  /** The shared store before any test of this file added to it: empty. */
  let empty: Copy = { tables: [], others: [] };
  beforeAll(async () => {
    empty = await copyOf(shared());
  });

  describe("a person's erasure and a restore of a company export", () => {
    it("leaves two people out of a restore of an export from before their erasures, which ran on the store emptied by its loss", async () => {
      const w = await world();
      const id = await exportNow();
      await restore(shared(), empty);
      await erase(w.anna, [email(w.annaLocal)]);
      await erase(w.dora, [email(w.doraLocal)]);
      await shared().startRestore(id, "test");
      const state = await restoreEnded(id);
      await tick(shared());

      expect({
        state,
        served: await servedOf(id),
        left: await leftOf(w, true),
      }).toStrictEqual({
        state: "done",
        served: refusedForGood,
        left: gone,
      });
    });

    it("serves no file of an export from before her erasure once it is restored after the store's loss, nor restores it again, and a new export holds nothing of her", async () => {
      const w = await world();
      const id = await exportNow();
      await erase(w.anna, [email(w.annaLocal)]);
      // Lost before any tick: the export's files are still in the bucket.
      await restore(shared(), empty);
      await shared().startRestore(id, "test");
      const state = await restoreEnded(id);
      await tick(shared());

      expect({
        state,
        served: await servedOf(id),
        left: await leftOf(w, false),
      }).toStrictEqual({
        state: "done",
        served: refusedForGood,
        left: gone,
      });
    });

    it("refuses an erasure a restore starts under while it hashes, and erases her whole once the restore is through", async () => {
      const w = await world();
      const id = await exportNow();
      await restore(shared(), empty);
      const realDigest = crypto.subtle.digest.bind(crypto.subtle);
      let started = false;
      const digest = vi
        .spyOn(crypto.subtle, "digest")
        .mockImplementation(async (algorithm, data) => {
          if (!started) {
            started = true;
            await shared().startRestore(id, "test");
          }
          return await realDigest(algorithm, data);
        });
      let meanwhile: string;
      try {
        meanwhile = await erased(w.anna, [email(w.annaLocal)]);
      } finally {
        digest.mockRestore();
      }
      const state = await restoreEnded(id);
      await erase(w.anna, [email(w.annaLocal)]);

      expect({ meanwhile, state, left: await leftOf(w, false) }).toStrictEqual({
        meanwhile: `Error: ${restoringNow}`,
        state: "done",
        left: gone,
      });
    });

    it("leaves her out of a restore started again after one given up at the part holding her address, her erasure run between", async () => {
      const w = await world();
      const id = await exportNow();
      await restore(shared(), empty);
      // The part holding her address never gets through.
      const realDigest = crypto.subtle.digest.bind(crypto.subtle);
      const decoder = new TextDecoder();
      const digest = vi
        .spyOn(crypto.subtle, "digest")
        .mockImplementation(async (algorithm, data) => {
          const bytes = ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
          if (decoder.decode(bytes).includes(w.marker.address)) {
            throw new Error("held by the test");
          }
          return await realDigest(algorithm, data);
        });
      let given: string | undefined;
      try {
        given = await failedRestore(id);
      } finally {
        digest.mockRestore();
      }
      const between = await erased(w.anna, [email(w.annaLocal)]);
      await shared().startRestore(id, "test");
      const state = await restoreEnded(id);

      expect({
        given,
        between,
        state,
        left: await leftOf(w, false),
      }).toStrictEqual({
        given: "failed",
        between: "erased",
        state: "done",
        left: gone,
      });
    });

    it("leaves her out of a failed restore's retry, her erasure run while it had failed before her memories came back", async () => {
      const w = await world();
      const id = await exportNow();
      await restore(shared(), empty);
      const failed = await failedRestore(id);
      const between = await erased(w.anna, [email(w.annaLocal)]);
      await shared().startRestore(id, "test");
      const state = await restoreEnded(id);

      expect({
        failed,
        between,
        state,
        left: await leftOf(w, false),
      }).toStrictEqual({
        failed: "failed",
        between: "erased",
        state: "done",
        left: gone,
      });
    });
  });

  describe("a person's erasure on a store a restore half filled", () => {
    it("takes her card the restore wrote by name only, and it stays gone once the store is used", async () => {
      const w = await lateWorld();
      const id = await exportNow();
      await restore(shared(), empty);
      const failed = await failedAtHerAddress(id, w.local);
      const before = await herLeft(w);
      const recorded = await cardsKept(email(w.local));
      const erasedNow = await erased(w.anna, [email(w.local)]);
      // The cards recorded by her address (hers and Greta's) go with it.
      const keptAfter = await cardsKept(email(w.local));
      await tick(shared());
      await tick(shared());
      const after = await herLeft(w);
      // The store is used: the failed restore can't start again.
      await shared().addMemories({
        change: crypto.randomUUID(),
        access: { kind: "audience", group: w.group },
        reader: w.reader,
        entities: [{ key: "x", kind: "project", names: [`New ${word()}`] }],
        memories: [fromApp("x", `A new project ${word()}`)],
      });
      await tick(shared());
      // Given up for good: no card it recorded is kept.
      const keptUsed = await cardsKept();

      expect({
        failed,
        before: before.length > 0,
        recorded: recorded > 0,
        erasedNow,
        keptAfter,
        keptUsed,
        after,
        used: await herLeft(w),
      }).toStrictEqual({
        failed: "failed",
        before: true,
        recorded: true,
        erasedNow: "erased",
        keptAfter: 0,
        keptUsed: 0,
        after: [],
        used: [],
      });
    });

    it("leaves her out of the failed restore started again after her erasure on the half-filled store", async () => {
      const w = await lateWorld();
      const id = await exportNow();
      await restore(shared(), empty);
      const failed = await failedAtHerAddress(id, w.local);
      const erasedNow = await erased(w.anna, [email(w.local)]);
      await shared().startRestore(id, "test");
      const state = await restoreEnded(id);
      // What a reader sees the moment it is through, before any tick.
      const leftAtDone = await herLeft(w);
      const atDone = leftAtDone.filter((left) => left.startsWith("read:"));
      const keptAtDone = await cardsKept();
      await tick(shared());
      await tick(shared());

      expect({
        failed,
        erasedNow,
        state,
        atDone,
        keptAtDone,
        left: await herLeft(w),
      }).toStrictEqual({
        failed: "failed",
        erasedNow: "erased",
        state: "done",
        atDone: [],
        keptAtDone: 0,
        left: [],
      });
    });
  });
});
