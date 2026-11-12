import {
  recallBudgetMax,
  recallLimit,
  sourceTextMaxBytes,
} from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  addSource,
  eraseSource,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { mockIdp } from "./idp.ts";
import { noProducers } from "./no-producers.ts";
import { signedInWithRole, unique } from "./sign-in.ts";

// Recall finds words in their other forms (GRA-1725): every word is
// indexed under its stem in English, Dutch, German, French and Spanish,
// and the question is stemmed the same way, with no language to choose.
// A passage is still scored on its own words: the form asked for above
// another form, and the common words of the five languages left out of a
// question, so they never outweigh the word that matters.

const idp = mockIdp();

/** A member of the organization, signed in. */
const person = async (): Promise<string> => {
  const { userId } = await signedInWithRole(idp, "user");
  return userId;
};

/** Readable by `personId` alone. */
const ownedBy = (personId: string): SourceReaders => ({
  kind: "owner",
  personId,
});

/** Adds `text` as a source of its own, answering its identity. */
const add = async (
  text: string,
  readers: SourceReaders
): Promise<SourceRef> => {
  const { source } = await addSource(env, {
    source: { producer: "upload", id: crypto.randomUUID() },
    change: crypto.randomUUID(),
    text,
    readers,
  });
  return source;
};

/** What `personId` recalls for `question`, by source, best first. */
const recalledAs = async (
  personId: string,
  question: string
): Promise<SourceRef[]> => {
  const { items: chunks } = await recallAs(env, personId, {
    question,
    budget: { tokens: recallBudgetMax },
  });
  return chunks.map(({ source }) => source);
};

/** `word` 150 times: a paragraph too long to share a passage with another. */
const filler = (word: string): string => `${word} `.repeat(150).trim();

/**
 * A mark of digits alone: no stemmer rewrites a digit, so a word built on
 * it keeps the mark whole in every stem, as the index pages hold it.
 */
const digitsMark = (): string =>
  String(crypto.getRandomValues(new Uint32Array(1))[0]);

/** The Brain's one store, as core reaches it. */
const store = () => env.BRAIN_STORE.getByName("brain");

/** The store's two word indexes: words as written, and their stems. */
const wordIndexes = ["chunk_words", "chunk_stems"] as const;

/**
 * Whether each word index still answers for a term starting with `prefix`
 * (a word, or any of its stems), as FTS5 lists the terms it can find.
 */
const indexesFind = async (prefix: string): Promise<boolean[]> =>
  await runInDurableObject(store(), (_instance, state) => {
    const { sql } = state.storage;
    return wordIndexes.map((index) => {
      sql.exec(
        `CREATE VIRTUAL TABLE held_terms USING fts5vocab(${index}, 'row')`
      );
      const found =
        sql
          .exec(
            "SELECT 1 FROM held_terms WHERE substr(term, 1, length(?1)) = ?1",
            prefix
          )
          .toArray().length > 0;
      sql.exec("DROP TABLE held_terms");
      return found;
    });
  });

/**
 * Whether each word index still holds `term`'s bytes anywhere in its
 * stored pages (FTS5's `_data` tables): what an erased word must not leave
 * behind, even where no search finds it any more.
 */
const indexesStore = async (term: string): Promise<boolean[]> =>
  await runInDurableObject(store(), (_instance, state) =>
    wordIndexes.map(
      (index) =>
        state.storage.sql
          .exec(
            `SELECT 1 FROM ${index}_data WHERE instr(block, CAST(? AS BLOB)) > 0`,
            term
          )
          .toArray().length > 0
    )
  );

