import type { KnowledgeApi } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { dutchHandbook } from "./fixtures/dutch-knowledge.ts";
import { mockIdp } from "./idp.ts";
import { collectionWith, knowledgePersonOf } from "./knowledge-searches.ts";
import type { Person } from "./knowledge-searches.ts";
import { openRpc } from "./sign-in.ts";

// Search as people use it: Dutch words find their sections with or without
// diacritics, by prefix, inside compounds and with a typo; results rank
// title over description over text, and fresh over stale; nothing of a
// collection the person can't read is found, ranked or counted (R11); and a
// search that finds nothing is recorded without its words. Apps and agents
// search through their stubs, in knowledge-access.test.ts.

const idp = mockIdp();

/** A signed-in person's Knowledge API, on a connection of their own. */
const personOf = async (role: Role) => await knowledgePersonOf(idp, role);

/** A section of filler text: Dutch words, picked by `seed`. */
const vocabulary = [
  "afspraak",
  "aanvraag",
  "begroting",
  "beleid",
  "contract",
  "declaratie",
  "directie",
  "dienstverband",
  "evaluatie",
  "functie",
  "gesprek",
  "handboek",
  "inkoop",
  "jaarplan",
  "klant",
  "kwartaal",
  "leidinggevende",
  "loon",
  "werkoverleg",
  "overleg",
  "opleiding",
  "pensioen",
  "planning",
  "project",
  "rapportage",
  "rooster",
  "salaris",
  "team",
  "uitvoering",
  "vergadering",
  "verzekering",
  "voorstel",
  "werkplek",
  "zorgverzekering",
  "arbeidsvoorwaarden",
  "thuiswerken",
  "privé",
  "coördinator",
  "financiële",
  "reünie",
];

const filler = (seed: number, words: number) =>
  Array.from(
    { length: words },
    (_, index) =>
      vocabulary[(seed * 31 + index * 17 + index * index) % vocabulary.length]
  ).join(" ");

/** A statement as core prepared and bound it. */
interface Bound {
  query: string;
  values: unknown[];
}

/**
 * Most rows a search reads for each section a common word is in: about 28
 * as it ranks them now (matched, joined to its document, scored, sorted).
 * Looking each section's words up one by one read about 67, and took
 * seconds (GRA-1668).
 */
const rowsPerCommonMatch = 40;

/**
 * What D1's `first` answers of a statement's `results`: its first row, or
 * that row's `column`, or `null` when there is none.
 */
const firstOf = (
  results: Record<string, unknown>[],
  column?: string
): unknown => {
  const [row] = results;
  const answer = column === undefined ? row : row?.[column];
  return answer ?? null;
};

/**
 * `person`'s Knowledge API on a connection that keeps every statement it
 * makes of the knowledge database, with its values, and adds up the rows
 * they read (D1's `meta.rows_read`), the search indexes' own included.
 */
