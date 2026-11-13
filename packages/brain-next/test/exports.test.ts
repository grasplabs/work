// Exports and restores (exports.ts, restore.ts, GRA-1755): a company's
// Brain written as checked files in its own bucket and read back into an
// empty store. A person's own store refuses both. The threat model is on
// GRA-1755; each test names the threats it holds. Every test has sources,
// people and teams of its own; the restores empty the shared store first,
// as a store whose storage was lost, its bucket kept.
import type {
  Access,
  AskModel,
  Embedders,
  HandOvers,
  Reader,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { exportFileNameSchema } from "../src/contract.ts";
import {
  exportPartBytes,
  manifestSchema as storeManifestSchema,
} from "../src/exports.ts";
import type { BrainStore } from "../src/store.ts";
import { workParksMax } from "../src/work.ts";

type Store = DurableObjectStub<BrainStore>;

const shared = (): Store => env.BRAIN_STORE.getByName("brain");
const own = (person: string): Store =>
  env.BRAIN_STORE.getByName(`person:${person}`);

const quietAsk: AskModel = async () => {
  await Promise.resolve();
  return { kind: "answer", text: "" };
};

/** No hand-overs: these tests hand nothing over. */
const noHandOvers: HandOvers = {
  handOver: async () => {
    await Promise.resolve();
    return { kind: "nothing" };
  },
};

const noEmbedders: Embedders = {
  model: null,
  embed: async () => {
    await Promise.resolve();
    return { kind: "unavailable" };
  },
};

/** One tick of `store`, as the host's clock (or a person's own alarm) gives it. */
const tick = async (store: Store): Promise<void> => {
  await store.work({
    ask: quietAsk,
    at: new Date(),
    embedders: noEmbedders,
    handOvers: noHandOvers,
    contextTokens: null,
  });
};

const unique = (): string => crypto.randomUUID();

/** An RPC call awaited in a plain promise, so its refusal is the assertion's alone. */
const called = async <T>(rpc: Promise<T>): Promise<T> => await rpc;

const team = (name: string): Access => ({ kind: "audience", group: name });
const alone = (person: string): Access => ({ kind: "owner", person });
const readerOf = (person: string, groups: string[] = []): Reader => ({
  person,
  groups,
});

/** Adds `text` to `store` as change `change` of `source`. */
const add = async (
  store: Store,
  source: string,
  text: string,
  access: Access,
  change = "1"
): Promise<void> => {
  await store.addSource({ source, change, text, access });
};

/** Ticks `store` until the export `id` is no longer being written: at most 10 ticks. */
const settled = async (store: Store, id: string) => {
  for (let ticks = 0; ticks < 10; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await tick(store);
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    const status = await store.exportStatus({ id });
    if (status?.state !== "writing") {
      return status;
    }
  }
  throw new Error("The export was still being written after 10 ticks");
};

const sha256 = async (text: string): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");

const manifestSchema = z.object({
  versions: z.number(),
  parts: z.array(
    z.object({
      file: z.string(),
      sha256: z.string(),
      versions: z.number(),
      bytes: z.number(),
    })
  ),
});

const lineSchema = z.object({
  source: z.string(),
  version: z.number(),
  access: z.unknown(),
  current: z.boolean(),
  indexed: z.boolean(),
  changes: z.array(z.string()),
  text: z.string(),
});
type Line = z.infer<typeof lineSchema>;

/**
 * Every line of the done export `id`, read through `exportFile`, each part
 * checked against the manifest's SHA-256 and count.
 */
const linesOf = async (store: Store, id: string): Promise<Line[]> => {
  const manifestText = await store.exportFile({ id, file: "manifest.json" });
  if (manifestText === null) {
    throw new Error("No manifest");
  }
  const manifest = manifestSchema.parse(JSON.parse(manifestText));
  const lines: Line[] = [];
  for (const part of manifest.parts) {
    // oxlint-disable-next-line no-await-in-loop -- a part at a time
    const body = await store.exportFile({ id, file: part.file });
    if (body === null) {
      throw new Error("A part is missing");
    }
    // oxlint-disable-next-line no-await-in-loop -- a part at a time
    await expect(sha256(body)).resolves.toBe(part.sha256);
    const parsed = body
      .trimEnd()
      .split("\n")
      .map((line) => lineSchema.parse(JSON.parse(line)));
    expect(parsed).toHaveLength(part.versions);
    lines.push(...parsed);
  }
  expect(lines).toHaveLength(manifest.versions);
  return lines;
};

/** What `lines` hold of `sources`, as source, version, current and text. */
const of = (lines: readonly Line[], sources: readonly string[]) =>
  lines
    .filter(({ source }) => sources.includes(source))
    .map(({ source, version, current, text, access, indexed, changes }) => ({
      source,
      version,
      current,
      text,
      access,
      indexed,
      changes,
    }))
    .toSorted((a, b) =>
      a.source === b.source
        ? a.version - b.version
        : a.source.localeCompare(b.source)
    );

/** The keys in the bucket under `prefix`. */
const keysUnder = async (prefix: string): Promise<string[]> => {
  const { objects } = await env.BRAIN_OBJECTS.list({ prefix });
  return objects.map(({ key }) => key);
};

/** A row of a table. */
type Row = Record<string, SqlStorageValue>;

/** Every table's rows: a copy of the store as it was. */
type Copy = { name: string; rows: Row[] }[];

/** Tables a table of the store makes itself (the word indexes' pages). */
// Every full-text index's own pages, whichever index: its table writes
// them.
const madeByAnother =
  /^(?:sqlite_|_cf_|(?:chunk|memory|source)_(?:words|stems)_)/u;

const copyOf = async (store: Store): Promise<Copy> =>
  await runInDurableObject(store, (_instance, state) =>
    state.storage.sql
      .exec<{ name: string; sql: string }>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table'"
      )
      .toArray()
      .filter(({ name }) => !madeByAnother.test(name))
      .map(({ name, sql: created }) => ({
        name,
        rows: state.storage.sql
          .exec<Row>(
            created.startsWith("CREATE VIRTUAL TABLE")
              ? `SELECT rowid AS rowid, * FROM "${name}"`
              : `SELECT * FROM "${name}"`
          )
          .toArray(),
      }))
  );

/**
 * `copy` put back as the store's every row, as a restore of its storage
 * would, the bucket untouched, and the store killed, as a restore restarts
 * it: so a store copied empty holds nothing again, its record of erasures
 * included, and reads its ledger from the bucket as it starts.
 */
const putBack = async (store: Store, copy: Copy): Promise<void> => {
  await runInDurableObject(store, (_instance, state) => {
    const { sql } = state.storage;
    state.storage.transactionSync(() => {
      sql.exec("PRAGMA defer_foreign_keys = ON");
      const triggers = sql
        .exec<{ name: string; sql: string }>(
          "SELECT name, sql FROM sqlite_master WHERE type = 'trigger'"
        )
        .toArray();
      for (const { name } of triggers) {
        sql.exec(`DROP TRIGGER "${name}"`);
      }
      for (const { name } of copy) {
        sql.exec(`DELETE FROM "${name}"`);
      }
      for (const { name, rows } of copy) {
        for (const row of rows) {
          const columns = Object.keys(row);
          sql.exec(
            `INSERT INTO "${name}" (${columns.map((column) => `"${column}"`).join(", ")})
            VALUES (${columns.map(() => "?").join(", ")})`,
            ...Object.values(row)
          );
        }
      }
      for (const { sql: created } of triggers) {
        sql.exec(created);
      }
    });
  });
  try {
    await runInDurableObject(store, (_instance, state) => {
      state.abort("Restored by the test");
    });
  } catch {
    // The kill ends the call it was made in.
  }
};

