// A person's own export (exports.ts, scope `person`, GRA-1839): what their
// own store holds, which only they may read, written in their store's part
// of the bucket and erased with them. The threat model is on GRA-1839; each
// test names the threat it holds.
import type { Access, Reader } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { fileGraceMs } from "../src/files.ts";
import { workItemTimeMs } from "../src/work.ts";
import { tick } from "./export-reads.ts";
import type { Store } from "./export-reads.ts";
import { copyOf, restore } from "./store-copy.ts";

const unique = (): string => crypto.randomUUID();
const own = (person: string): Store =>
  env.BRAIN_STORE.getByName(`person:${person}`);
const shared = (): Store => env.BRAIN_STORE.getByName("brain");
const alone = (person: string): Access => ({ kind: "owner", person });
const readerOf = (person: string): Reader => ({ person, groups: [] });

/**
 * An RPC call's answer as a plain promise, awaited: a refused call's
 * rejection is then the test's alone, never left unhandled.
 */
const called = async <T>(rpc: Promise<T>): Promise<T> => await rpc;

/** The SHA-256 of `text`, in hex. */
const sha256 = async (text: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** The keys of `person`'s exports' files in the bucket, as listed. */
const exportKeysOf = async (person: string): Promise<string[]> => {
  const listed = await env.BRAIN_OBJECTS.list({
    prefix: `people/${await sha256(person)}/exports/`,
  });
  return listed.objects.map(({ key }) => key);
};

/** Adds `text` as a source of `person`'s own: its key. */
const add = async (
  person: string,
  text: string,
  source = `test:${unique()}`
): Promise<string> => {
  await own(person).addSource({
    source,
    change: unique(),
    text,
    access: alone(person),
  });
  return source;
};

/** Starts `person`'s own export: its id. */
const start = async (person: string): Promise<string> => {
  const { id } = await own(person).startOwnExport({
    person,
    deployment: "test",
  });
  return id;
};

/**
 * Ticks `person`'s store until its export is no longer being written (at
 * most 40 ticks): what it shows them then.
 */
const settled = async (person: string) => {
  let status = await own(person).ownExport({ person });
  for (let ticks = 0; ticks < 40 && status?.state === "writing"; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await tick(own(person));
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    status = await own(person).ownExport({ person });
  }
  return status;
};

const lineSchema = z.looseObject({
  kind: z.string().optional(),
  source: z.string().nullable().optional(),
  text: z.string().optional(),
  statement: z.string().optional(),
  access: z
    .looseObject({ kind: z.string(), person: z.string().optional() })
    .optional(),
});
type Line = z.infer<typeof lineSchema>;

const manifestSchema = z.looseObject({
  scope: z.string(),
  versions: z.int(),
  memories: z.int(),
  parts: z.array(z.looseObject({ file: z.string() })),
});

/** The manifest and every line of `person`'s done export `id`, read as they would download it. */
const downloaded = async (
  person: string,
  id: string
): Promise<{ manifest: z.infer<typeof manifestSchema>; lines: Line[] }> => {
  const text = await own(person).ownExportFile({
    person,
    id,
    file: "manifest.json",
  });
  const manifest = manifestSchema.parse(JSON.parse(text ?? "null"));
  const lines: Line[] = [];
  for (const { file } of manifest.parts) {
    // oxlint-disable-next-line no-await-in-loop -- a part at a time
    const body = await own(person).ownExportFile({ person, id, file });
    for (const line of (body ?? "").split("\n").filter(Boolean)) {
      lines.push(lineSchema.parse(JSON.parse(line)));
    }
  }
  return { manifest, lines };
};

/**
 * The record of `person`'s erasure moved back past the grace an add has to
 * write its file (files.ts `fileGraceMs`), as time passing would.
 */
const ageErasure = async (person: string): Promise<void> => {
  const key = `people/${await sha256(person)}/erased`;
  const record = await env.BRAIN_OBJECTS.get(key);
  const { reason, at } = z
    .object({ reason: z.string(), at: z.number() })
    .parse(JSON.parse((await record?.text()) ?? "null"));
  await env.BRAIN_OBJECTS.put(
    key,
    JSON.stringify({ reason, at: at - fileGraceMs - 1 })
  );
};

/** `person`'s store erased whole, as its caller erases it: again once the add grace is over. */
const eraseWhole = async (person: string): Promise<void> => {
  await Promise.allSettled([
    called(own(person).erasePerson({ person, reason: "person_erased" })),
  ]);
  await ageErasure(person);
  await own(person).erasePerson({ person, reason: "person_erased" });
};

/** How often `until` looks, and how many times before it gives up: 10 s. */
const untilEveryMs = 20;
const untilLooks = 500;

/**
 * Waits until `open` says so, failing with `what` after 10 s, by the
 * runtime's `scheduler.wait`, which faked timers leave real.
 */
const until = async (open: () => boolean, what: string): Promise<void> => {
  for (let look = 0; !open(); look += 1) {
    if (look === untilLooks) {
      throw new Error(`Waited 10 s for ${what}`);
    }
    // oxlint-disable-next-line no-await-in-loop -- until released
    await scheduler.wait(untilEveryMs);
  }
};

/**
 * How long the queue waits for an export's run before it stops waiting:
 * its time and the grace after it (work.ts `runItem`), and a second more.
 */
const pastTheQueuesWaitMs = workItemTimeMs + 30_000 + 1000;

/**
 * Has `person`'s store reach the bucket through one that holds the first
 * write of an export's file named `file` (the others go through): it moves the faked timers (the store's too,
 * in this isolate) on past the queue's wait, so the queue stops waiting
 * for the run that asked it, and lands only once released. Answers how to
 * release it, and whether it landed.
 */
const holdExportWrite = async (person: string, file: string) => {
  /** Every export file put, by its name, in order. */
  const puts: string[] = [];
  const state: {
    held: boolean;
    released: boolean;
    puts: string[];
    /** The held write, as R2 would take it: the test lands it. */
    write?: { key: string; value: ArrayBuffer | string };
  } = { held: false, released: false, puts };
  const real = env.BRAIN_OBJECTS;
  const bucket = {
    get: async (key: string) => await real.get(key),
    head: async (key: string) => await real.head(key),
    list: async (options?: R2ListOptions) => await real.list(options),
    delete: async (keys: string | string[]) => {
      await real.delete(keys);
    },
    put: async (
      key: string,
      value: ArrayBuffer | string,
      options?: R2PutOptions
    ) => {
      if (key.includes("/exports/")) {
        state.puts.push(key.slice(key.lastIndexOf("/") + 1));
      }
      if (state.held || !key.includes("/exports/") || !key.endsWith(file)) {
        return await real.put(key, value, options);
      }
      state.held = true;
      state.write = { key, value };
      await vi.advanceTimersByTimeAsync(pastTheQueuesWaitMs);
      // Its answer never comes: by the time it would, its instance was
      // ended. The test lands its bytes (`landHeld`), as R2 may.
      await until(() => state.released, "the test to release an export write");
      throw new Error("Its instance was ended before R2 answered");
    },
  };
  await runInDurableObject(own(person), (instance) => {
    Reflect.set(instance, "env", { ...env, BRAIN_OBJECTS: bucket });
  });
  return state;
};

/**
 * The held write landed in the bucket as it was sent: R2 completing a
 * request whose instance was ended meanwhile.
 */
const landHeld = async (held: {
  released: boolean;
  write?: { key: string; value: ArrayBuffer | string };
}): Promise<void> => {
  if (held.write === undefined) {
    throw new Error("No write was held");
  }
  held.released = true;
  await env.BRAIN_OBJECTS.put(held.write.key, held.write.value);
};

/** Each of `person`'s erasures' outcome, called once. */
const erasureOf = async (person: string): Promise<string> => {
  const [outcome] = await Promise.allSettled([
    called(own(person).erasePerson({ person, reason: "person_erased" })),
  ]);
  return outcome?.status ?? "none";
};

describe("a person's own export", () => {
  // Threat 3: it holds all their store keeps, and nothing of anyone else.
  it("holds their sources' every version, their memories with the entities they name, and nothing anyone else may read", async () => {
    const person = unique();
    const source = await add(person, "First words, mine alone");
    await add(person, "Second words, mine alone", source);
    const other = await add(person, "Other words, mine alone");
    const { entities, memories } = await own(person).addMemories({
      change: unique(),
      access: alone(person),
      entities: [{ key: "c", kind: "customer", names: ["Acme", "Acme BV"] }],
      memories: [
        {
          about: "c",
          type: "fact",
          statement: "Acme is mine to remember",
          speaker: { kind: "system" },
          basis: { kind: "writer", writer: person },
        },
      ],
    });
    await own(person).confirmMemory({
      memory: memories[0] ?? "",
      reader: readerOf(person),
    });
    // What the company holds, and another person's own, are elsewhere.
    const group = `team:${unique()}`;
    await shared().addSource({
      source: `test:${unique()}`,
      change: unique(),
      text: "The team's words",
      access: { kind: "audience", group },
    });
    const stranger = unique();
    await add(stranger, "A stranger's words");

    const id = await start(person);
    const status = await settled(person);
    const { manifest, lines } = await downloaded(person, id);

    expect({
      state: status?.state,
      scope: manifest.scope,
      counts: [manifest.versions, manifest.memories],
      sources: lines
        .filter(({ kind }) => kind === undefined)
        .map(({ source: of, text }) => [of, text]),
      memories: lines
        .filter(({ kind }) => kind === "memory")
        .map(({ statement }) => statement),
      kinds: lines.map(({ kind }) => kind ?? "version").toSorted(),
      readers: [
        ...new Set(
          lines.flatMap(({ access }) =>
            access === undefined ? [] : [JSON.stringify(access)]
          )
        ),
      ],
      entityNamed: JSON.stringify(lines).includes(entities.c ?? "-"),
    }).toStrictEqual({
      state: "done",
      scope: "person",
      counts: [3, 3],
      sources: [
        [source, "First words, mine alone"],
        [source, "Second words, mine alone"],
        [other, "Other words, mine alone"],
      ],
      memories: ["Acme is mine to remember"],
      kinds: [
        "change",
        "confirmation",
        "memory",
        "version",
        "version",
        "version",
      ],
      readers: [JSON.stringify(alone(person))],
      entityNamed: true,
    });
  });

  // Threats 1 and 2: only they start or read it; anyone else, and the
  // shared store, are refused, and what isn't theirs answers as absent.
  it("is started and read by its person alone, and an id it doesn't hold answers as nothing", async () => {
    const person = unique();
    const stranger = unique();
    await add(person, "Mine alone");
    const id = await start(person);
    await settled(person);
    const refusals = await Promise.allSettled([
      called(
        own(person).startOwnExport({ person: stranger, deployment: "test" })
      ),
      called(own(person).ownExport({ person: stranger })),
      called(
        own(person).ownExportFile({
          person: stranger,
          id,
          file: "manifest.json",
        })
      ),
      called(shared().startOwnExport({ person, deployment: "test" })),
      called(shared().ownExport({ person })),
      called(shared().ownExportFile({ person, id, file: "manifest.json" })),
      called(own(person).exportStatus({ id })),
      called(own(person).exportFile({ id, file: "manifest.json" })),
    ]);
    const why = [
      "answers only the person whose it is",
      "only a person's own store takes this",
      "only the shared store takes this",
    ];
    expect(
      refusals.map((outcome) =>
        outcome.status === "rejected"
          ? why.find((words) => String(outcome.reason).includes(words))
          : "answered"
      )
    ).toStrictEqual([
      why[0],
      why[0],
      why[0],
      why[1],
      why[1],
      why[1],
      why[2],
      why[2],
    ]);

    // Another person's export id, asked of their own store: absent.
    await add(stranger, "Theirs alone");
    const theirs = await start(stranger);
    await settled(stranger);
    await expect(
      own(person).ownExportFile({ person, id: theirs, file: "manifest.json" })
    ).resolves.toBeNull();
    await expect(
      own(person).ownExportFile({ person, id, file: "part-0009.jsonl" })
    ).resolves.toBeNull();
  });

  it("answers what it is while written, nothing before any, and says so of a store that never kept anything", async () => {
    const person = unique();
    await expect(own(person).ownExport({ person })).resolves.toBeNull();
    const id = await start(person);
    // Started again while written: the same one.
    await expect(start(person)).resolves.toBe(id);
    const writing = await own(person).ownExport({ person });
    await expect(
      own(person).ownExportFile({ person, id, file: "manifest.json" })
    ).resolves.toBeNull();
    const done = await settled(person);
    const { manifest } = await downloaded(person, id);
    expect({
      writing: writing?.state,
      done: done?.state,
      files: done?.files,
      held: [manifest.versions, manifest.memories, manifest.parts.length],
    }).toStrictEqual({
      writing: "writing",
      done: "done",
      files: ["manifest.json"],
      held: [0, 0, 0],
    });
  });

  // The company export's rule: a newer one done replaces the older.
  it("is replaced once a newer one is done, its files deleted", async () => {
    const person = unique();
    await add(person, "Mine alone");
    const first = await start(person);
    await settled(person);
    const second = await start(person);
    const shown = await settled(person);
    await tick(own(person));
    await tick(own(person));
    const keys = await exportKeysOf(person);
    expect({
      shown: [shown?.id, shown?.state],
      first: keys.some((key) => key.includes(first)),
      second: keys.some((key) => key.includes(second)),
    }).toStrictEqual({
      shown: [second, "done"],
      first: false,
      second: true,
    });
  });

  // Threat 5: stale exactly when the ledger names what it holds.
  it("is erased once their ledger names what it holds, never served, its files deleted; an erasure of anything else leaves it be", async () => {
    const person = unique();
    await add(person, "Kept words");
    const erased = await add(person, "Erased words");
    const id = await start(person);
    await settled(person);
    const unrelated = await add(person, "Added after the export");
    await own(person).eraseSource({ source: unrelated, reason: "retention" });
    await tick(own(person));
    const afterUnrelated = await own(person).ownExport({ person });

    await own(person).eraseSource({ source: erased, reason: "retention" });
    const afterErased = await own(person).ownExport({ person });
    const served = await own(person).ownExportFile({
      person,
      id,
      file: "manifest.json",
    });
    await tick(own(person));
    await tick(own(person));
    expect({
      afterUnrelated: afterUnrelated?.state,
      afterErased: afterErased?.state,
      served,
      files: await exportKeysOf(person),
    }).toStrictEqual({
      afterUnrelated: "done",
      afterErased: "erased",
      served: null,
      files: [],
    });
  });

  // Threat 6 and the acceptance criterion: erasing the person leaves no
  // file of it, by listing the bucket, also after their store's storage
  // was lost.
  it("leaves no file in the bucket once its person is erased, also after a storage loss", async () => {
    const person = unique();
    await add(person, "Mine alone");
    await start(person);
    await settled(person);
    const before = await exportKeysOf(person);
    await eraseWhole(person);
    const erased = await exportKeysOf(person);

    const lost = unique();
    const empty = await copyOf(own(lost));
    await add(lost, "Lost with the storage");
    await start(lost);
    await settled(lost);
    await restore(own(lost), empty);
    const afterLoss = await exportKeysOf(lost);
    await eraseWhole(lost);
    expect({
      before: before.length > 0,
      erased,
      afterLoss: afterLoss.length > 0,
      lostErased: await exportKeysOf(lost),
      shown: await own(lost).ownExport({ person: lost }),
    }).toStrictEqual({
      before: true,
      erased: [],
      afterLoss: true,
      lostErased: [],
      shown: null,
    });
  });

  // After a storage loss with nothing erased, the sweep judges the files
  // by the person's own ledger, as the company's: kept while nothing they
  // hold is erased, dropped once something is.
  it("keeps the files its store lost track of while nothing they hold is erased, and drops them once something is", async () => {
    const person = unique();
    const empty = await copyOf(own(person));
    const source = await add(person, "Mine alone");
    await start(person);
    await settled(person);
    await restore(own(person), empty);
    // Something else erased: a sweep passes over the files and keeps them.
    const other = await add(person, "Something else");
    await own(person).eraseSource({ source: other, reason: "retention" });
    for (let ticks = 0; ticks < 4; ticks += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a tick at a time
      await tick(own(person));
    }
    const kept = await exportKeysOf(person);
    await own(person).eraseSource({ source, reason: "retention" });
    for (let ticks = 0; ticks < 4; ticks += 1) {
      // oxlint-disable-next-line no-await-in-loop -- a tick at a time
      await tick(own(person));
    }
    expect({
      kept: kept.length > 0,
      dropped: await exportKeysOf(person),
    }).toStrictEqual({ kept: true, dropped: [] });
  });

  // GRA-1839 review: a run the queue stopped waiting for (past its time
  // and grace) still runs, and may still write, each of its files. The
  // erasure isn't done while it runs; past the erasure's grace it restarts
  // the store, which ends it; and the next instance reports done only once
  // it has been up for an item's time, so a write the ended one sent and
  // that lands after the restart is deleted before done.
  it.each(["holds.json", "part-0000.jsonl", "manifest.json"])(
    "leaves nothing once erased as done, though a write of its %s the queue stopped waiting for lands after the store restarted",
    async (file) => {
      const person = unique();
      await add(person, "Mine alone");
      await start(person);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const write = await holdExportWrite(person, file);
        // The tick ends once the queue stops waiting for the held run.
        await tick(own(person));
        const before = write.puts.length;
        const recorded = await erasureOf(person);
        await ageErasure(person);
        // Past the grace, the run still counted: the store restarts.
        const restarting = await erasureOf(person);
        await landHeld(write);
        const landed = await exportKeysOf(person);
        const tooSoon = await erasureOf(person);
        vi.setSystemTime(Date.now() + workItemTimeMs);
        const done = await erasureOf(person);
        expect({
          held: write.held,
          recorded,
          restarting,
          tooSoon,
          done,
          landed: landed.some((key) => key.endsWith(file)),
          // Once its store was erased, the run starts no other put.
          putSince: write.puts.slice(before),
          files: await exportKeysOf(person),
        }).toStrictEqual({
          held: true,
          recorded: "rejected",
          restarting: "rejected",
          landed: true,
          tooSoon: "rejected",
          done: "fulfilled",
          putSince: [],
          files: [],
        });
      } finally {
        vi.useRealTimers();
      }
    }
  );

  // A run whose write never returns: past the erasure's grace the erasure
  // restarts the store itself, and ends done with nothing in the bucket.
  it("is erased whole though a write of it never returns: the erasure restarts the store itself", async () => {
    const person = unique();
    await add(person, "Mine alone");
    await start(person);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const write = await holdExportWrite(person, "holds.json");
      await tick(own(person));
      const recorded = await erasureOf(person);
      await ageErasure(person);
      const restarting = await erasureOf(person);
      const tooSoon = await erasureOf(person);
      vi.setSystemTime(Date.now() + workItemTimeMs);
      const done = await erasureOf(person);
      expect({
        held: write.held,
        recorded,
        restarting,
        tooSoon,
        done,
        files: await exportKeysOf(person),
      }).toStrictEqual({
        held: true,
        recorded: "rejected",
        restarting: "rejected",
        tooSoon: "rejected",
        done: "fulfilled",
        files: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