const recordingReads = async (person: Person) => {
  const real = env.KNOWLEDGE;
  const made: { rows: number; statements: Bound[] } = {
    rows: 0,
    statements: [],
  };
  // Each statement is kept as it runs, bound or not, however it runs,
  // and the rows it read added as D1 says (`meta.rows_read`). Only `all`,
  // `run` and a batch say: `first` and `raw` run through `all` too, once,
  // their answers made from its rows. (A row's columns come back by name,
  // so `raw` loses a column whose name another shares: a search that read
  // so would show it, failing, never pass with its reads uncounted.)
  const recorded = (
    statement: D1PreparedStatement,
    query: string,
    values: unknown[] = []
  ): D1PreparedStatement =>
    new Proxy(statement, {
      get: (target, property) => {
        if (property === "bind") {
          return (...bound: unknown[]) =>
            recorded(target.bind(...bound), query, bound);
        }
        const counted = async () => {
          made.statements.push({ query, values });
          const result = await target.all();
          made.rows += result.meta.rows_read;
          return result;
        };
        if (property === "all" || property === "run") {
          return counted;
        }
        if (property === "first") {
          return async (column?: string) => {
            const { results } = await counted();
            return firstOf(results, column);
          };
        }
        if (property === "raw") {
          return async (options?: { columnNames?: boolean }) => {
            const { results } = await counted();
            const rows = results.map((row) => Object.values(row));
            const [first] = results;
            return options?.columnNames === true
              ? [first === undefined ? [] : Object.keys(first), ...rows]
              : rows;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(value, target, args)
          : value;
      },
    });
  const knowledge: D1Database = {
    prepare: (query) => recorded(real.prepare(query), query),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      const results = await real.batch<T>(statements);
      for (const { meta } of results) {
        made.rows += meta.rows_read;
      }
      return results;
    },
    exec: async (query) => await real.exec(query),
    // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
    dump: async () => await real.dump(),
    withSession: (constraint) => real.withSession(constraint),
  };
  const { core } = await openRpc(person.session, {
    coreEnv: { ...env, KNOWLEDGE: knowledge },
  });
  const api: KnowledgeApi = core.authenticate().knowledge;
  return { knowledge: api, made };
};

/** The tables that grow with what the knowledge base holds. */
const corpusTables = new Set([
  "collections",
  "documents",
  "sections",
  "search_rows",
  "search_words",
  "search_trigrams",
]);

/** Words that may follow a table where an alias could stand. */
const keywords = [
  "AS",
  "CROSS",
  "FULL",
  "GROUP",
  "INNER",
  "JOIN",
  "LEFT",
  "LIMIT",
  "NATURAL",
  "ON",
  "ORDER",
  "OUTER",
  "RIGHT",
  "UNION",
  "USING",
  "WHERE",
  "WINDOW",
];

/**
 * A table a query names after FROM or JOIN, and the alias it gives it, if
 * any: never a keyword, which starts the next clause (another JOIN, ON).
 */
const namedPattern = new RegExp(
  String.raw`\b(?:FROM|JOIN)\s+"?(?<table>\w+)"?(?:\s+(?:AS\s+)?"?(?!(?:${keywords.join("|")})\b)(?<alias>\w+)"?)?`,
  "giu"
);

/**
 * The corpus table each name in `query`'s plan stands for: the table
 * itself, or an alias the query gave it, which SQLite's plan prints in
 * its place.
 */
const corpusNamesOf = (query: string): Map<string, string> => {
  const names = new Map([...corpusTables].map((table) => [table, table]));
  for (const { groups } of query.matchAll(namedPattern)) {
    // Names are compared as SQLite does: whatever their case.
    const table = (groups?.table ?? "").toLowerCase();
    const alias = (groups?.alias ?? "").toLowerCase();
    if (corpusTables.has(table) && alias !== "") {
      names.set(alias, table);
    }
  }
  return names;
};

/** A step of a query plan that reads a table whole, or an index none of it. */
const scanPattern =
  /^SCAN (?<table>\S+)(?: VIRTUAL TABLE INDEX \d+:(?<constraints>\S*))?/u;

/**
 * The corpus tables `statement` reads whole, by SQLite's plan for it (an
 * alias resolved to its table): a
 * table scanned row by row, or a full-text index scanned without a MATCH
 * or rowid constraint (FTS5's `M` and `=`).
 */
const tablesReadWhole = async ({ query, values }: Bound): Promise<string[]> => {
  const { results } = await env.KNOWLEDGE.prepare(`EXPLAIN QUERY PLAN ${query}`)
    .bind(...values)
    .all<{ detail: string }>();
  const names = corpusNamesOf(query);
  return results.flatMap(({ detail }) => {
    const step = scanPattern.exec(detail)?.groups;
    const table = names.get((step?.table ?? "").toLowerCase());
    if (table === undefined) {
      return [];
    }
    const constrained = /[M=]/u.test(step?.constraints ?? "");
    return constrained ? [] : [table];
  });
};

/** The full-text indexes, which a search asks by word. */
const fullTextIndexes = new Set(["search_words", "search_trigrams"]);

/** A step that runs for every row of what it reads: a co-routine or a CTE. */
const perRowStepPattern = /^(?:CO-ROUTINE|MATERIALIZE)\b/u;

/**
 * The full-text indexes `statement` asks once for each section it ranks,
 * by SQLite's plan for it: an index looked up by rowid and MATCH (FTS5's
 * `=` and `M`) inside a step that runs for every match (a co-routine or a
 * materialized CTE), not only for the few rows the search returns. Each
 * such lookup reads the word's whole posting list, so a word in thousands
 * of sections costs thousands of reads of the index. The returned rows'
 * snippets, at most a search's limit, are looked up in the outermost query.
 */
const indexesAskedPerMatch = async ({
  query,
  values,
}: Bound): Promise<string[]> => {
  const { results } = await env.KNOWLEDGE.prepare(`EXPLAIN QUERY PLAN ${query}`)
    .bind(...values)
    .all<{ id: number; parent: number; detail: string }>();
  const steps = new Map(results.map((step) => [step.id, step]));
  const names = corpusNamesOf(query);
  /** Whether the step `id` is, or runs inside, one that runs for every match. */
  const perMatch = (id: number): boolean => {
    const step = steps.get(id);
    if (step === undefined) {
      return false;
    }
    return perRowStepPattern.test(step.detail) || perMatch(step.parent);
  };
  return results.flatMap(({ detail, parent }) => {
    const step = scanPattern.exec(detail)?.groups;
    const table = names.get((step?.table ?? "").toLowerCase());
    const byRow = (step?.constraints ?? "").includes("=");
    return table !== undefined &&
      fullTextIndexes.has(table) &&
      byRow &&
      perMatch(parent)
      ? [table]
      : [];
  });
};

describe("search speed", { timeout: 300_000 }, () => {
  // How long a search takes depends on how busy the machine is; how it
  // finds what it finds doesn't. So this asks what keeps a search fast as
  // the corpus grows (it answers in 3 to 30 ms on a laptop): it reaches
  // sections only through its indexes, asks them once per word rather than
  // once per section it ranks, reads a few dozen rows for each section a
  // common word is in, and a search for words few sections hold reads
  // little, however much else there is.
  it("finds sections through its indexes over 5,000 sections, reading a fraction of them", async () => {
    const person = await personOf("user");
    const sectionsOf = (document: number) =>
      Array.from(
        { length: 50 },
        (_, section) =>
          `## Deel ${section}\n${filler(document * 50 + section, 60)}`
      );
    const documents = Array.from({ length: 100 }, (_, document) => ({
      path: `archief/${document}.md`,
      text: [`# Document ${document}`, ...sectionsOf(document)].join("\n"),
    }));
    await collectionWith(person, [...documents, ...dutchHandbook]);
    const held = await env.KNOWLEDGE.prepare(
      "SELECT count(*) AS sections FROM sections"
    ).first<{ sections: number }>();
    const sections = held?.sections ?? 0;
    const recording = await recordingReads(person);
    /** The corpus tables `query`'s search read whole, and the rows it read. */
    const searched = async (query: string) => {
      recording.made.rows = 0;
      recording.made.statements = [];
      await recording.knowledge.search(query);
      const whole = await Promise.all(
        recording.made.statements.map(tablesReadWhole)
      );
      const asked = await Promise.all(
        recording.made.statements.map(indexesAskedPerMatch)
      );
      return {
        readWhole: whole.flat(),
        askedPerMatch: asked.flat(),
        rows: recording.made.rows,
        // Its own full-text statement was seen: what's asserted of the
        // statements is of the search's.
        seen: recording.made.statements.some(({ query: made }) =>
          made.includes("search_words")
        ),
      };
    };
    const everyQuery = [
      "vakantiedagen",
      "financiele planning",
      "salaris",
      "zorgverzekering thuiswerken",
      "verzekering",
      // A word with one too short for trigrams, which must be a word too.
      "verzekering de",
      "coordinator",
      "reiskostenvergoedng",
      "pensioenregeling",
    ];
    // Words only the handbook's few sections hold, one with a typo.
    const rare = ["vakantiedagen", "pensioenregeling", "reiskostenvergoedng"];

    // A word in thousands of sections, as itself and inside compounds.
    const common = "verzekering";
    const holding = await env.KNOWLEDGE.prepare(
      "SELECT count(*) AS sections FROM search_trigrams WHERE search_trigrams MATCH ?"
    )
      .bind(`"${common}"`)
      .first<{ sections: number }>();
    const commonSections = holding?.sections ?? 0;

    const readWhole: Record<string, string[]> = {};
    const askedPerMatch: Record<string, string[]> = {};
    const seen: Record<string, boolean> = {};
    const rows: Record<string, boolean> = {};
    for (const query of everyQuery) {
      // oxlint-disable-next-line no-await-in-loop -- one search at a time
      const found = await searched(query);
      readWhole[query] = found.readWhole;
      askedPerMatch[query] = found.askedPerMatch;
      seen[query] = found.seen;
      if (rare.includes(query)) {
        rows[query] = found.rows < sections / 10;
      }
      if (query === common) {
        rows[query] = found.rows < commonSections * rowsPerCommonMatch;
      }
    }

    expect({
      sections: sections >= 5000,
      commonSections: commonSections >= sections / 2,
      seen,
      readWhole,
      askedPerMatch,
      rows,
    }).toStrictEqual({
      sections: true,
      commonSections: true,
      seen: Object.fromEntries(everyQuery.map((query) => [query, true])),
      // Through the indexes, however many sections match: a word in
      // thousands of them costs what they match, never the whole corpus.
      readWhole: Object.fromEntries(everyQuery.map((query) => [query, []])),
      // Each word asked of an index once, never once per section ranked.
      askedPerMatch: Object.fromEntries(everyQuery.map((query) => [query, []])),
      // A word in a handful of sections reads little of the rest, and a
      // word in thousands reads a few dozen rows for each.
      rows: Object.fromEntries([...rare, common].map((query) => [query, true])),
    });
  });
});
