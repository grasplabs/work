// A company's export with writes landing between its parts (exports.ts,
// GRA-1840): the store is held after each part is put, and every kind of
// write of memories lands then. The export is the store as it was at its
// stamp: restored into an empty store, it answers every reader as the
// store did before the export started, and holds nothing written after.
import type { Access, PersonReader } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  differences,
  everyRead,
  exportSettled,
  restoredAfterLoss,
} from "./export-reads.ts";
import type { Store } from "./export-reads.ts";
import { copyOf, restore } from "./store-copy.ts";
import type { Copy } from "./store-copy.ts";

const shared = (): Store => env.BRAIN_STORE.getByName("brain");

/** Waits, on this context's own timers, until `done`: false after 10 s. */
const until = async (done: () => boolean): Promise<boolean> => {
  for (let waited = 0; !done(); waited += 5) {
    if (waited >= 10_000) {
      return false;
    }
    // oxlint-disable-next-line no-await-in-loop -- a poll, bounded above
    await scheduler.wait(5);
  }
  return true;
};

/** The R2 calls the store makes, passed through to the test's bucket. */
const r2Calls = ["get", "head", "put", "delete", "list"] as const;

/**
 * The store's bucket swapped for one that holds each run once a part of an
 * export is put, until the test lets it go: `held` counts the parts put,
 * `released` how many the test let go. Flags in shared memory, each side
 * polling with its own timers.
 */
const holdingParts = async (
  store: Store,
  flags: { held: number; released: number }
): Promise<void> => {
  const bucket = env.BRAIN_OBJECTS;
  const swapped = Object.fromEntries(
    r2Calls.map((name) => [
      name,
      async (...args: unknown[]): Promise<unknown> => {
        const method: unknown = Reflect.get(bucket, name);
        if (typeof method !== "function") {
          throw new TypeError(`R2 has no ${name}`);
        }
        const result: unknown = await Reflect.apply(method, bucket, args);
        const [key] = args;
        if (
          name === "put" &&
          typeof key === "string" &&
          /\/part-\d+\.jsonl$/u.test(key)
        ) {
          flags.held += 1;
          const mine = flags.held;
          await until(() => flags.released >= mine);
        }
        return result;
      },
    ])
  );
  await runInDurableObject(store, (instance) => {
    const objectEnv: unknown = Reflect.get(instance, "env");
    if (typeof objectEnv !== "object" || objectEnv === null) {
      throw new TypeError("The store has no env");
    }
    Reflect.set(instance, "env", { ...objectEnv, BRAIN_OBJECTS: swapped });
  });
};

/** A name only a write between two parts gives: none is in the export. */
const late = (part: number): string => `Late${part}`;

/** What the test adds before the export starts, and who reads it. */
const fixtureOf = async (tag: string) => {
  const one = `team:one-${tag}`;
  const writer: PersonReader = { person: `p1-${tag}`, groups: [one] };
  const confirmer: PersonReader = {
    person: `p2-${tag}`,
    groups: [one, `team:two-${tag}`],
  };
  const readers: PersonReader[] = [
    writer,
    confirmer,
    { person: `p3-${tag}`, groups: [`team:two-${tag}`] },
  ];
  const ones: Access = { kind: "audience", group: one };
  const narrowed = `test:${tag}-1`;
  const kept = `test:${tag}-2`;
  for (const source of [narrowed, kept]) {
    // oxlint-disable-next-line no-await-in-loop -- one source at a time
    await shared().addSource({
      source,
      change: "1",
      text: `words of ${source}`,
      access: ones,
    });
  }
  const theirWord = (attribute: string, value: string) => ({
    about: "c",
    attribute,
    value,
    type: "fact" as const,
    statement: `${attribute} ${value} ${tag}`,
    speaker: { kind: "internal" as const, person: writer.person },
    basis: { kind: "writer" as const, writer: writer.person },
  });
  const systemFact = (attribute: string, value: string, source: string) => ({
    about: "c",
    attribute,
    value,
    type: "fact" as const,
    statement: `${attribute} ${value} ${tag}`,
    speaker: { kind: "system" as const },
    basis: { kind: "source" as const, source, version: 1, quote: "words" },
  });
  const drawn = await shared().addMemories({
    change: `drawn-${tag}`,
    access: ones,
    entities: [
      {
        key: "c",
        kind: "customer",
        names: ["Acme"],
        identifiers: [{ type: "email", value: `acme@${tag}.test` }],
      },
    ],
    memories: [
      systemFact("status", "active", narrowed),
      systemFact("requirement", "sso", kept),
    ],
    extracted: { source: narrowed, version: 1 },
  });
  const acme = drawn.entities.c ?? "";
  const said = await shared().addMemories({
    change: `said-${tag}`,
    access: ones,
    reader: writer,
    entities: [{ key: "c", kind: "customer", id: acme, names: ["Acme BV"] }],
    memories: [
      theirWord("status", "churned"),
      theirWord("requirement", "audit"),
    ],
  });
  await shared().confirmMemory({
    memory: drawn.memories[0] ?? "",
    reader: confirmer,
  });
  return {
    tag,
    readers,
    writer,
    confirmer,
    ones,
    narrowed,
    kept,
    acme,
    drawn,
    said,
    theirWord,
    systemFact,
  };
};
type Fixture = Awaited<ReturnType<typeof fixtureOf>>;

