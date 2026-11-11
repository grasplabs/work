import { recallLimit, sourceTextMaxBytes } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { addSource, recallAs } from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { mockIdp } from "./idp.ts";
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
  const { chunks } = await recallAs(env, personId, question);
  return chunks.map(({ source }) => source);
};

/** `word` 150 times: a paragraph too long to share a passage with another. */
const filler = (word: string): string => `${word} `.repeat(150).trim();

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

    const { chunks } = await recallAs(env, reader, `factuur ${tag}`);

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
  it("takes a deleted chunk's words out of both the word and the stem index", async () => {
    const reader = await person();
    // Marks no other word holds, inside words with an ending the stemmers
    // take off: indexed as written and as stems. Behind "xq" and "zq",
    // which no other test's words start with: FTS5 stores a term after the
    // prefix it shares with the one before it, so a shared start could
    // hide part of a mark from the page search.
    const [kept, erased] = [unique(), unique()];
    await add(`xq${kept}ingen stays`, ownedBy(reader));
    await add(`zq${erased}ingen goes`, ownedBy(reader));
    await expect(indexesFind(`zq${erased}`)).resolves.toStrictEqual([
      true,
      true,
    ]);
    await expect(indexesStore(erased)).resolves.toStrictEqual([true, true]);

    // As erasure (GRA-1729) will: delete the chunks, and no search finds
    // their words at once; then optimize both indexes, and their pages
    // hold nothing of them.
    await runInDurableObject(store(), (_instance, state) => {
      state.storage.sql.exec(
        "DELETE FROM chunks WHERE text = ?",
        `zq${erased}ingen goes`
      );
    });
    await expect(indexesFind(`zq${erased}`)).resolves.toStrictEqual([
      false,
      false,
    ]);
    await runInDurableObject(store(), (_instance, state) => {
      for (const index of wordIndexes) {
        state.storage.sql.exec(
          `INSERT INTO ${index} (${index}) VALUES ('optimize')`
        );
      }
    });

    await expect(indexesStore(erased)).resolves.toStrictEqual([false, false]);
    await expect(indexesFind(`xq${kept}`)).resolves.toStrictEqual([true, true]);
  });
});
