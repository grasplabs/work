import type {
  CommandOptions,
  CommandReceipt,
  RememberInput,
} from "@grasp-os/brain/contract";
import { remember } from "@grasp-os/brain/memories";
import { rebuildSearchIndex } from "@grasp-os/brain/search-erasure";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";

import { emailHashOf, emailKeyVersion } from "../src/erased-people.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { purgeFromKnowledge } from "../src/person-erasure.ts";
import type { Idp } from "./idp.ts";
import { ownCollectionOf } from "./knowledge.ts";
import { signedInApi, unique } from "./sign-in.ts";

// What the tests of purging a person from Knowledge share
// (knowledge-purge*.test.ts): the purge a person's erasure runs in its
// `brain` area (person-erasure.ts `purgeFromKnowledge`). Each test file signs its people in through
// its own mocked IdP: `mockIdp()` registers hooks, so it can't be called
// here.

/** Signing people in can be slow on CI. */
export const setUpTime = { timeout: 60_000 };

/** A person signed in, with their API. */
export type Person = Awaited<ReturnType<typeof signedInApi>>;

export const hexOf = (text: string): string =>
  [...new TextEncoder().encode(text)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();

/** A term the words index keeps as one token: ASCII letters and digits. */
const oneAsciiToken = /^[a-z0-9]+$/u;

/**
 * Whether the words index holds `token`, as the index reads its pages
 * (FTS5 `MATCH` on the token itself): its pages keep a term that follows
 * another with the same first letters as only the letters that differ, so
 * its bytes aren't in a page in one piece, and a scan for them misses it.
 * (D1 refuses `fts5vocab`, which would list the terms.)
 */
const wordsIndexHolds = async (token: string): Promise<boolean> =>
  (await env.KNOWLEDGE.prepare(
    "SELECT 1 AS held FROM search_words WHERE search_words MATCH ? LIMIT 1"
  )
    .bind(`"${token}"`)
    .first()) !== null;

/** Whether any object in the Brain bucket holds `lower`, in any case. */
const bucketHolds = async (lower: string): Promise<boolean> => {
  const listed = await env.BRAIN_OBJECTS.list();
  const texts = await Promise.all(
    listed.objects.map(async ({ key }) => {
      const object = await env.BRAIN_OBJECTS.get(key);
      return (await object?.text()) ?? "";
    })
  );
  return texts.some((text) => text.toLowerCase().includes(lower));
};

/**
 * Every `table.column` of the Knowledge database that holds `term`, in any
 * case, as text or among the bytes of a row, and the words index's pages
 * (`search_words_data.block`) when the index finds it as a token
 * (`wordsIndexHolds`), whatever its pages' bytes show. The page directory
 * (`search_words_idx`) keeps its separators whole, so its bytes say it.
 * Trigram pages keep three characters at a time, so the trigram index
 * shows only in its columns, which read the words index's content.
 * `BRAIN_OBJECTS` when an object in the bucket
 * of versions' texts holds it.
 */
export const holding = async (term: string): Promise<string[]> => {
  const { results: tables } = await env.KNOWLEDGE.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
  ).all<{ name: string }>();
  const lower = term.toLowerCase();
  const found = new Set<string>();
  for (const { name: table } of tables) {
    // oxlint-disable-next-line no-await-in-loop -- one table at a time
    const { results: columns } = await env.KNOWLEDGE.prepare(
      "SELECT name FROM pragma_table_info(?)"
    )
      .bind(table)
      .all<{ name: string }>();
    for (const { name: column } of columns) {
      // oxlint-disable-next-line no-await-in-loop -- one column at a time
      const row = await env.KNOWLEDGE.prepare(
        `SELECT count(*) AS n FROM "${table}"
         WHERE instr(lower(CAST("${column}" AS TEXT)), ?) > 0
           OR instr(hex("${column}"), ?) > 0`
      )
        .bind(lower, hexOf(lower))
        .first<{ n: number }>();
      if ((row?.n ?? 0) > 0) {
        found.add(`${table}.${column}`);
      }
    }
  }
  if (oneAsciiToken.test(lower) && (await wordsIndexHolds(lower))) {
    found.add("search_words_data.block");
  }
  if (await bucketHolds(lower)) {
    found.add("BRAIN_OBJECTS");
  }
  return [...found].toSorted();
};

