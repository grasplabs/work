// Exports and restores (exports.ts, restore.ts, GRA-1755): a company's
// Brain written as checked files in its own bucket and read back into an
// empty store, and a person's own export. The threat model is on
// GRA-1755; each test names the threats it holds. Every test has sources,
// people and teams of its own; the restores empty the shared store first,
// as a store whose storage was lost, its bucket kept.
import type {
  Access,
  AskModel,
  Embedders,
  ExportScope,
  Reader,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { exportPartBytes } from "../src/exports.ts";
import type { BrainStore } from "../src/store.ts";

type Store = DurableObjectStub<BrainStore>;

const shared = (): Store => env.BRAIN_STORE.getByName("brain");
const own = (person: string): Store =>
  env.BRAIN_STORE.getByName(`person:${person}`);

const quietAsk: AskModel = async () => {
  await Promise.resolve();
  return { kind: "answer", text: "" };
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
  await store.work(quietAsk, new Date(), noEmbedders);
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

/** Ticks `store` until the export `id` of `scope` is no longer being written: at most 10 ticks. */
const settled = async (store: Store, id: string, scope: ExportScope) => {
  for (let ticks = 0; ticks < 10; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    await tick(store);
    // oxlint-disable-next-line no-await-in-loop -- a tick at a time
    const status = await store.exportStatus({ id, scope });
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
const linesOf = async (
  store: Store,
  id: string,
  scope: ExportScope
): Promise<Line[]> => {
  const manifestText = await store.exportFile({
    id,
    scope,
    file: "manifest.json",
  });
  if (manifestText === null) {
    throw new Error("No manifest");
  }
  const manifest = manifestSchema.parse(JSON.parse(manifestText));
  const lines: Line[] = [];
  for (const part of manifest.parts) {
    // oxlint-disable-next-line no-await-in-loop -- a part at a time
    const body = await store.exportFile({ id, scope, file: part.file });
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
const madeByAnother = /^(?:sqlite_|_cf_|chunk_(?:words|stems)_)/u;

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

const company: ExportScope = { kind: "company" };

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

      const { id } = await shared().startExport(company, "test");
      await expect(settled(shared(), id, company)).resolves.toMatchObject({
        state: "done",
      });
      const lines = await linesOf(shared(), id, company);

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

    it("answers a person's ask for it, and a person's store, as an export that doesn't exist (threats 1, 2, 3)", async () => {
      const person = unique();
      await add(
        shared(),
        `test:${unique()}`,
        "words",
        team(`team:${unique()}`)
      );
      const { id } = await shared().startExport(company, "test");
      await settled(shared(), id, company);
      const asPerson: ExportScope = { kind: "person", person };

      expect({
        status: await shared().exportStatus({ id, scope: asPerson }),
        file: await shared().exportFile({
          id,
          scope: asPerson,
          file: "manifest.json",
        }),
      }).toStrictEqual({
        status: await shared().exportStatus({ id: unique(), scope: asPerson }),
        file: await shared().exportFile({
          id: unique(),
          scope: asPerson,
          file: "manifest.json",
        }),
      });
      await expect(
        called(own(person).startExport(company, "test"))
      ).rejects.toThrow("this store answers only the person whose it is");
    });

    it("is stale only once it holds what was erased: then never served, and its files deleted; an erasure of anything else leaves it be (threats 6, 11)", async () => {
      const kept = `test:${unique()}`;
      const erased = `test:${unique()}`;
      const unrelated = `test:${unique()}`;
      const group = `team:${unique()}`;
      await add(shared(), kept, "kept words", team(group));
      await add(shared(), erased, "erased words", team(group));
      const { id: done } = await shared().startExport(company, "test");
      await settled(shared(), done, company);
      // Retention erases what the export doesn't hold: it stays.
      await add(shared(), unrelated, "unrelated words", team(group));
      await shared().eraseSource({ source: unrelated, reason: "retention" });
      await tick(shared());
      const afterUnrelated = await shared().exportStatus({
        id: done,
        scope: company,
      });
      // Started, not yet written: the erasure lands before its first part,
      // so it never holds what was erased, and carries on.
      const { id: writing } = await shared().startExport(company, "test");

      await shared().eraseSource({ source: erased, reason: "deleted" });

      const doneNow = await shared().exportStatus({ id: done, scope: company });
      const served = await shared().exportFile({
        id: done,
        scope: company,
        file: "manifest.json",
      });
      await settled(shared(), writing, company);
      const written = of(await linesOf(shared(), writing, company), [
        kept,
        erased,
      ]).map(({ source }) => source);
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

    it("is replaced by a newer one of its scope, and kept no longer than its time (review round 2)", async () => {
      await add(
        shared(),
        `test:${unique()}`,
        "words",
        team(`team:${unique()}`)
      );
      const { id: older } = await shared().startExport(company, "test");
      await settled(shared(), older, company);
      const { id: newer } = await shared().startExport(company, "test");
      await settled(shared(), newer, company);
      await tick(shared());
      const replaced = await shared().exportStatus({
        id: older,
        scope: company,
      });
      const olderFiles = await keysUnder(`exports/${older}/`);

      // Done eight days ago, as time passing would.
      await runInDurableObject(shared(), (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE exports SET finished_at = ? WHERE id = ?",
          Date.now() - 8 * 24 * 60 * 60_000,
          newer
        );
      });
      await tick(shared());
      await tick(shared());
      const pastItsTime = await shared().exportStatus({
        id: newer,
        scope: company,
      });
      expect({
        replaced: replaced?.state,
        olderFiles,
        pastItsTime: pastItsTime?.state,
        newerFiles: await keysUnder(`exports/${newer}/`),
      }).toStrictEqual({
        replaced: "expired",
        olderFiles: [],
        pastItsTime: "expired",
        newerFiles: [],
      });
    });

    it("goes on after the store restarts", async () => {
      const source = `test:${unique()}`;
      await add(shared(), source, "words to keep", team(`team:${unique()}`));
      const { id } = await shared().startExport(company, "test");
      try {
        await runInDurableObject(shared(), (_instance, state) => {
          state.abort("Killed by the test");
        });
      } catch {
        // The kill ends the call it was made in.
      }
      await expect(settled(shared(), id, company)).resolves.toMatchObject({
        state: "done",
      });
      expect(
        of(await linesOf(shared(), id, company), [source]).map(
          ({ text }) => text
        )
      ).toStrictEqual(["words to keep"]);
    });
  });

  describe("a person's own export", { timeout: 60_000 }, () => {
    it("holds what they alone may read, from the shared store and their own, and no one else's (threats 2, 5)", async () => {
      const person = unique();
      const other = unique();
      const group = `team:${unique()}`;
      const mine = `test:${unique()}`;
      const others = `test:${unique()}`;
      const teams = `test:${unique()}`;
      const inOwn = `test:${unique()}`;
      await add(shared(), mine, "my words", alone(person));
      await add(shared(), others, "someone else's words", alone(other));
      await add(shared(), teams, "the team's words", team(group));
      await add(own(person), inOwn, "words in my own store", alone(person));
      const scope: ExportScope = { kind: "person", person };

      const { id: fromShared } = await shared().startExport(scope, "test");
      const { id: fromOwn } = await own(person).startExport(scope, "test");
      // The own store wakes itself for the export (`#nextWorkAt`).
      await expect(
        runInDurableObject(
          own(person),
          async (_instance, state) => await state.storage.getAlarm()
        )
      ).resolves.not.toBeNull();
      await settled(shared(), fromShared, scope);
      await settled(own(person), fromOwn, scope);

      const ownLines = await linesOf(own(person), fromOwn, scope);
      expect({
        shared: of(await linesOf(shared(), fromShared, scope), [
          mine,
          others,
          teams,
        ]).map(({ text }) => text),
        own: ownLines.map(({ text }) => text),
      }).toStrictEqual({
        shared: ["my words"],
        own: ["words in my own store"],
      });
      // Another person, or the company, finds none of it.
      for (const asked of [
        { kind: "person", person: other },
        company,
      ] satisfies ExportScope[]) {
        // oxlint-disable-next-line no-await-in-loop -- one ask at a time
        await expect(
          shared().exportFile({
            id: fromShared,
            scope: asked,
            file: "manifest.json",
          })
        ).resolves.toBeNull();
      }
      await expect(
        called(
          own(person).exportStatus({
            id: fromOwn,
            scope: { kind: "person", person: other },
          })
        )
      ).rejects.toThrow("this store answers only the person whose it is");
    });

    it("is erased with the person, and their erasure leaves the company's export be (review round 2)", async () => {
      const person = unique();
      await add(shared(), `test:${unique()}`, "only theirs", alone(person));
      await add(
        shared(),
        `test:${unique()}`,
        "the team's",
        team(`team:${unique()}`)
      );
      const scope: ExportScope = { kind: "person", person };
      const { id: theirs } = await shared().startExport(scope, "test");
      await settled(shared(), theirs, scope);
      const { id: companys } = await shared().startExport(company, "test");
      await settled(shared(), companys, company);

      await shared().erasePerson({ person, reason: "person_erased" });
      await tick(shared());
      await tick(shared());

      const theirsNow = await shared().exportStatus({ id: theirs, scope });
      const companyNow = await shared().exportStatus({
        id: companys,
        scope: company,
      });
      expect({
        theirs: theirsNow?.state,
        theirFiles: await keysUnder(`exports/${theirs}/`),
        company: companyNow?.state,
      }).toStrictEqual({ theirs: "erased", theirFiles: [], company: "done" });
    });

    it("goes with their store when they are erased", async () => {
      const person = unique();
      await add(own(person), `test:${unique()}`, "mine alone", alone(person));
      const scope: ExportScope = { kind: "person", person };
      const { id } = await own(person).startExport(scope, "test");
      await settled(own(person), id, scope);
      const prefix = `people/${await sha256(person)}/exports/${id}/`;
      await expect(keysUnder(prefix)).resolves.not.toStrictEqual([]);

      // The erasure finishes once past the write grace: called until done.
      await expect(
        called(own(person).erasePerson({ person, reason: "person_erased" }))
      ).rejects.toThrow("still deleting");

      await expect(keysUnder(prefix)).resolves.toStrictEqual([]);
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
      const { id } = await shared().startExport(company, "test");
      await settled(shared(), id, company);

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
      const { id } = await shared().startExport(company, "test");
      await settled(shared(), id, company);
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

    it("refuses every add while it runs, never moves a current pointer back, and counts only what it wrote (review round 1, High 1)", async () => {
      const group = `team:${unique()}`;
      const source = `test:${unique()}`;
      await add(shared(), source, "wide, first", team(group));
      await add(shared(), source, "wide, second", team(group), "2");
      const { id } = await shared().startExport(company, "test");
      await settled(shared(), id, company);
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

    it("deletes the files of an export the store lost its record of, once an erasure lands after it (review round 1, High 2)", async () => {
      const source = `test:${unique()}`;
      await add(shared(), source, "to be erased", team(`team:${unique()}`));
      const { id } = await shared().startExport(company, "test");
      await settled(shared(), id, company);
      await expect(keysUnder(`exports/${id}/`)).resolves.not.toStrictEqual([]);

      await putBack(shared(), emptyShared);
      await shared().eraseSource({ source, reason: "deleted" });
      await tick(shared());
      await tick(shared());

      await expect(keysUnder(`exports/${id}/`)).resolves.toStrictEqual([]);
    });

    it("checks every part before it writes any, and starts again once failed (review round 1, Mediums 4 and 6)", async () => {
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
      const { id } = await shared().startExport(company, "test");
      await settled(shared(), id, company);
      const manifestText = await shared().exportFile({
        id,
        scope: company,
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
      expect({
        status: await shared().restoreStatus(id),
        held: await versionsHeld(),
      }).toStrictEqual({
        status: { export: id, state: "failed", restored: 0 },
        held: 0,
      });

      // Mended, it starts again and goes through.
      await env.BRAIN_OBJECTS.put(lastPart, body);
      await shared().startRestore(id, "test");
      for (let ticks = 0; ticks < 5; ticks += 1) {
        // oxlint-disable-next-line no-await-in-loop -- a tick at a time
        await tick(shared());
      }
      const current = await shared().readCurrent({
        sources: large,
        reader: readerOf(unique(), [group]),
      });
      const status = await shared().restoreStatus(id);
      expect({
        state: status?.state,
        current: current.map(({ text }) => text.slice(0, 1)),
      }).toStrictEqual({ state: "done", current: ["0", "1", "2", "3", "4"] });
    });

    it("settles an export whose item of the queue is gone as failed, and deletes its files (review round 1, Medium 4)", async () => {
      await add(
        shared(),
        `test:${unique()}`,
        "words",
        team(`team:${unique()}`)
      );
      const { id } = await shared().startExport(company, "test");
      await runInDurableObject(shared(), (_instance, state) => {
        state.storage.sql.exec(
          "DELETE FROM work_items WHERE kind = 'brain.export' AND key = ?",
          `export:${id}`
        );
      });
      await tick(shared());
      await tick(shared());

      expect({
        status: await shared().exportStatus({ id, scope: company }),
        files: await keysUnder(`exports/${id}/`),
      }).toStrictEqual({
        status: { id, state: "failed", versions: 0, files: [] },
        files: [],
      });
      // The next one is not held up.
      const { id: next } = await shared().startExport(company, "test");
      expect(next).not.toBe(id);
      await settled(shared(), next, company);
    });

    it("refuses another deployment's export (review round 1, Lows)", async () => {
      await add(
        shared(),
        `test:${unique()}`,
        "words",
        team(`team:${unique()}`)
      );
      const { id } = await shared().startExport(company, "test");
      await settled(shared(), id, company);
      await putBack(shared(), emptyShared);

      await expect(
        called(shared().startRestore(id, "elsewhere"))
      ).rejects.toThrow("no whole company export of this deployment");
    });

    it("after a storage loss, deletes an export made before an erasure, and keeps and restores one made after it (review round 2, P1)", async () => {
      await putBack(shared(), emptyShared);
      const group = `team:${unique()}`;
      const kept = `test:${unique()}`;
      const gone = `test:${unique()}`;
      await add(shared(), kept, "kept words", team(group));
      await add(shared(), gone, "gone words", team(group));
      const { id: before } = await shared().startExport(company, "test");
      await settled(shared(), before, company);
      await shared().eraseSource({ source: gone, reason: "deleted" });
      await tick(shared());
      const { id: after } = await shared().startExport(company, "test");
      await settled(shared(), after, company);

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

    it("starts a failed restore again from the same export, whatever erasure landed meanwhile, and finishes it (review round 2, P2)", async () => {
      await putBack(shared(), emptyShared);
      const group = `team:${unique()}`;
      const sources = Array.from({ length: 60 }, () => `test:${unique()}`);
      for (const source of sources) {
        // oxlint-disable-next-line no-await-in-loop -- one add at a time
        await add(shared(), source, `words of ${source}`, team(group));
      }
      const { id } = await shared().startExport(company, "test");
      await settled(shared(), id, company);
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
        held: await versionsHeld(),
      }).toStrictEqual({
        failed: "failed",
        filesKept: 2,
        again: "running",
        done: "done",
        held: 60,
      });
    });

    it("exports and restores the company's own skills, never Grasp's, and refuses an export while it runs (review round 2, P3 and P4)", async () => {
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
      const { id } = await shared().startExport(company, "test");
      const exported = await settled(shared(), id, company);
      await putBack(shared(), emptyShared);
      await shared().startRestore(id, "test");
      await expect(
        called(shared().startExport(company, "test"))
      ).rejects.toThrow("restoring an export");
      const status = await restoreSettled(id);
      expect({
        exported: exported?.versions,
        restore: status?.state,
        held: await versionsHeld(),
      }).toStrictEqual({ exported: 2, restore: "done", held: 2 });
    });

    it("refuses a person's export, and a person's own store refuses any (threat 4)", async () => {
      const person = unique();
      await add(shared(), `test:${unique()}`, "mine", alone(person));
      const scope: ExportScope = { kind: "person", person };
      const { id } = await shared().startExport(scope, "test");
      await settled(shared(), id, scope);
      await putBack(shared(), emptyShared);

      await expect(called(shared().startRestore(id, "test"))).rejects.toThrow(
        "no whole company export of this deployment has that id"
      );
      await expect(
        called(own(person).startRestore(id, "test"))
      ).rejects.toThrow("a restore goes only into the shared store");
    });
  });
});