describe("finding words in their other forms", { timeout: 120_000 }, () => {
  it("finds the passage of a long document that holds another form of the word, and only that passage", async () => {
    const reader = await person();
    const tag = `w${unique()}`;
    // Paragraphs too long to share a passage: each is a chunk of its own.
    const passages = [
      `${filler("magazijn")} ${tag}`,
      `${filler("rooster")} ${tag}`,
      `De facturen van maart ${tag} ${filler("leverancier")}`,
      `${filler("verlof")} ${tag}`,
    ];
    const source = await add(passages.join("\n\n"), ownedBy(reader));

    const { items: chunks } = await recallAs(env, reader, {
      question: `factuur ${tag}`,
      budget: { tokens: recallBudgetMax },
    });

    expect(chunks[0]).toMatchObject({ source, text: passages[2] });
    expect(chunks).toHaveLength(passages.length);
  });

  it("finds a word by its other forms in English, Dutch, German, French and Spanish, in either direction", async () => {
    const reader = await person();
    const pairs = [
      ["The invoices for March", "invoice"],
      ["One meeting a week", "meetings"],
      ["De facturen van maart", "factuur"],
      ["Het rooster voor zaterdag", "roosters"],
      ["Alle medewerkers krijgen een bericht", "medewerker"],
      ["De vergaderingen gaan door", "vergadering"],
      ["Die Rechnungen für März", "Rechnung"],
      ["Der Vertrag läuft aus", "Verträge"],
      ["Les factures de mars", "facture"],
      ["Une livraison par semaine", "livraisons"],
      ["Las facturas de marzo", "factura"],
      ["Los pedidos llegan el lunes", "pedido"],
    ] as const;
    const added = await Promise.all(
      pairs.map(async ([text]) => await add(text, ownedBy(reader)))
    );

    for (const [index, [, question]] of pairs.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one question at a time
      await expect(recalledAs(reader, question)).resolves.toContainEqual(
        added[index]
      );
    }
  });

  it("ranks the form asked for above another form, whatever hidden sources hold", async () => {
    const [reader, other] = await Promise.all([person(), person()]);
    const tag = `w${unique()}`;
    // The other form in a shorter passage, which shorter-first alone would
    // put first.
    const otherForm = await add(`factuur ${tag}`, ownedBy(reader));
    const asAsked = await add(
      `facturen ${tag} met nog wat woorden erbij`,
      ownedBy(reader)
    );
    const question = `facturen ${tag}`;
    const before = await recalledAs(reader, question);
    expect(before).toStrictEqual([asAsked, otherForm]);

    // More hidden passages than a recall returns, in both forms.
    for (let index = 0; index <= recallLimit; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await add(`factuur facturen ${tag}`, ownedBy(other));
    }

    await expect(recalledAs(reader, question)).resolves.toStrictEqual(before);
  });

  it("never lets common words outweigh the word that matters", async () => {
    const reader = await person();
    const common = await add(
      "Wat is het van de en een, wat is het van de en een; the a of and to is",
      ownedBy(reader)
    );
    const roster = await add(
      "Het zaterdagrooster: rooster voor de zaterdag, door Anna gemaakt",
      ownedBy(reader)
    );

    // The passage with every common word of the question comes after the
    // one with its words that matter.
    await expect(
      recalledAs(reader, "Wat is het rooster van de zaterdag?")
    ).resolves.toStrictEqual([roster, common]);
    // A question of common words alone still asks for them.
    await expect(recalledAs(reader, "wat is het")).resolves.toStrictEqual([
      common,
      roster,
    ]);
  });

  it("still counts a word that is a stop word in another language, after the words that matter", async () => {
    const reader = await person();
    const owned = ownedBy(reader);
    // Each pair: the passage the question means, and a shorter one holding
    // only its other word, which shorter-first alone would put first.
    const cases = [
      // "war" is a German stop word, "door" a Dutch one, "ben" and "de"
      // Dutch ones; "won't" is cut into "won" and "t".
      ["war room", "The war room is on the second floor", "Room 4"],
      ["front door", "The front door code changes on Monday", "Front desk"],
      ["Ben de Vries", "Ben de Vries leads the sales team", "Anna Vries"],
      ["won't pay", "Customers who won't pay get a reminder", "Pay slip"],
    ] as const;
    const added = [];
    for (const [, meant, other] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one pair at a time
      added.push([await add(meant, owned), await add(other, owned)] as const);
    }
    const found = [];
    for (const [question] of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one question at a time
      const recalled = await recalledAs(reader, question);
      found.push(recalled.slice(0, 2));
    }

    expect(found).toStrictEqual(added.map(([meant, other]) => [meant, other]));
  });

  it("finds what shares only a question's common words after what its other words find, and never what the reader may not read", async () => {
    const [reader, other] = await Promise.all([person(), person()]);
    const tag = `w${unique()}`;
    const telling = await add(`Laptop ${tag} bestellen`, ownedBy(reader));
    const phrasing = await add(
      "Wie en wat: de servicedesk, voor wie vastloopt",
      ownedBy(reader)
    );
    await add("Wie en wat: de servicedesk, voor wie vastloopt", ownedBy(other));

    const found = await recalledAs(reader, `Wie helpt bij de laptop ${tag}?`);

    expect(found.slice(0, 2)).toStrictEqual([telling, phrasing]);
  });

  it("finds ß by ss, ø, æ and œ by their plain letters, and keeps dotless ı apart", async () => {
    const reader = await person();
    const street = await add("Die Straße ist gesperrt", ownedBy(reader));
    const windPark = await add("Ørsted bouwt het windpark", ownedBy(reader));
    const apple = await add("Æblekage til frokost", ownedBy(reader));
    const heart = await add("Le cœur du projet", ownedBy(reader));
    const sword = await add("Bir kılıç sattı", ownedBy(reader));

    const asked = [
      ["strasse", [street]],
      ["STRAẞE", [street]],
      ["orsted", [windPark]],
      ["aeblekage", [apple]],
      ["coeur", [heart]],
      ["kılıç", [sword]],
      // Dotless ı is a letter of its own, as Unicode keeps it.
      ["kilic", []],
    ] as const;
    const found = await Promise.all(
      asked.map(async ([question]) => await recalledAs(reader, question))
    );

    expect(found).toStrictEqual(asked.map(([, sources]) => sources));
  });

  it("takes the largest adversarial sources and questions in its stride, and keeps answering", async () => {
    const reader = await person();
    // As many distinct words as fit, each with an ending every stemmer
    // works on; and words at the longest the stemmers take, of a letter
    // they scan back and forth.
    const distinct = Array.from(
      { length: sourceTextMaxBytes / 12 },
      (_, index) => `w${index.toString(36)}ingen`
    ).join(" ");
    const longest = `${"y".repeat(64)} `.repeat(sourceTextMaxBytes / 65);
    for (const text of [distinct, longest]) {
      // oxlint-disable-next-line no-await-in-loop -- one source at a time
      await add(text, ownedBy(reader));
    }
    const after = `w${unique()}`;
    const id = await add(`Added after them: ${after}`, ownedBy(reader));

    await expect(recalledAs(reader, after)).resolves.toStrictEqual([id]);
    await expect(
      recalledAs(reader, `${"y".repeat(64)} `.repeat(30))
    ).resolves.toHaveLength(recallLimit);
  });
});