/**
 * `userId` removed by `admin`, and their erasure begun and not yet run:
 * the rows `erasePerson` (person-erasure.ts) writes before its steps run,
 * its own name, email hash and every area pending, which its steps would
 * then finish, while the test drives one area itself.
 */
export const erasing = async (admin: Person, userId: string): Promise<void> => {
  // Removing someone removed already is safe: it finishes what is left.
  await admin.api.members.remove(userId);
  const preview = await admin.api.members.erasure(userId);
  if (preview.erasure !== null) {
    return;
  }
  const now = Date.now();
  const emailHash =
    preview.email === null ? null : await emailHashOf(env, preview.email);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO person_erasures (user_id, name, email_hash, email_key_version, requested_by, requested_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)"
    ).bind(userId, preview.name, emailHash, emailKeyVersion, admin.userId, now),
    ...preview.areas.map((area) =>
      env.DB.prepare(
        "INSERT INTO person_erasure_areas (user_id, area, state, attempts, updated_at) VALUES (?, ?, 'pending', 0, ?)"
      ).bind(userId, area, now)
    ),
  ]);
};

/**
 * Purges `userId` from Knowledge as `admin` asked, once their erasure is
 * begun, as the erasure's `brain` area does, on a core that sees
 * `coreEnv`: what it removed.
 */
export const purged = async (
  admin: Person,
  userId: string,
  coreEnv: Env = env
) => {
  await erasing(admin, userId);
  return await purgeFromKnowledge(coreEnv, admin.userId, userId);
};

interface KnowledgeHooks {
  /** Before each statement is made. */
  prepare?: (query: string) => void;
  /** Before each batch runs: throwing fails it. */
  beforeBatch?: () => void | Promise<void>;
  /** After each batch ran, before the caller gets its results. */
  afterBatch?: () => Promise<void>;
}

/**
 * Core's bindings with the Knowledge database seen through `hooks`:
 * something happening at a chosen point of a purge.
 */
