// A person's own export (exports.ts, scope `person`, GRA-1839): what their
// own store holds, which only they may read, written in their store's part
// of the bucket and erased with them. The threat model is on GRA-1839; each
// test names the threat it holds.
import type { Access, Reader } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { fileGraceMs } from "../src/files.ts";
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

  // Threat 6, deterministic: the person erased while a part is being
  // written. The erasure isn't done while the write is under way, and once
  // it is, nothing of the export is left.
  it("is not left behind by a part written while its person is erased", async () => {
    const person = unique();
    await add(person, "Mine alone");
    await start(person);
    const reached = Promise.withResolvers<"reached">();
    const released = Promise.withResolvers<"released">();
    await runInDurableObject(own(person), (instance) => {
      const objectEnv: unknown = Reflect.get(instance, "env");
      if (typeof objectEnv !== "object" || objectEnv === null) {
        throw new TypeError("The store has no env");
      }
      const bucket = env.BRAIN_OBJECTS;
      Reflect.set(instance, "env", {
        ...objectEnv,
        BRAIN_OBJECTS: new Proxy(bucket, {
          get: (target, name) => {
            const method: unknown = Reflect.get(target, name);
            if (typeof method !== "function") {
              return method;
            }
            return async (...args: unknown[]) => {
              if (name === "put" && String(args[0]).includes("/exports/")) {
                reached.resolve("reached");
                await released.promise;
              }
              const result: unknown = await Reflect.apply(method, target, args);
              return result;
            };
          },
        }),
      });
    });
    const ticking = called(tick(own(person)));
    await reached.promise;
    const erase = async (): Promise<string> => {
      const [outcome] = await Promise.allSettled([
        called(own(person).erasePerson({ person, reason: "person_erased" })),
      ]);
      return outcome?.status ?? "none";
    };
    // Recorded and its storage gone; the grace then over, as time passing
    // would: still not done while the part's write is under way.
    const recorded = await erase();
    await ageErasure(person);
    const whileWriting = await erase();
    released.resolve("released");
    await Promise.allSettled([ticking]);
    const once = await erase();
    expect({
      recorded,
      whileWriting,
      once,
      files: await exportKeysOf(person),
    }).toStrictEqual({
      recorded: "rejected",
      whileWriting: "rejected",
      once: "fulfilled",
      files: [],
    });
  });
});