describe("erasing words", { timeout: 60_000 }, () => {
  it("takes an erased chunk's words out of both the word and the stem index and their pages at once", async () => {
    const reader = await person();
    // Marks no other word holds, inside words with an ending the stemmers
    // take off: indexed as written and as stems. Digits alone, which no
    // stemmer rewrites, behind "xq" and "zq", which no other test's words
    // start with: FTS5 stores a term after the prefix it shares with the
    // one before it, so a mark rewritten inside or a shared start could
    // hide part of it from the page search.
    const [kept, erased] = [digitsMark(), digitsMark()];
    await add(`xq${kept}ingen stays`, ownedBy(reader));
    const goes = await add(`zq${erased}ingen goes`, ownedBy(reader));
    await expect(indexesFind(`zq${erased}`)).resolves.toStrictEqual([
      true,
      true,
    ]);
    await expect(indexesStore(erased)).resolves.toStrictEqual([true, true]);

    // Erased (GRA-1729): no search finds its words, and the indexes'
    // pages hold nothing of them, with no compaction.
    await eraseSource(env, { source: goes, reason: "deleted" });
    await expect(indexesFind(`zq${erased}`)).resolves.toStrictEqual([
      false,
      false,
    ]);

    await expect(indexesStore(erased)).resolves.toStrictEqual([false, false]);
    await expect(indexesFind(`xq${kept}`)).resolves.toStrictEqual([true, true]);
  });
});

/**
 * Puts the store's word indexes back as a store from before stems holds
 * them: for each chunk holding one of `marks`, no stems, and its words as
 * the first rules folded them (the whole text, no primary letters, so
 * "Straße" is "straße"); and the store's rules number at 1, no rebuild
 * under way. As an older release left a store, written here because no
 * code of this one writes it.
 */