/**
 * What lands after part `part` is put: an add on the same entity, two
 * confirmations, and once each a narrowing, a retirement and an unrelated
 * erasure. Answers the memories it added.
 */
const writeBetween = async (part: number, fixture: Fixture) => {
  const { tag, writer, confirmer, ones, kept, acme, drawn, said } = fixture;
  const added = await shared().addMemories({
    change: `late-${part}-${tag}`,
    access: ones,
    reader: writer,
    entities: [
      {
        key: "c",
        kind: "customer",
        id: acme,
        names: [late(part)],
        identifiers: [{ type: "email", value: `late${part}@${tag}.test` }],
      },
    ],
    memories: [
      fixture.theirWord("status", `late${part}`),
      fixture.systemFact("requirement", `r${part}`, kept),
    ],
    extracted: { source: kept, version: 1 },
  });
  await shared().confirmMemory({
    memory: drawn.memories[1] ?? "",
    reader: confirmer,
  });
  await shared().confirmMemory({
    memory: said.memories[0] ?? "",
    reader: writer,
  });
  if (part === 0) {
    await shared().addSource({
      source: fixture.narrowed,
      change: "2",
      text: `narrowed ${tag}`,
      access: { kind: "none" },
    });
  }
  if (part === 1) {
    await shared().retireMemory({
      memory: said.memories[1] ?? "",
      reader: writer,
    });
  }
  if (part === 2) {
    await shared().erasePerson({
      person: `nobody-${tag}`,
      reason: "person_erased",
    });
  }
  return added.memories;
};

/** All the export `id`'s parts hold, as text. */
const writtenOf = async (id: string): Promise<string> => {
  const files = await env.BRAIN_OBJECTS.list({ prefix: `exports/${id}/` });
  let written = "";
  for (const { key } of files.objects) {
    if (key.endsWith(".jsonl")) {
      // oxlint-disable-next-line no-await-in-loop -- one part at a time
      const object = await env.BRAIN_OBJECTS.get(key);
      // oxlint-disable-next-line no-await-in-loop -- one part at a time
      written += (await object?.text()) ?? "";
    }
  }
  return written;
};

describe("a company's export, with writes between its parts", () => {
  /** The shared store before any test added to it: empty. */
  let empty: Copy = { tables: [], others: [] };

  beforeAll(async () => {
    empty = await copyOf(shared());
  });

  it(
    "is the store at its stamp, whatever is written between its parts",
    { timeout: 60_000 },
    async () => {
      await restore(shared(), empty);
      const fixture = await fixtureOf(crypto.randomUUID().slice(0, 8));
      const asked = {
        readers: fixture.readers,
        entities: [fixture.acme],
        names: ["Acme", "Acme BV", ...[0, 1, 2, 3, 4].map(late)],
        emails: [`acme@${fixture.tag}.test`],
        questions: [`status ${fixture.tag}`],
        asOf: new Date(Date.now() + 60_000),
      };
      const before = await everyRead(shared(), asked);

      const flags = { held: 0, released: 0 };
      await holdingParts(shared(), flags);
      const { id } = await shared().startExport("test");
      const settled: { state?: string; done: boolean } = { done: false };
      const working = (async () => {
        settled.state = await exportSettled(shared, id);
        settled.done = true;
      })();
      const injected: string[] = [];
      let parts = 0;
      // Five parts are expected; a writes-into-the-export bug would make one
      // more after every write: bounded, it fails fast.
      for (; parts < 10;) {
        const putSoFar = parts;
        // oxlint-disable-next-line no-await-in-loop -- one part at a time
        await until(() => flags.held > putSoFar || settled.done);
        if (flags.held <= parts) {
          break;
        }
        // oxlint-disable-next-line no-await-in-loop -- one part at a time
        injected.push(...(await writeBetween(parts, fixture)));
        parts += 1;
        flags.released = parts;
      }
      // Any part past those is let go at once.
      flags.released = Number.POSITIVE_INFINITY;
      await working;
      const written = await writtenOf(id);
      const restored = await restoredAfterLoss(shared, id, empty);
      const after = await everyRead(shared(), asked);

      expect({
        exported: settled.state,
        parts,
        restored,
        lateInExport: [...[0, 1, 2, 3, 4].map(late), ...injected].filter(
          (marker) => written.includes(marker)
        ),
        differ: differences(before, after),
      }).toStrictEqual({
        exported: "done",
        parts: 5,
        restored: "done",
        lateInExport: [],
        differ: [],
      });
    }
  );
});