export const envWith = (hooks: KnowledgeHooks): Env => {
  const real = env.KNOWLEDGE;
  const knowledge: D1Database = {
    prepare: (query) => {
      hooks.prepare?.(query);
      return real.prepare(query);
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      await hooks.beforeBatch?.();
      const results = await real.batch<T>(statements);
      await hooks.afterBatch?.();
      return results;
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
  return { ...env, KNOWLEDGE: knowledge };
};

/**
 * Rebuilds the search index, paying the rebuilds earlier tests' purges
 * left owed (one that failed after its writes leaves the next purge to
 * rebuild): a test counting a purge's rebuilds counts only its own.
 */
export const payOwedRebuilds = async (): Promise<void> => {
  await rebuildSearchIndex(drizzle(env.KNOWLEDGE));
};

/** How many sections the search index holds. */
export const indexedSections = async (): Promise<number> => {
  const row = await env.KNOWLEDGE.prepare(
    "SELECT count(*) AS n FROM search_rows"
  ).first<{ n: number }>();
  return row?.n ?? 0;
};

/** `value` as `length` letters, a to z: a word with no digit in it. */
export const lettersOf = (value: number, length: number): string =>
  Array.from({ length }, (_, at) =>
    String.fromCodePoint(
      97 + (Math.floor(value / 26 ** (length - at - 1)) % 26)
    )
  ).join("");

/** Saves `text` over what is at `path` now. */
export const saveOver = async (
  person: Person,
  collectionId: string,
  path: string,
  text: string,
  message?: string
) => {
  const { documents } = await person.api.knowledge.listDocuments(collectionId);
  const current = documents.find((document) => document.path === path);
  return await person.api.knowledge.saveDocument({
    collectionId,
    path,
    text,
    ifVersion: current?.currentVersion ?? 0,
    ...(message === undefined ? {} : { message }),
  });
};

/** `value`'s own member `key`, bound to it when a method. */
const member = (value: object, key: string | symbol): unknown => {
  const found: unknown = Reflect.get(value, key);
  return typeof found === "function" ? found.bind(value) : found;
};

/**
 * Core's bindings with a Knowledge database that adds up the rows each batch writes
 * (as `countingWrites`), and runs `beforeRead` once, as a personal purge
 * first reads what the search index holds of the collection: a change
 * made after the purge listed the collection's versions, as it reads
 * their text. With `refuseRead`, its first read fails, repeating its query
 * and parameters, as a platform's refusal would. `rebuilds` counts the
 * rebuilds of the whole index it ran.
 */
export const watchingPurge = ({
  beforeRead,
  refuseRead = false,
}: { beforeRead?: () => Promise<void>; refuseRead?: boolean } = {}) => {
  const real = env.KNOWLEDGE;
  const written = { rows: 0, rebuilds: 0 };
  let pending = beforeRead;
  const knowledge: D1Database = {
    prepare: (query) => {
      if (
        query.includes(
          "INSERT INTO search_words (search_words) VALUES ('rebuild')"
        )
      ) {
        written.rebuilds += 1;
      }
      const reading = query.includes("p.key AS key");
      const statement = real.prepare(
        refuseRead && query.includes("AS characters")
          ? query.replace("AS characters", "AS characters, refused_here")
          : query
      );
      const run = pending;
      if (run === undefined || !reading) {
        return statement;
      }
      pending = undefined;
      return new Proxy(statement, {
        get: (target, key) =>
          key === "bind"
            ? (...values: unknown[]) =>
                new Proxy(target.bind(...values), {
                  get: (bound, method) =>
                    method === "all" || method === "raw"
                      ? async () => {
                          await run();
                          return method === "all"
                            ? await bound.all()
                            : await bound.raw();
                        }
                      : member(bound, method),
                })
            : member(target, key),
      });
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      const results = await real.batch<T>(statements);
      for (const { meta } of results) {
        written.rows += meta.changes;
      }
      return results;
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
  return { coreEnv: { ...env, KNOWLEDGE: knowledge }, written };
};

/**
 * A memory of `person`'s own, kept by today's Brain as its remember left
 * it, with its receipt: nothing in core remembers into it any more, and
 * its purge still erases what it kept.
 */
export const seedMemory = async (
  person: Person,
  input: RememberInput,
  options: CommandOptions
): Promise<CommandReceipt> =>
  await remember(
    brainOf(env),
    { type: "person", person: await person.api.whoami() },
    input,
    options
  );

/** Remembers `text` as `person`, under a key of its own. */
export const rememberAs = async (person: Person, text: string) =>
  await seedMemory(
    person,
    { kind: "fact", text },
    { idempotencyKey: `purge-${unique()}-${unique()}` }
  );

/**
 * Core's bindings on a platform that refuses secure deletes, as a remote
 * one may (search-erasure.ts), on which the purge's index rebuild also
 * fails once. The index's secure deletes are turned off first: a
 * delete's terms then stay in the index's pages until it is rebuilt.
 */
export const rebuildFailingOnce = async (): Promise<Env> => {
  await env.KNOWLEDGE.batch([
    env.KNOWLEDGE.prepare(
      "INSERT INTO search_words (search_words, rank) VALUES ('secure-delete', 0)"
    ),
    env.KNOWLEDGE.prepare(
      "INSERT INTO search_trigrams (search_trigrams, rank) VALUES ('secure-delete', 0)"
    ),
  ]);
  let refuseNext = false;
  let failNext = false;
  let failed = false;
  return envWith({
    prepare: (query) => {
      if (query.includes("'secure-delete'")) {
        refuseNext = true;
      } else if (!failed && query.includes("VALUES ('rebuild')")) {
        failNext = true;
      }
    },
    beforeBatch: () => {
      if (refuseNext) {
        refuseNext = false;
        failNext = false;
        throw new Error("not authorized");
      }
      if (failNext) {
        failNext = false;
        failed = true;
        throw new Error("D1 is unavailable");
      }
    },
  });
};

/** The helpers that sign people in through `idp`. */
export const purgesWith = (idp: Idp) => {
  const personOf = async (role: Role) => await signedInApi(idp, role);

  /** A person whose own collection (only they read it) holds `files`, by path. */
  const leaverWith = async (files: Record<string, string>) => {
    const leaver = await personOf("user");
    const personal = await ownCollectionOf(leaver);
    for (const [path, text] of Object.entries(files)) {
      // oxlint-disable-next-line no-await-in-loop -- one document at a time
      await saveOver(leaver, personal, path, text);
    }
    return { leaver, personal };
  };

  return { leaverWith };
};