const toFirstRules = async (marks: readonly string[]): Promise<void> => {
  const accents =
    /(?<letter>[\p{sc=Latin}\p{sc=Greek}\p{sc=Cyrillic}\p{sc=Hebrew}\p{sc=Arabic}])\p{M}+/gu;
  const firstFold = (text: string): string =>
    text
      .normalize("NFKD")
      .replace(accents, "$<letter>")
      .normalize("NFC")
      .toLowerCase();
  await runInDurableObject(store(), (_instance, state) => {
    const { sql } = state.storage;
    for (const mark of marks) {
      const rows = sql
        .exec<{ row: number; text: string }>(
          "SELECT row, text FROM chunks WHERE instr(text, ?) > 0",
          mark
        )
        .toArray();
      for (const { row, text } of rows) {
        sql.exec("DELETE FROM chunk_stems WHERE rowid = ?", row);
        sql.exec("DELETE FROM chunk_words WHERE rowid = ?", row);
        sql.exec(
          "INSERT INTO chunk_words (rowid, text) VALUES (?, ?)",
          row,
          firstFold(text)
        );
      }
    }
    sql.exec("UPDATE word_index SET version = 1, target = 1, cursor = 0");
  });
};

/** How many of the chunks holding `mark` the words index finds by `term`. */
const chunksFoundBy = async (mark: string, term: string): Promise<number> =>
  await runInDurableObject(
    store(),
    (_instance, state) =>
      state.storage.sql
        .exec<{ found: number }>(
          `SELECT count(*) AS found FROM chunk_words
        WHERE chunk_words MATCH ?1
          AND rowid IN (SELECT row FROM chunks WHERE instr(text, ?2) > 0)`,
          `"${term}"`,
          mark
        )
        .one().found
  );

/** The store's word index rules number, and the rebuild's place. */
const wordIndexState = async () =>
  await runInDurableObject(store(), (_instance, state) =>
    state.storage.sql
      .exec<{ version: number; target: number; cursor: number }>(
        "SELECT version, target, cursor FROM word_index"
      )
      .one()
  );

/** The queue's clock across the file: only forward, as core's clock goes. */
const clock = { at: Date.now() };

/** One tick of core's clock, a minute after the last. */
const tick = async (): Promise<void> => {
  clock.at = Math.max(clock.at, Date.now()) + 60_000;
  await workBrain(env, new Date(clock.at), noProducers);
};

/** Ticks until the store's word indexes are current: how many it took. */
const ticksUntilRebuilt = async (most = 100): Promise<number> => {
  for (let ticks = 0; ticks < most; ticks += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time
    const { version } = await wordIndexState();
    if (version === 2) {
      return ticks;
    }
    // oxlint-disable-next-line no-await-in-loop -- one tick at a time
    await tick();
  }
  return Number.POSITIVE_INFINITY;
};

/** Kills the store, as a crash or a restart would. */
const killStore = async (): Promise<void> => {
  try {
    await runInDurableObject(store(), (_instance, state) => {
      state.abort("Killed by the test");
    });
  } catch {
    // The kill ends the call it was made in.
  }
};