/** The R2 calls the store makes, passed through to the test's bucket. */
const r2Calls = ["get", "head", "put", "delete", "list"] as const;

/** Waits, polling on this context's own timers, until `done` says so: at most 10 s. */
const until = async (done: () => boolean, what: string): Promise<void> => {
  for (let waited = 0; !done(); waited += 10) {
    if (waited >= 10_000) {
      throw new Error(`Still waiting for ${what} after 10 s`);
    }
    // oxlint-disable-next-line no-await-in-loop -- a poll, bounded above
    await scheduler.wait(10);
  }
};

/**
 * `store`'s bucket swapped for one that holds each read of a key `holds`
 * takes until `release`, and says when one is held (`reached`): so an
 * erasure can land, deterministically, while the store waits for that
 * read. Each side waits on flags in shared memory with its own timers, as
 * a promise resolved from another request's context may never wake the
 * store's.
 */
const holdingBucket = async (
  store: Store,
  holds: (key: string) => boolean,
  call: (typeof r2Calls)[number] = "get"
): Promise<{
  reached: () => Promise<void>;
  release: () => void;
  heal: () => Promise<void>;
}> => {
  const bucket = env.BRAIN_OBJECTS;
  const through = async (name: string, args: unknown[]): Promise<unknown> => {
    const method: unknown = Reflect.get(bucket, name);
    if (typeof method !== "function") {
      throw new TypeError(`R2 has no ${name}`);
    }
    const result: unknown = await Reflect.apply(method, bucket, args);
    return result;
  };
  const flags = { reached: false, released: false };
  const swapped = Object.fromEntries(
    r2Calls.map((name) => [
      name,
      async (...args: unknown[]) => {
        const [key] = args;
        if (name === call && typeof key === "string" && holds(key)) {
          flags.reached = true;
          await until(() => flags.released, "the read's release");
        }
        return await through(name, args);
      },
    ])
  );
  const swap = async (to: unknown): Promise<void> => {
    await runInDurableObject(store, (instance) => {
      const objectEnv: unknown = Reflect.get(instance, "env");
      if (typeof objectEnv !== "object" || objectEnv === null) {
        throw new TypeError("The store has no env");
      }
      Reflect.set(instance, "env", { ...objectEnv, BRAIN_OBJECTS: to });
    });
  };
  await swap(swapped);
  return {
    reached: async () => {
      await until(() => flags.reached, "the read to be held");
    },
    release: () => {
      flags.released = true;
    },
    heal: async () => {
      flags.released = true;
      await swap(bucket);
    },
  };
};

/**
 * `store`'s bucket swapped for one that, at the `nth` call `call` of `key`
 * (before or after it lands), never answers, as a store that stopped there:
 * `reached` says when. The test then stops the store.
 */
const stoppingBucket = async (
  store: Store,
  call: (typeof r2Calls)[number],
  key: string,
  nth: number,
  before: boolean
): Promise<{ reached: () => boolean }> => {
  const flags = { reached: false, seen: 0 };
  const bucket = env.BRAIN_OBJECTS;
  const through = async (name: string, args: unknown[]): Promise<unknown> => {
    const method: unknown = Reflect.get(bucket, name);
    if (typeof method !== "function") {
      throw new TypeError(`R2 has no ${name}`);
    }
    const result: unknown = await Reflect.apply(method, bucket, args);
    return result;
  };
  const stopsHere = async (): Promise<void> => {
    flags.reached = true;
    await until(() => false, "a store that stopped");
  };
  await runInDurableObject(store, (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The store has no env");
    }
    const swapped = Object.fromEntries(
      r2Calls.map((name) => [
        name,
        async (...args: unknown[]) => {
          const hit = name === call && args[0] === key;
          if (hit) {
            flags.seen += 1;
          }
          const here = hit && flags.seen === nth;
          if (here && before) {
            await stopsHere();
          }
          const result = await through(name, args);
          if (here && !before) {
            await stopsHere();
          }
          return result;
        },
      ])
    );
    Reflect.set(instance, "env", { ...objectEnv, BRAIN_OBJECTS: swapped });
  });
  return { reached: () => flags.reached };
};

/** Stops `store`, as a crash or a deploy would. */
const stop = async (store: Store): Promise<void> => {
  try {
    await runInDurableObject(store, (_instance, state) => {
      state.abort("Stopped by the test");
    });
  } catch {
    // The kill ends the call it was made in.
  }
};

/** Ticks the shared store until the restore of `id` is no longer running: at most 10 ticks. */
const restoreSettled = async (id: string) => {
  for (let ticks = 0; ticks < 10; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await tick(shared());
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    const status = await shared().restoreStatus(id);
    if (status?.state !== "running") {
      return status;
    }
  }
  throw new Error("The restore was still running after 10 ticks");
};

/** How many versions the shared store holds. */
const versionsHeld = async (): Promise<number> =>
  await runInDurableObject(
    shared(),
    (_instance, state) =>
      state.storage.sql
        .exec<{ count: number }>(
          "SELECT count(*) AS count FROM source_versions"
        )
        .one().count
  );

/**
 * Starts restoring `id` into the shared store and takes its item off the
 * queue before any part is checked, as an outage or a throw that parks it
 * for good would: then ticks twice, so the tick settles it.
 */
const startedAndStopped = async (id: string): Promise<void> => {
  await shared().startRestore(id, "test");
  await runInDurableObject(shared(), (_instance, state) => {
    state.storage.sql.exec(
      "DELETE FROM work_items WHERE kind = 'brain.restore' AND key = ?",
      `restore:${id}`
    );
  });
  await tick(shared());
  await tick(shared());
};

/**
 * The files of `files` (keys under `exports/<id>/`) the shared store
 * serves, of those a download may ask for.
 */
const servedOf = async (id: string, files: readonly string[]) => {
  const served: string[] = [];
  for (const key of files) {
    const file = key.slice(`exports/${id}/`.length);
    if (!exportFileNameSchema.safeParse(file).success) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one file at a time
    if ((await shared().exportFile({ id, file })) !== null) {
      served.push(file);
    }
  }
  return served;
};