describe(
  "rebuilding the word indexes when their rules change",
  { timeout: 300_000 },
  () => {
    it("finds other forms and newly folded letters in an older store's passages once their turn in the rebuild came, and never another reader's", async () => {
      const [reader, other] = await Promise.all([person(), person()]);
      const mark = `w${unique()}`;
      const invoices = await add(
        `De facturen van maart ${mark}`,
        ownedBy(reader)
      );
      const street = await add(
        `Die Straße ist gesperrt ${mark}`,
        ownedBy(reader)
      );
      await add(`De facturen van april ${mark}`, ownedBy(other));
      await toFirstRules([mark]);

      const before = {
        invoice: await recalledAs(reader, "factuur"),
        street: await recalledAs(reader, "strasse"),
        firstRules: await chunksFoundBy(mark, "straße"),
      };
      const ticks = await ticksUntilRebuilt();

      expect({
        before,
        rebuilt: ticks > 0 && Number.isFinite(ticks),
        invoice: await recalledAs(reader, "factuur"),
        street: await recalledAs(reader, "strasse"),
        other: await recalledAs(other, "strasse"),
        // The first rules' rows went: none is left beside the new ones.
        firstRules: await chunksFoundBy(mark, "straße"),
      }).toStrictEqual({
        before: { invoice: [], street: [], firstRules: 1 },
        rebuilt: true,
        invoice: [invoices],
        street: [street],
        other: [],
        firstRules: 0,
      });
    });

    it("finds symbols that fold into letters by those letters, as the first rules did, on a fresh add and after a rebuild", async () => {
      const reader = await person();
      const mark = `w${unique()}`;
      // "㍿" folds to "株式会社", "℡" to "tel", "Ⓐ" to "a".
      const symbols = await add(`㍿ ℡ Ⓐ ${mark}`, ownedBy(reader));
      const questions = ["株式会社", "TEL", "a"];
      const foundBy = async (): Promise<SourceRef[][]> =>
        await Promise.all(
          questions.map(async (question) => await recalledAs(reader, question))
        );

      const fresh = await foundBy();
      await toFirstRules([mark]);
      const firstRules = await foundBy();
      const ticks = await ticksUntilRebuilt();

      expect({
        fresh,
        firstRules,
        rebuilt: Number.isFinite(ticks),
        after: await foundBy(),
      }).toStrictEqual({
        fresh: questions.map(() => [symbols]),
        firstRules: questions.map(() => [symbols]),
        rebuilt: true,
        after: questions.map(() => [symbols]),
      });
    });

    it("goes on after the store stops mid-rebuild, and indexes every passage exactly once", async () => {
      const reader = await person();
      const mark = `m${digitsMark()}`;
      // Paragraphs too long to share a passage, more than a tick rebuilds.
      const count = 450;
      const paragraphs = Array.from(
        { length: count },
        (_, index) => `${mark}x${index}ingen ${"woord ".repeat(110).trim()}`
      );
      await add(paragraphs.join("\n\n"), ownedBy(reader));
      await toFirstRules([mark]);

      await tick();
      const midway = await wordIndexState();
      await killStore();
      const ticks = await ticksUntilRebuilt();
      const indexed = await runInDurableObject(store(), (_instance, state) => {
        const { sql } = state.storage;
        return ["chunk_words", "chunk_stems"].map((index) => {
          sql.exec(
            `CREATE VIRTUAL TABLE held_instances USING fts5vocab(${index}, 'instance')`
          );
          const [counts] = sql
            .exec<{ chunks: number; twice: number }>(
              `SELECT
              (SELECT count(DISTINCT doc) FROM held_instances WHERE substr(term, 1, length(?1)) = ?1) AS chunks,
              (SELECT count(*) FROM (SELECT 1 FROM held_instances GROUP BY doc, term HAVING count(*) > 1)) AS twice`,
              mark
            )
            .toArray();
          sql.exec("DROP TABLE held_instances");
          return counts;
        });
      });

      const { items: chunks } = await recallAs(env, reader, {
        question: `${mark}x7ing`,
        budget: { tokens: recallBudgetMax },
      });

      expect({
        midway:
          midway.version === 1 && midway.target === 2 && midway.cursor > 0,
        rebuilt: Number.isFinite(ticks),
        indexed,
        found: chunks.length,
      }).toStrictEqual({
        midway: true,
        rebuilt: true,
        indexed: [
          { chunks: count, twice: 0 },
          { chunks: count, twice: 0 },
        ],
        found: 1,
      });
    });

    it("marks a store with no passages current as it starts, with nothing to rebuild", async () => {
      // A person's own store makes its schema at its first write: here an
      // instruction file, which has no passages.
      const owner = `person-${crypto.randomUUID()}`;
      const empty = env.BRAIN_STORE.getByName(`person:${owner}`);
      await empty.addInstructions({
        source: "instructions:words-test",
        change: "1",
        text: "Answer in English.",
        access: { kind: "owner", person: owner },
      });

      await expect(
        runInDurableObject(empty, (_instance, state) =>
          state.storage.sql
            .exec<{ version: number; cursor: number }>(
              "SELECT version, cursor FROM word_index"
            )
            .one()
        )
      ).resolves.toStrictEqual({ version: 2, cursor: 0 });
    });
  }
);