describe("exports and restores", () => {
  /** The shared store as it was before any test added to it: empty. */
  let emptyShared: Copy = [];

  beforeAll(async () => {
    emptyShared = await copyOf(shared());
  });

  describe("a company's export", { timeout: 60_000 }, () => {
    it("holds every version a group may read, with its readers and history, and nothing one person alone, or no one known, may read (threats 4, 5)", async () => {
      const teamSource = `test:${unique()}`;
      const nobodys = `test:${unique()}`;
      const theirs = `test:${unique()}`;
      const wasTeams = `test:${unique()}`;
      const instructions = `instructions:${unique()}`;
      const person = unique();
      const group = `team:${unique()}`;
      await add(shared(), teamSource, "first words", team(group));
      await add(shared(), teamSource, "second words", team(group), "2");
      await add(shared(), nobodys, "nobody's words", { kind: "none" });
      await add(shared(), theirs, "their own words", alone(person));
      await add(shared(), wasTeams, "a team's words", team(group));
      await add(shared(), wasTeams, "now theirs alone", alone(person), "2");
      await shared().addInstructions({
        source: instructions,
        change: "1",
        text: "the company's instructions",
        access: team(group),
      });

      const { id } = await shared().startExport("test");
      await expect(settled(shared(), id)).resolves.toMatchObject({
        state: "done",
      });
      const lines = await linesOf(shared(), id);

      expect(
        of(lines, [teamSource, nobodys, theirs, wasTeams, instructions])
      ).toStrictEqual(
        [
          {
            source: teamSource,
            version: 1,
            current: false,
            text: "first words",
            access: team(group),
            indexed: true,
            changes: ["1"],
          },
          {
            source: teamSource,
            version: 2,
            current: true,
            text: "second words",
            access: team(group),
            indexed: true,
            changes: ["2"],
          },
          {
            source: instructions,
            version: 1,
            current: true,
            text: "the company's instructions",
            access: team(group),
            indexed: false,
            changes: ["1"],
          },
        ].toSorted((a, b) =>
          a.source === b.source
            ? a.version - b.version
            : a.source.localeCompare(b.source)
        )
      );
    });

    it("is never in a person's own store, which refuses every export call (threat 4)", async () => {
      const person = unique();
      await add(own(person), `test:${unique()}`, "theirs alone", alone(person));
      const refused = "only the shared store takes this";
      await expect(called(own(person).startExport("test"))).rejects.toThrow(
        refused
      );
      await expect(
        called(own(person).exportStatus({ id: unique() }))
      ).rejects.toThrow(refused);
      await expect(
        called(own(person).startRestore(unique(), "test"))
      ).rejects.toThrow("a restore goes only into the shared store");
    });

    it("is stale only once it holds what was erased: then never served, and its files deleted; an erasure of anything else leaves it be (threats 6, 11)", async () => {
      const kept = `test:${unique()}`;
      const erased = `test:${unique()}`;
      const unrelated = `test:${unique()}`;
      const group = `team:${unique()}`;
      await add(shared(), kept, "kept words", team(group));
      await add(shared(), erased, "erased words", team(group));
      const { id: done } = await shared().startExport("test");
      await settled(shared(), done);
      // Retention erases what the export doesn't hold: it stays.
      await add(shared(), unrelated, "unrelated words", team(group));
      await shared().eraseSource({ source: unrelated, reason: "retention" });
      await tick(shared());
      const afterUnrelated = await shared().exportStatus({
        id: done,
      });
      // Started, not yet written: the erasure lands before its first part,
      // so it never holds what was erased, and carries on.
      const { id: writing } = await shared().startExport("test");

      await shared().eraseSource({ source: erased, reason: "deleted" });

      const doneNow = await shared().exportStatus({ id: done });
      const served = await shared().exportFile({
        id: done,
        file: "manifest.json",
      });
      await settled(shared(), writing);
      const written = of(await linesOf(shared(), writing), [kept, erased]).map(
        ({ source }) => source
      );
      await tick(shared());
      await tick(shared());
      expect({
        afterUnrelated: afterUnrelated?.state,
        doneNow: doneNow?.state,
        served,
        written,
        doneFiles: await keysUnder(`exports/${done}/`),
      }).toStrictEqual({
        afterUnrelated: "done",
        doneNow: "erased",
        served: null,
        written: [kept],
        doneFiles: [],
      });
    });

    it("is replaced, its files deleted, once a newer one is done", async () => {
      await add(
        shared(),
        `test:${unique()}`,
        "words",
        team(`team:${unique()}`)
      );
      const { id: older } = await shared().startExport("test");
      await settled(shared(), older);
      const { id: newer } = await shared().startExport("test");
      await settled(shared(), newer);
      await tick(shared());
      const replaced = await shared().exportStatus({
        id: older,
      });
      const kept = await shared().exportStatus({ id: newer });
      expect({
        replaced: replaced?.state,
        olderFiles: await keysUnder(`exports/${older}/`),
        kept: kept?.state,
      }).toStrictEqual({ replaced: "expired", olderFiles: [], kept: "done" });
    });

    it("is made stale by a person's erasure that hid a source's history it holds (threat 6)", async () => {
      const person = unique();
      const group = `team:${unique()}`;
      const source = `test:${unique()}`;
      await add(shared(), source, "the team's first words", team(group));
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      // The source narrows to the person alone, who is then erased: their
      // erasure takes its every version, the team's first among them.
      await add(shared(), source, "now theirs alone", alone(person), "2");
      await shared().erasePerson({ person, reason: "person_erased" });
      const status = await shared().exportStatus({ id });
      const served = await shared().exportFile({
        id,
        file: "manifest.json",
      });
      await tick(shared());
      await tick(shared());
      expect({
        state: status?.state,
        served,
        files: await keysUnder(`exports/${id}/`),
      }).toStrictEqual({ state: "erased", served: null, files: [] });
    });

    it("is made stale by an erasure that lands while a part's versions are read, before the part is recorded (threat 11)", async () => {
      const source = `test:${unique()}`;
      const text = `read while it is erased ${unique()}`;
      await add(shared(), source, text, team(`team:${unique()}`));
      const { id } = await shared().startExport("test");
      const fileKey = `sources/${await sha256(text)}`;
      const held = await holdingBucket(shared(), (key) => key === fileKey);
      try {
        const ticking = tick(shared());
        await held.reached();
        await shared().eraseSource({ source, reason: "deleted" });
        held.release();
        await ticking;
      } finally {
        await held.heal();
      }
      const status = await shared().exportStatus({ id });
      expect(status?.state).toBe("erased");
    });

    it("serves no file of an export an erasure makes stale while the file is read (threat 11)", async () => {
      const source = `test:${unique()}`;
      await add(
        shared(),
        source,
        "served, then erased",
        team(`team:${unique()}`)
      );
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      const part = `exports/${id}/part-0000.jsonl`;
      const held = await holdingBucket(shared(), (key) => key === part);
      let served: string | null = "";
      try {
        const reading = shared().exportFile({
          id,
          file: "part-0000.jsonl",
        });
        await held.reached();
        await shared().eraseSource({ source, reason: "deleted" });
        held.release();
        served = await reading;
      } finally {
        await held.heal();
      }
      expect(served).toBeNull();
    });

    it("deletes every file of a stale export, a part written while it was being retired among them (threat 9)", async () => {
      const group = `team:${unique()}`;
      const erased = `test:${unique()}`;
      await add(shared(), erased, `first ${unique()}`, team(group));
      for (let index = 0; index < 49; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one add at a time
        await add(shared(), `test:${unique()}`, `filler ${index}`, team(group));
      }
      // Its second version is the next part's.
      await add(shared(), erased, `second ${unique()}`, team(group), "2");
      const { id } = await shared().startExport("test");
      const secondPart = `exports/${id}/part-0001.jsonl`;
      const held = await holdingBucket(
        shared(),
        (key) => key === secondPart,
        "put"
      );
      try {
        const ticking = tick(shared());
        await held.reached();
        await shared().eraseSource({ source: erased, reason: "deleted" });
        // Ticks while the part's write is held: the export is retired.
        await tick(shared());
        await tick(shared());
        held.release();
        await ticking;
      } finally {
        await held.heal();
      }
      await tick(shared());
      await tick(shared());
      const status = await shared().exportStatus({ id });
      expect({
        state: status?.state,
        files: await keysUnder(`exports/${id}/`),
      }).toStrictEqual({ state: "erased", files: [] });
    });

    it("keeps the older export when the newer one turns stale as it finishes (threat 6)", async () => {
      const group = `team:${unique()}`;
      await add(shared(), `test:${unique()}`, `kept ${unique()}`, team(group));
      const { id: older } = await shared().startExport("test");
      await settled(shared(), older);
      const erased = `test:${unique()}`;
      await add(shared(), erased, `erased ${unique()}`, team(group));
      const { id: newer } = await shared().startExport("test");
      const manifest = `exports/${newer}/manifest.json`;
      const held = await holdingBucket(
        shared(),
        (key) => key === manifest,
        "put"
      );
      try {
        const ticking = tick(shared());
        await held.reached();
        await shared().eraseSource({ source: erased, reason: "deleted" });
        held.release();
        await ticking;
      } finally {
        await held.heal();
      }
      await tick(shared());
      const olderNow = await shared().exportStatus({
        id: older,
      });
      const newerNow = await shared().exportStatus({
        id: newer,
      });
      expect({ older: olderNow?.state, newer: newerNow?.state }).toStrictEqual({
        older: "done",
        newer: "erased",
      });
    });

    it("leaves no erased version in a done export's files when the store stops between a part's write and its record (threat 9)", async () => {
      const marker = `marker${unique()}`;
      const source = `test:${unique()}`;
      await add(shared(), source, marker, team(`team:${unique()}`));
      const { id } = await shared().startExport("test");
      const partKey = `exports/${id}/part-0000.jsonl`;
      const flags = { landed: false };
      const bucket = env.BRAIN_OBJECTS;
      const through = async (
        name: string,
        args: unknown[]
      ): Promise<unknown> => {
        const method: unknown = Reflect.get(bucket, name);
        if (typeof method !== "function") {
          throw new TypeError(`R2 has no ${name}`);
        }
        const result: unknown = await Reflect.apply(method, bucket, args);
        return result;
      };
      // The part lands, then the store stops before it records it.
      await runInDurableObject(shared(), (instance) => {
        const objectEnv: unknown = Reflect.get(instance, "env");
        if (typeof objectEnv !== "object" || objectEnv === null) {
          throw new TypeError("The store has no env");
        }
        const swapped = Object.fromEntries(
          r2Calls.map((name) => [
            name,
            async (...args: unknown[]) => {
              const result = await through(name, args);
              if (name === "put" && args[0] === partKey) {
                flags.landed = true;
                await until(() => false, "a store that stopped");
              }
              return result;
            },
          ])
        );
        Reflect.set(instance, "env", { ...objectEnv, BRAIN_OBJECTS: swapped });
      });
      const ticking = called(tick(shared())).catch(() => {});
      await until(() => flags.landed, "the part to land");
      try {
        await runInDurableObject(shared(), (_instance, state) => {
          state.abort("Stopped between the part and its record");
        });
      } catch {
        // The kill ends the call it was made in.
      }
      await ticking;
      await shared().eraseSource({ source, reason: "deleted" });
      await settled(shared(), id);
      for (let ticks = 0; ticks < 4; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick(shared());
      }
      const leaked: string[] = [];
      for (const key of await keysUnder(`exports/${id}/`)) {
        // oxlint-disable-next-line no-await-in-loop -- one file at a time
        const object = await bucket.get(key);
        // oxlint-disable-next-line no-await-in-loop -- one file at a time
        const body = (await object?.text()) ?? "";
        if (body.includes(marker)) {
          leaked.push(key);
        }
      }
      expect(leaked).toStrictEqual([]);
    });

    it("goes on after the store restarts", async () => {
      const source = `test:${unique()}`;
      await add(shared(), source, "words to keep", team(`team:${unique()}`));
      const { id } = await shared().startExport("test");
      try {
        await runInDurableObject(shared(), (_instance, state) => {
          state.abort("Killed by the test");
        });
      } catch {
        // The kill ends the call it was made in.
      }
      await expect(settled(shared(), id)).resolves.toMatchObject({
        state: "done",
      });
      expect(
        of(await linesOf(shared(), id), [source]).map(({ text }) => text)
      ).toStrictEqual(["words to keep"]);
    });
  });

  describe("a restore of a company export", { timeout: 60_000 }, () => {
    it("brings it back into an empty store as it was, leaving out what the ledger names (threats 7, 9)", async () => {
      const group = `team:${unique()}`;
      const kept = `test:${unique()}`;
      const erased = `test:${unique()}`;
      const nobodys = `test:${unique()}`;
      await add(shared(), kept, "kept, first", team(group));
      await add(shared(), kept, "kept, second", team(group), "2");
      await add(shared(), erased, "erased words", team(group));
      await add(shared(), nobodys, "nobody's words", { kind: "none" });
      const { id } = await shared().startExport("test");
      await settled(shared(), id);

      // The store's storage lost, its bucket kept: its export's record gone.
      // A source is erased after the export was made, by the ledger alone.
      await putBack(shared(), emptyShared);
      await shared().eraseSource({ source: erased, reason: "deleted" });
      await expect(shared().startRestore(id, "test")).resolves.toMatchObject({
        state: "running",
      });
      // Killed before it ran: it goes on as the store starts again.
      try {
        await runInDurableObject(shared(), (_instance, state) => {
          state.abort("Killed by the test");
        });
      } catch {
        // The kill ends the call it was made in.
      }
      for (let ticks = 0; ticks < 10; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick(shared());
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        const status = await shared().restoreStatus(id);
        if (status?.state !== "running") {
          break;
        }
      }
      await expect(shared().restoreStatus(id)).resolves.toMatchObject({
        state: "done",
      });

      const reader = readerOf(unique(), [group]);
      const read = async (source: string, version: number) => {
        const found = await shared().readVersion({ source, version, reader });
        return found?.text ?? null;
      };
      const current = await shared().readCurrent({
        sources: [kept, erased],
        reader,
      });
      const recalled = await shared().recall({
        question: "kept second erased",
        budget: { tokens: 2000 },
        reader,
      });
      const nobodysRead = await shared().readCurrent({
        sources: [nobodys],
        reader: readerOf(unique(), [group]),
      });
      expect({
        first: await read(kept, 1),
        second: await read(kept, 2),
        erased: await read(erased, 1),
        current: current.map(({ text }) => text),
        found: recalled.items.map(({ source }) => source),
        // Nobody's stays nobody's.
        nobodys: nobodysRead.length,
      }).toStrictEqual({
        first: "kept, first",
        second: "kept, second",
        erased: null,
        current: ["kept, second"],
        found: [kept],
        nobodys: 0,
      });
      // A producer's retry of a change made before answers with its version.
      await expect(
        shared().addSource({
          source: kept,
          change: "1",
          text: "kept, first",
          access: team(group),
        })
      ).resolves.toStrictEqual({ source: kept, version: 1 });
      // A restore goes only into a store that holds nothing.
      await expect(
        called(shared().startRestore(unique(), "test"))
      ).rejects.toThrow("a store that holds nothing");
    });

    it("fails on a damaged part and writes nothing of it (threat 8)", async () => {
      await add(
        shared(),
        `test:${unique()}`,
        "words",
        team(`team:${unique()}`)
      );
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      const part = `exports/${id}/part-0000.jsonl`;
      const object = await env.BRAIN_OBJECTS.get(part);
      const body = (await object?.text()) ?? "";
      await env.BRAIN_OBJECTS.put(part, body.replace("words", "wordz"));

      await putBack(shared(), emptyShared);
      await shared().startRestore(id, "test");
      await tick(shared());

      await expect(shared().restoreStatus(id)).resolves.toMatchObject({
        state: "failed",
        restored: 0,
      });
      await expect(
        runInDurableObject(
          shared(),
          (_instance, state) =>
            state.storage.sql
              .exec<{ count: number }>(
                "SELECT count(*) AS count FROM source_versions"
              )
              .one().count
        )
      ).resolves.toBe(0);
    });

    it("refuses every add while it runs, and never moves a current pointer back", async () => {
      const group = `team:${unique()}`;
      const source = `test:${unique()}`;
      await add(shared(), source, "wide, first", team(group));
      await add(shared(), source, "wide, second", team(group), "2");
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      await putBack(shared(), emptyShared);
      await shared().startRestore(id, "test");

      // An add lands while the restore runs: it narrows the source.
      await expect(
        called(
          shared().addSource({
            source,
            change: "3",
            text: "narrowed",
            access: alone(unique()),
          })
        )
      ).rejects.toThrow("restoring an export");
      await tick(shared());

      const restored = await shared().restoreStatus(id);
      const current = await shared().readCurrent({
        sources: [source],
        reader: readerOf(unique(), [group]),
      });
      expect({
        state: restored?.state,
        current: current.map(({ text }) => text),
      }).toStrictEqual({ state: "done", current: ["wide, second"] });
      // Once it is done, adds are taken again.
      await expect(
        shared().addSource({
          source,
          change: "3",
          text: "narrowed",
          access: team(group),
        })
      ).resolves.toStrictEqual({ source, version: 3 });
    });

    it("deletes the files of an export the store lost its record of, once the ledger names a version they hold", async () => {
      const source = `test:${unique()}`;
      await add(shared(), source, "to be erased", team(`team:${unique()}`));
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      await expect(keysUnder(`exports/${id}/`)).resolves.not.toStrictEqual([]);

      await putBack(shared(), emptyShared);
      await shared().eraseSource({ source, reason: "deleted" });
      await tick(shared());
      await tick(shared());

      await expect(keysUnder(`exports/${id}/`)).resolves.toStrictEqual([]);
    });

    it("checks every part before it writes any, keeps parts within their byte budget, and gives up a restore whose check found a damaged part", async () => {
      const group = `team:${unique()}`;
      // Five versions of some 0.9 MB of text in three bytes a character:
      // more than a part's budget of encoded bytes.
      const large = Array.from({ length: 5 }, () => `test:${unique()}`);
      for (const [index, source] of large.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- one large add at a time
        await add(
          shared(),
          source,
          `${index} ${"漢字 ".repeat(130_000)}`,
          team(group)
        );
      }
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      const manifestText = await shared().exportFile({
        id,
        file: "manifest.json",
      });
      const manifest = manifestSchema.parse(JSON.parse(manifestText ?? "{}"));
      expect({
        several: manifest.parts.length > 1,
        withinBudget: manifest.parts.every(
          ({ bytes }) => bytes <= exportPartBytes
        ),
      }).toStrictEqual({ several: true, withinBudget: true });

      // The last part damaged: the check finds it before anything is written.
      const lastPart = `exports/${id}/${manifest.parts.at(-1)?.file ?? ""}`;
      const object = await env.BRAIN_OBJECTS.get(lastPart);
      const body = (await object?.text()) ?? "";
      await env.BRAIN_OBJECTS.put(lastPart, body.replace("字", "子"));
      await putBack(shared(), emptyShared);
      await shared().startRestore(id, "test");
      for (let ticks = 0; ticks < 3; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick(shared());
      }
      // Damaged before its check ended: the restore is given up, its
      // export's files go, and it can't be started again.
      const status = await shared().restoreStatus(id);
      const held = await versionsHeld();
      const files = await keysUnder(`exports/${id}/`);
      await expect(called(shared().startRestore(id, "test"))).rejects.toThrow(
        "given up"
      );
      expect({ status, held, files }).toStrictEqual({
        status: { export: id, state: "abandoned", restored: 0 },
        held: 0,
        files: [],
      });
    });

    it("settles an export whose item of the queue is gone as failed, and deletes its files", async () => {
      await add(
        shared(),
        `test:${unique()}`,
        "words",
        team(`team:${unique()}`)
      );
      const { id } = await shared().startExport("test");
      await runInDurableObject(shared(), (_instance, state) => {
        state.storage.sql.exec(
          "DELETE FROM work_items WHERE kind = 'brain.export' AND key = ?",
          `export:${id}`
        );
      });
      await tick(shared());
      await tick(shared());

      expect({
        status: await shared().exportStatus({ id }),
        files: await keysUnder(`exports/${id}/`),
      }).toStrictEqual({
        status: { id, state: "failed", versions: 0, files: [] },
        files: [],
      });
      // The next one is not held up.
      const { id: next } = await shared().startExport("test");
      expect(next).not.toBe(id);
      await settled(shared(), next);
    });

    it("refuses another deployment's export", async () => {
      await add(
        shared(),
        `test:${unique()}`,
        "words",
        team(`team:${unique()}`)
      );
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      await putBack(shared(), emptyShared);

      await expect(
        called(shared().startRestore(id, "elsewhere"))
      ).rejects.toThrow("no whole company export of this deployment");
    });

    it("after a storage loss, deletes an export holding what was erased, and keeps and restores one that holds nothing erased", async () => {
      await putBack(shared(), emptyShared);
      const group = `team:${unique()}`;
      const kept = `test:${unique()}`;
      const gone = `test:${unique()}`;
      await add(shared(), kept, "kept words", team(group));
      await add(shared(), gone, "gone words", team(group));
      const { id: before } = await shared().startExport("test");
      await settled(shared(), before);
      await shared().eraseSource({ source: gone, reason: "deleted" });
      await tick(shared());
      const { id: after } = await shared().startExport("test");
      await settled(shared(), after);
      // Retention erases a source the export after doesn't hold.
      const later = `test:${unique()}`;
      await add(shared(), later, "added after it", team(group));
      await shared().eraseSource({ source: later, reason: "retention" });

      await putBack(shared(), emptyShared);
      for (let ticks = 0; ticks < 3; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick(shared());
      }
      const afterKeys = await keysUnder(`exports/${after}/`);
      await shared().startRestore(after, "test");
      const status = await restoreSettled(after);
      const current = await shared().readCurrent({
        sources: [kept, gone],
        reader: readerOf(unique(), [group]),
      });
      expect({
        beforeKeys: await keysUnder(`exports/${before}/`),
        afterKept: afterKeys.length > 0,
        status: status?.state,
        current: current.map(({ text }) => text),
      }).toStrictEqual({
        beforeKeys: [],
        afterKept: true,
        status: "done",
        current: ["kept words"],
      });
    });

    it("starts a failed restore again from the same export, whatever erasure landed meanwhile, and counts the whole restore", async () => {
      await putBack(shared(), emptyShared);
      const group = `team:${unique()}`;
      const sources = Array.from({ length: 60 }, () => `test:${unique()}`);
      for (const source of sources) {
        // oxlint-disable-next-line no-await-in-loop -- one add at a time
        await add(shared(), source, `words of ${source}`, team(group));
      }
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      await putBack(shared(), emptyShared);
      await shared().startRestore(id, "test");
      // An unrelated erasure lands while it runs.
      await shared().eraseSource({
        source: `test:${unique()}`,
        reason: "retention",
      });
      // Checked whole; then the second part is lost before it is written.
      await runInDurableObject(shared(), (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE restores SET checked = 2 WHERE export = ?",
          id
        );
      });
      const lost = `exports/${id}/part-0001.jsonl`;
      const object = await env.BRAIN_OBJECTS.get(lost);
      const body = (await object?.text()) ?? "";
      await env.BRAIN_OBJECTS.delete(lost);
      const failed = await restoreSettled(id);
      const filesKept = await keysUnder(`exports/${id}/`);

      await env.BRAIN_OBJECTS.put(lost, body);
      const again = await shared().startRestore(id, "test");
      const done = await restoreSettled(id);
      expect({
        failed: failed?.state,
        filesKept: filesKept.length,
        again: again.state,
        done: done?.state,
        restored: done?.restored,
        held: await versionsHeld(),
      }).toStrictEqual({
        failed: "failed",
        // Its manifest, each part's holdings and the part not lost.
        filesKept: 4,
        again: "running",
        done: "done",
        restored: 60,
        held: 60,
      });
    });

    it("exports and restores the company's own skills, never Grasp's, and refuses an export while it runs", async () => {
      await putBack(shared(), emptyShared);
      const group = `team:${unique()}`;
      await add(shared(), `test:${unique()}`, "a document", team(group));
      // The company's own skill, kept whole; and one Grasp ships, which
      // each release adds again, so no export holds it.
      await shared().addInstructions({
        source: `skill:company:${unique()}`,
        change: "1",
        text: "a skill of the company's",
        access: team(group),
      });
      await shared().addInstructions({
        source: `skill:grasp:${unique()}`,
        change: "1",
        text: "a skill Grasp ships",
        access: team(group),
      });
      // A skill's key is never a document's.
      await expect(
        called(
          add(shared(), `skill:company:${unique()}`, "a skill", team(group))
        )
      ).rejects.toThrow("added with addInstructions");
      const { id } = await shared().startExport("test");
      const exported = await settled(shared(), id);
      await putBack(shared(), emptyShared);
      await shared().startRestore(id, "test");
      await expect(called(shared().startExport("test"))).rejects.toThrow(
        "restoring an export"
      );
      const status = await restoreSettled(id);
      expect({
        exported: exported?.versions,
        restore: status?.state,
        held: await versionsHeld(),
      }).toStrictEqual({ exported: 2, restore: "done", held: 2 });
    });

    it("restores into a store that holds only Grasp's own skills, which stay", async () => {
      await putBack(shared(), emptyShared);
      const group = `team:${unique()}`;
      const document = `test:${unique()}`;
      await add(shared(), document, "a document", team(group));
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      await putBack(shared(), emptyShared);
      // A release installs Grasp's skills into the fresh store first.
      const skill = `skill:grasp:${unique()}`;
      await shared().addInstructions({
        source: skill,
        change: "1",
        text: "a skill Grasp ships",
        access: team(group),
      });

      await shared().startRestore(id, "test");
      const status = await restoreSettled(id);
      const current = await shared().readCurrent({
        sources: [document, skill],
        reader: readerOf(unique(), [group]),
      });
      expect({
        status: status?.state,
        current: current.map(({ text }) => text),
      }).toStrictEqual({
        status: "done",
        current: ["a document", "a skill Grasp ships"],
      });
    });

    it("keeps a sweep's pass going when an erasure lands during it, and checks that erasure against every export, those it passed too (threat 6)", async () => {
      await putBack(shared(), emptyShared);
      const source = `test:${unique()}`;
      await add(
        shared(),
        source,
        `swept ${unique()}`,
        team(`team:${unique()}`)
      );
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      const bucket = env.BRAIN_OBJECTS;
      const files = await keysUnder(`exports/${id}/`);
      // Copies of it the store will have no record of, around it in order.
      const ids = [id];
      for (let copy = 0; copy < 25; copy += 1) {
        const other = crypto.randomUUID();
        ids.push(other);
        for (const key of files) {
          // oxlint-disable-next-line no-await-in-loop -- one file at a time
          const object = await bucket.get(key);
          // oxlint-disable-next-line no-await-in-loop -- one file at a time
          const body = (await object?.text()) ?? "";
          // oxlint-disable-next-line no-await-in-loop -- one file at a time
          await bucket.put(key.replace(id, other), body);
        }
      }
      ids.sort();
      await putBack(shared(), emptyShared);
      // An unrelated erasure starts a sweep.
      const unrelated = `test:${unique()}`;
      await add(shared(), unrelated, "unrelated", team(`team:${unique()}`));
      await shared().eraseSource({ source: unrelated, reason: "deleted" });
      const heldKey = `exports/${ids[2] ?? ""}/part-0000.holds.json`;
      const held = await holdingBucket(shared(), (key) => key === heldKey);
      let place: string | null = null;
      try {
        const ticking = tick(shared());
        await held.reached();
        // The source every copy holds is erased while the sweep is past
        // the first ones.
        await shared().eraseSource({ source, reason: "deleted" });
        await tick(shared());
        // The pass the erasure landed in keeps its place: it is not
        // started over from the first key.
        place = await runInDurableObject(
          shared(),
          (_instance, state) =>
            state.storage.sql
              .exec<{ cursor: string | null }>(
                "SELECT cursor FROM export_sweep WHERE id = 1"
              )
              .one().cursor
        );
        held.release();
        await ticking;
      } finally {
        await held.heal();
      }
      for (let ticks = 0; ticks < 30; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick(shared());
      }
      const left: string[] = [];
      for (const each of ids) {
        // oxlint-disable-next-line no-await-in-loop -- one export at a time
        const keys = await keysUnder(`exports/${each}/`);
        if (keys.length > 0) {
          left.push(each);
        }
      }
      expect({
        place: place?.slice(0, 44) ?? null,
        left,
      }).toStrictEqual({ place: heldKey.slice(0, 44), left: [] });
    });

    it("serves no file of an export a restore adopted until it has checked what every part holds, and drops it once the ledger names any (threats 6, 7)", async () => {
      await putBack(shared(), emptyShared);
      const marker = `marker${unique()}`;
      const source = `test:${unique()}`;
      await add(shared(), source, marker, team(`team:${unique()}`));
      await add(shared(), `test:${unique()}`, "kept", team(`team:${unique()}`));
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      // The store's storage lost; a source the export holds erased; the
      // restore adopts the export, and the store stops before it checks.
      await putBack(shared(), emptyShared);
      await shared().eraseSource({ source, reason: "deleted" });
      await shared().startRestore(id, "test");
      await stop(shared());
      const served = await Promise.all(
        ["manifest.json", "part-0000.jsonl"].map(
          async (file) => await shared().exportFile({ id, file })
        )
      );
      const status = await shared().exportStatus({ id });
      await restoreSettled(id);
      await tick(shared());
      await tick(shared());
      expect({
        served,
        state: status?.state,
        files: await keysUnder(`exports/${id}/`),
      }).toStrictEqual({ served: [null, null], state: "restoring", files: [] });
    });

    it("names parts past 9,999 as the writer does, and every rule that reads a part's name takes them (threat 8)", async () => {
      const part = {
        file: "part-10000.jsonl",
        sha256: "0".repeat(64),
        versions: 1,
        bytes: 1,
      };
      const manifest = storeManifestSchema.safeParse({
        format: 1,
        id: crypto.randomUUID(),
        deployment: "test",
        scope: "company",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        versions: 1,
        parts: [part],
      });
      expect({
        name: exportFileNameSchema.safeParse("part-10000.jsonl").success,
        // Only the writer's own form: no other spelling of the same part.
        padded: exportFileNameSchema.safeParse("part-00001.jsonl").success,
        short: exportFileNameSchema.safeParse("part-1.jsonl").success,
        manifest: manifest.success,
        // Asked of the store, a five-digit name is a file it may serve.
        served: await shared().exportFile({
          id: crypto.randomUUID(),
          file: "part-10000.jsonl",
        }),
      }).toStrictEqual({
        name: true,
        padded: false,
        short: false,
        manifest: true,
        served: null,
      });
    });

    it("never serves an adopted export with a damaged part and no holdings beside it, and deletes its files (threats 6, 8)", async () => {
      await putBack(shared(), emptyShared);
      const marker = `marker${unique()}`;
      const source = `test:${unique()}`;
      await add(shared(), source, marker, team(`team:${unique()}`));
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      await putBack(shared(), emptyShared);
      // A part damaged, and its holdings gone: nothing says what it holds.
      const partKey = `exports/${id}/part-0000.jsonl`;
      const object = await env.BRAIN_OBJECTS.get(partKey);
      const body = (await object?.text()) ?? "";
      await env.BRAIN_OBJECTS.put(partKey, `${body}\n`);
      await env.BRAIN_OBJECTS.delete(`exports/${id}/part-0000.holds.json`);
      await shared().startRestore(id, "test");
      await restoreSettled(id);
      await shared().eraseSource({ source, reason: "deleted" });
      await tick(shared());
      await tick(shared());
      const served = await shared().exportFile({ id, file: "part-0000.jsonl" });
      const holding: string[] = [];
      for (const key of await keysUnder(`exports/${id}/`)) {
        // oxlint-disable-next-line no-await-in-loop -- one file at a time
        const file = await env.BRAIN_OBJECTS.get(key);
        // oxlint-disable-next-line no-await-in-loop -- one file at a time
        const text = (await file?.text()) ?? "";
        if (text.includes(marker)) {
          holding.push(key);
        }
      }
      expect({ served, holding }).toStrictEqual({ served: null, holding: [] });
    });

    it("makes an adopted export of no parts done once its restore is done", async () => {
      await putBack(shared(), emptyShared);
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      await putBack(shared(), emptyShared);
      await shared().startRestore(id, "test");
      const restore = await restoreSettled(id);
      const status = await shared().exportStatus({ id });
      expect({ restore: restore?.state, export: status?.state }).toStrictEqual({
        restore: "done",
        export: "done",
      });
    });

    it("keeps an adopted export whose restore stopped before its check ended, serving none of it, and restores it when started again (threat 9)", async () => {
      await putBack(shared(), emptyShared);
      const group = `team:${unique()}`;
      const sources = [`test:${unique()}`, `test:${unique()}`];
      for (const source of sources) {
        // oxlint-disable-next-line no-await-in-loop -- one source at a time
        await add(shared(), source, `kept ${unique()}`, team(group));
      }
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      const files = await keysUnder(`exports/${id}/`);
      await putBack(shared(), emptyShared);
      await startedAndStopped(id);
      const served = await servedOf(id, files);
      const kept = await keysUnder(`exports/${id}/`);
      const stopped = await shared().restoreStatus(id);
      await shared().startRestore(id, "test");
      const again = await restoreSettled(id);
      const status = await shared().exportStatus({ id });
      expect({
        kept,
        served,
        stopped: stopped?.state,
        again: again?.state,
        restored: again?.restored,
        export: status?.state,
      }).toStrictEqual({
        kept: files,
        served: [],
        stopped: "failed",
        again: "done",
        restored: 2,
        export: "done",
      });
    });

    it("drops an adopted export handed back by a stopped check once the ledger names a version it holds (threats 6, 9)", async () => {
      await putBack(shared(), emptyShared);
      const marker = `marker${unique()}`;
      const source = `test:${unique()}`;
      await add(shared(), source, marker, team(`team:${unique()}`));
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      const files = await keysUnder(`exports/${id}/`);
      await putBack(shared(), emptyShared);
      await startedAndStopped(id);
      const kept = await keysUnder(`exports/${id}/`);
      await shared().eraseSource({ source, reason: "deleted" });
      for (let ticks = 0; ticks < 4; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick(shared());
      }
      expect({
        kept,
        after: await keysUnder(`exports/${id}/`),
      }).toStrictEqual({ kept: files, after: [] });
    });

    it("holds no file past the parts its manifest names once a restore adopts it (threats 6, 8)", async () => {
      await putBack(shared(), emptyShared);
      const group = `team:${unique()}`;
      const sources = Array.from({ length: 60 }, () => `test:${unique()}`);
      for (const source of sources) {
        // oxlint-disable-next-line no-await-in-loop -- one source at a time
        await add(shared(), source, `words ${source}`, team(group));
      }
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      // A manifest naming only the first part: the second's files are
      // never checked, so nothing records what they hold.
      const manifestKey = `exports/${id}/manifest.json`;
      const manifestFile = await env.BRAIN_OBJECTS.get(manifestKey);
      const manifest = storeManifestSchema.parse(
        JSON.parse((await manifestFile?.text()) ?? "")
      );
      const [first] = manifest.parts;
      if (first === undefined || manifest.parts.length < 2) {
        throw new Error("The export has fewer than two parts");
      }
      const second = await env.BRAIN_OBJECTS.get(
        `exports/${id}/part-0001.jsonl`
      );
      const unnamed = lineSchema.parse(
        JSON.parse(((await second?.text()) ?? "").split("\n")[0] ?? "")
      ).source;
      await env.BRAIN_OBJECTS.put(
        manifestKey,
        JSON.stringify({
          ...manifest,
          versions: first.versions,
          parts: [first],
        })
      );
      await putBack(shared(), emptyShared);
      await shared().startRestore(id, "test");
      await restoreSettled(id);
      // Every file the manifest names is still there: only those past it went.
      const adopted = await keysUnder(`exports/${id}/`);
      await shared().eraseSource({ source: unnamed, reason: "deleted" });
      await tick(shared());
      await tick(shared());
      const holding: string[] = [];
      for (const key of await keysUnder(`exports/${id}/`)) {
        // oxlint-disable-next-line no-await-in-loop -- one file at a time
        const file = await env.BRAIN_OBJECTS.get(key);
        // oxlint-disable-next-line no-await-in-loop -- one file at a time
        if (((await file?.text()) ?? "").includes(`words ${unnamed}`)) {
          holding.push(key);
        }
      }
      expect({ adopted, holding }).toStrictEqual({
        adopted: [
          `exports/${id}/manifest.json`,
          `exports/${id}/part-0000.holds.json`,
          `exports/${id}/part-0000.jsonl`,
        ],
        holding: [],
      });
    });

    it("drops a handed-back export whose holdings an erasure named while its restore was stuck, with no erasure after (threats 6, 9)", async () => {
      await putBack(shared(), emptyShared);
      const source = `test:${unique()}`;
      await add(
        shared(),
        source,
        `erased ${unique()}`,
        team(`team:${unique()}`)
      );
      await add(
        shared(),
        `test:${unique()}`,
        `kept ${unique()}`,
        team(`team:${unique()}`)
      );
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      await putBack(shared(), emptyShared);
      await shared().startRestore(id, "test");
      const restoreItem = async (set: string): Promise<void> => {
        await runInDurableObject(shared(), (_instance, state) => {
          state.storage.sql.exec(
            `UPDATE work_items SET ${set} WHERE kind = 'brain.restore' AND key = ?`,
            `restore:${id}`
          );
        });
      };
      // Parked, not for good: the restore runs no further, and its export,
      // still adopted, is held.
      await restoreItem(`parked_at = ${Date.now()}, parks = 1`);
      // An erasure of what it holds: its sweep pass passes the export by,
      // as the store has a record of it.
      await shared().eraseSource({ source, reason: "deleted" });
      for (let ticks = 0; ticks < 4; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick(shared());
      }
      const held = await keysUnder(`exports/${id}/`);
      // Parked for good: the tick hands the export back, and with no
      // erasure after, a pass still judges its files.
      await restoreItem(`parks = ${workParksMax}`);
      for (let ticks = 0; ticks < 6; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick(shared());
      }
      expect({
        held: held.length > 0,
        after: await keysUnder(`exports/${id}/`),
      }).toStrictEqual({ held: true, after: [] });
    });

    it("goes on with a sweep pass whose item went before it ended, from its saved place (threat 6)", async () => {
      await putBack(shared(), emptyShared);
      const source = `test:${unique()}`;
      await add(
        shared(),
        source,
        `swept ${unique()}`,
        team(`team:${unique()}`)
      );
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      // The store's storage lost, then the source erased: the export's files
      // are unknown to the store and hold what was erased.
      await putBack(shared(), emptyShared);
      await shared().eraseSource({ source, reason: "deleted" });
      // A pass started for that erasure and stopped at its first key, its
      // item gone (as one parked for good): checked and started for alike.
      await runInDurableObject(shared(), (_instance, state) => {
        const { sql } = state.storage;
        const { last } = sql
          .exec<{ last: number }>(
            "SELECT coalesce(max(rowid), 0) AS last FROM erasures"
          )
          .one();
        sql.exec(
          `INSERT OR REPLACE INTO export_sweep (id, through, checked, cursor)
          VALUES (1, ?, ?, 'exports/')`,
          last,
          last
        );
        sql.exec("DELETE FROM work_items WHERE kind = 'brain.export_sweep'");
      });
      for (let ticks = 0; ticks < 3; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick(shared());
      }
      await expect(keysUnder(`exports/${id}/`)).resolves.toStrictEqual([]);
    });

    it("settles a restore whose item of the queue is gone as failed, with what it wrote, and lets it start again and finish (threat 9)", async () => {
      await putBack(shared(), emptyShared);
      const group = `team:${unique()}`;
      const sources = Array.from({ length: 60 }, () => `test:${unique()}`);
      for (const source of sources) {
        // oxlint-disable-next-line no-await-in-loop -- one add at a time
        await add(shared(), source, `words of ${source}`, team(group));
      }
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      await putBack(shared(), emptyShared);
      // The write pass's read of the second part (its second read) stops
      // the store, its first part written.
      const stopping = await stoppingBucket(
        shared(),
        "get",
        `exports/${id}/part-0001.jsonl`,
        2,
        true
      );
      await shared().startRestore(id, "test");
      const ticking = called(tick(shared())).catch(() => {});
      await until(stopping.reached, "the second part's write-pass read");
      // Its item gone, as one parked for good, and the store stopped.
      await runInDurableObject(shared(), (_instance, state) => {
        state.storage.sql.exec(
          "DELETE FROM work_items WHERE kind = 'brain.restore'"
        );
      });
      await stop(shared());
      await ticking;
      const halfway = await versionsHeld();
      await tick(shared());
      await tick(shared());
      const stuck = await shared().restoreStatus(id);
      const again = await shared().startRestore(id, "test");
      const done = await restoreSettled(id);
      expect({
        halfway,
        stuck: stuck?.state,
        again: again.state,
        done: done?.state,
        restored: done?.restored,
        held: await versionsHeld(),
      }).toStrictEqual({
        halfway: 50,
        stuck: "failed",
        again: "running",
        done: "done",
        restored: 60,
        held: 60,
      });
    });

    it("lets go of a failed restore's export once the ledger names what it holds, and won't restart it into a store in use (threats 6, 7)", async () => {
      await putBack(shared(), emptyShared);
      const group = `team:${unique()}`;
      const marker = `marker${unique()}`;
      const source = `test:${unique()}`;
      await add(shared(), source, marker, team(group));
      const { id } = await shared().startExport("test");
      await settled(shared(), id);
      const part = `exports/${id}/part-0000.jsonl`;
      const object = await env.BRAIN_OBJECTS.get(part);
      const good = (await object?.text()) ?? "";
      await env.BRAIN_OBJECTS.put(part, good.replace("marker", "mended"));
      await putBack(shared(), emptyShared);
      await shared().startRestore(id, "test");
      await tick(shared());
      const failed = await shared().restoreStatus(id);
      // The part mended; the store used again, and the source erased.
      await env.BRAIN_OBJECTS.put(part, good);
      await add(shared(), `test:${unique()}`, "in use", team(group));
      await shared().eraseSource({ source, reason: "deleted" });
      for (let ticks = 0; ticks < 6; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick(shared());
      }
      const files = await keysUnder(`exports/${id}/`);
      await expect(called(shared().startRestore(id, "test"))).rejects.toThrow(
        "refused"
      );
      expect({ failed: failed?.state, files }).toStrictEqual({
        failed: "failed",
        files: [],
      });
    });
  });
});
