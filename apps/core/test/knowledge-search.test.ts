import type { SearchResults } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { dutchHandbook } from "./fixtures/dutch-knowledge.ts";
import { mockIdp } from "./idp.ts";
import { collectionWith, knowledgePersonOf } from "./knowledge-searches.ts";
import type { Person } from "./knowledge-searches.ts";
import { newTeam } from "./knowledge.ts";
import { auditedDuring, outcome, unique } from "./sign-in.ts";

// Search as people use it: Dutch words find their sections with or without
// diacritics, by prefix, inside compounds and with a typo; results rank
// title over description over text, and fresh over stale; nothing of a
// collection the person can't read is found, ranked or counted (R11); and a
// search that finds nothing is recorded without its words. Apps and agents
// search through their stubs, in knowledge-access.test.ts.

const idp = mockIdp();

/** A signed-in person's Knowledge API, on a connection of their own. */
const personOf = async (role: Role) => await knowledgePersonOf(idp, role);

/** Where each hit is: `path#heading`. */
const places = ({ hits }: SearchResults) =>
  hits.map(({ path, headings }) => `${path}#${headings.at(-1) ?? ""}`);

describe("searching Dutch documents", () => {
  const setUp = async () => {
    const person = await personOf("user");
    const { collectionId, documents } = await collectionWith(
      person,
      dutchHandbook
    );
    const first = async (query: string) => {
      const found = await person.knowledge.search(query, { collectionId });
      const [place = "nothing"] = places(found);
      return place;
    };
    return { person, collectionId, documents, first };
  };

  it("finds sections with or without diacritics, by prefix, in compounds and despite a typo", async () => {
    const { first } = await setUp();
    const queries = {
      // Diacritics, in the text or in the query.
      financiele: "financien/planning.md#Planning",
      coordinatie: "financien/planning.md#Coördinatie",
      coördinatie: "financien/planning.md#Coördinatie",
      "een drankje": "kantoor/borrel.md#Café",
      cafe: "kantoor/borrel.md#Café",
      // The start of a word.
      vakan: "handboek/verlof.md#Vakantiedagen",
      zwanger: "handboek/verlof.md#Zwangerschapsverlof",
      "ziek leidinggev": "handboek/ziekte.md#Ziek melden",
      // Inside a compound.
      vergoeding: "financien/reiskosten.md#Reiskosten",
      portaal: "financien/reiskosten.md#Zakelijke reizen",
      schapsverlof: "handboek/verlof.md#Zwangerschapsverlof",
      // A word too short for trigrams still has to be there.
      "de vergoeding": "financien/reiskosten.md#Reiskosten",
      "ik vergoeding": "nothing",
      // One typo; not pieces of the word far apart.
      reiskostenvergoedng: "financien/reiskosten.md#Reiskosten",
      zwangerschapsverlfo: "handboek/verlof.md#Zwangerschapsverlof",
      zwangerbijzonder: "nothing",
      // Not in the handbook.
      pensioenregeling: "nothing",
    };
    const found: Record<string, string> = {};
    for (const query of Object.keys(queries)) {
      // oxlint-disable-next-line no-await-in-loop -- one search at a time
      found[query] = await first(query);
    }
    expect(found).toStrictEqual(queries);
  });

  it("finds a code by its parts as words, never by a digit's prefix or digits inside a number", async () => {
    const person = await personOf("user");
    const { collectionId } = await collectionWith(person, [
      {
        path: "incidenten/7.md",
        text: "# Storing\nINC-7: de server lag eruit.",
      },
      {
        path: "incidenten/71.md",
        text: "# Storing\nINC-71: het net lag eruit.",
      },
      {
        path: "wijzigingen/118.md",
        text: "# Wijziging\nCR-2024-118 is goedgekeurd.",
      },
      {
        path: "wijzigingen/2118.md",
        text: "# Wijziging\nCR-12024-2118 wacht nog.",
      },
    ]);
    const queries = ["INC-7", "INC-71", "CR-2024-118", "2024"];
    const found: Record<string, string[]> = {};
    for (const query of queries) {
      // oxlint-disable-next-line no-await-in-loop -- one search at a time
      const results = await person.knowledge.search(query, { collectionId });
      found[query] = places(results);
    }
    expect(found).toStrictEqual({
      // A single character is a whole word: 7 isn't the start of 71.
      "INC-7": ["incidenten/7.md#Storing"],
      "INC-71": ["incidenten/71.md#Storing"],
      // Digits are words, not trigrams: 2024 isn't inside 12024.
      "CR-2024-118": ["wijzigingen/118.md#Wijziging"],
      "2024": ["wijzigingen/118.md#Wijziging"],
    });
  });

  it("returns each hit with its document, section and a snippet of its text", async () => {
    const { person, collectionId, documents } = await setUp();
    const { hits, provenance } = await person.knowledge.search(
      "zestien weken",
      { collectionId }
    );
    const [hit] = hits;
    expect({
      hits: hits.length,
      hit: hit && {
        ...hit,
        snippet: hit.snippet.includes("verlof duurt zestien weken"),
      },
      provenance,
    }).toStrictEqual({
      hits: 1,
      hit: {
        documentId: documents.find(({ path }) => path === "handboek/verlof.md")
          ?.id,
        collectionId,
        path: "handboek/verlof.md",
        title: "Verlofregeling",
        type: "doc",
        description:
          "Lees dit bij vragen over vakantie, bijzonder verlof of zwangerschap.",
        section: 2,
        version: 1,
        headings: ["Verlof", "Zwangerschapsverlof"],
        snippet: true,
      },
      provenance: {
        collectionIds: [collectionId],
        sensitive: false,
        restricted: false,
      },
    });
  });

  it("finds a document's new text, and no longer its old", async () => {
    const { person, collectionId } = await setUp();
    const { hits } = await person.knowledge.search("vakantiedagen", {
      collectionId,
    });
    const [verlof] = hits;
    if (!verlof) {
      throw new Error("Expected the leave policy");
    }
    await person.knowledge.saveDocument({
      collectionId,
      path: verlof.path,
      text: "# Verlof\n## Snipperdagen\nDagen vrij heten nu snipperdagen.",
      ifVersion: 1,
    });
    const restored = async () =>
      await person.knowledge.restoreVersion({
        documentId: verlof.documentId,
        version: 1,
        ifVersion: 2,
      });
    const search = async (query: string) =>
      places(await person.knowledge.search(query, { collectionId }));
    const saved = {
      old: await search("vakantiedagen"),
      new: await search("snipperdagen"),
    };
    await restored();
    expect({
      saved,
      restored: {
        old: await search("vakantiedagen"),
        new: await search("snipperdagen"),
      },
    }).toStrictEqual({
      saved: { old: [], new: ["handboek/verlof.md#Snipperdagen"] },
      restored: { old: ["handboek/verlof.md#Vakantiedagen"], new: [] },
    });
  });
});

describe("ranking", () => {
  it("puts a match in the title before one in the description, before one in the text", async () => {
    const person = await personOf("user");
    const word = `zq${unique()}`;
    await collectionWith(person, [
      { path: "tekst.md", text: `# Tekst\nDit gaat over ${word}.` },
      {
        path: "beschrijving.md",
        text: `---\ndescription: Over ${word}\n---\n# Beschrijving\nAlgemeen.`,
      },
      { path: "titel.md", text: `---\ntitle: ${word}\n---\n# Kop\nAlgemeen.` },
    ]);
    const found = await person.knowledge.search(word);
    expect(found.hits.map(({ path }) => path)).toStrictEqual([
      "titel.md",
      "beschrijving.md",
      "tekst.md",
    ]);
  });

  it("puts fresh documents before stale ones and those past their review date", async () => {
    const person = await personOf("user");
    const word = `zq${unique()}`;
    const text = `# Regel\nDe regel over ${word}.`;
    const { documents } = await collectionWith(person, [
      { path: "oud.md", text },
      { path: "verlopen.md", text: `---\nreview: 2020-01-01\n---\n${text}` },
      { path: "nieuw.md", text },
    ]);
    const [old] = documents;
    if (!old) {
      throw new Error("Expected a document");
    }
    const twoYears = 2 * 365 * 24 * 60 * 60 * 1000;
    await env.KNOWLEDGE.prepare(
      "UPDATE documents SET updated_at = ? WHERE id = ?"
    )
      .bind(Date.now() - twoYears, old.id)
      .run();
    const found = await person.knowledge.search(word);
    const [first, ...rest] = found.hits.map(({ path }) => path);
    // Both lose a quarter: past review, a year or more unchanged.
    expect({ first, rest: rest.toSorted() }).toStrictEqual({
      first: "nieuw.md",
      rest: ["oud.md", "verlopen.md"],
    });
  });

  it("returns at most three sections of one document, and at most the limit", async () => {
    const person = await personOf("user");
    const word = `zq${unique()}`;
    const sections = Array.from(
      { length: 6 },
      (_, index) => `## Deel ${index}\nOver ${word}.`
    ).join("\n");
    await collectionWith(person, [
      { path: "lang.md", text: `# Lang\n${sections}` },
      { path: "kort.md", text: `# Kort\nOver ${word}.` },
    ]);
    const all = await person.knowledge.search(word);
    const two = await person.knowledge.search(word, { limit: 2 });
    expect({
      lang: all.hits.filter(({ path }) => path === "lang.md").length,
      kort: all.hits.filter(({ path }) => path === "kort.md").length,
      limited: two.hits.length,
    }).toStrictEqual({ lang: 3, kort: 1, limited: 2 });
  });
});

describe("search access", () => {
  it("finds, ranks and counts only sections of collections the person may read", async () => {
    const admin = await personOf("admin");
    const member = await personOf("user");
    const outsider = await personOf("user");
    const teamId = await newTeam(admin, [member]);
    // Letters first: the trigram passes skip a word of digits alone (an
    // identifier's number), and `unique()` is sometimes only digits.
    const word = `zq${unique()}`;
    const onlyInTeam = `alleen${unique()}`;
    // `voor…regeling`: a whole word to the word index, and `word` only
    // inside it, to the trigram index.
    const compound = `voor${word}regeling`;
    const doc = (path: string) => ({ path, text: `# Kop\nDe ${compound}.` });
    const team = await collectionWith(
      admin,
      [
        doc("a.md"),
        doc("b.md"),
        { path: "c.md", text: `# Kop\n${onlyInTeam}` },
      ],
      { name: `Team ${unique()}`, access: "teams", teams: [teamId] }
    );
    const everyone = await collectionWith(admin, [doc("d.md")], {
      name: `Iedereen ${unique()}`,
      access: "everyone",
    });
    const diary = await collectionWith(member, [doc("e.md")]);

    // Each index: whole words (prefix), trigrams, trigrams with a typo.
    const queries = [`voor${word}`, word, `${compound.slice(0, -2)}gn`];
    const names = new Map([
      [team.collectionId, "team"],
      [everyone.collectionId, "everyone"],
      [diary.collectionId, "diary"],
    ]);
    const found = async (person: Person) =>
      await Promise.all(
        queries.map(async (query) => {
          const { hits, provenance } = await person.knowledge.search(query);
          return {
            count: hits.length,
            hits: [...new Set(hits.map(({ collectionId }) => collectionId))]
              .map((id) => names.get(id) ?? "other")
              .toSorted(),
            provenance: provenance.collectionIds
              .map((id) => names.get(id) ?? "other")
              .toSorted(),
          };
        })
      );
    const each = (count: number, collections: string[]) =>
      queries.map(() => ({
        count,
        hits: collections,
        provenance: collections,
      }));
    expect({
      outsider: await found(outsider),
      member: await found(member),
      admin: await found(admin),
    }).toStrictEqual({
      outsider: each(1, ["everyone"]),
      member: each(4, ["diary", "everyone", "team"]),
      admin: each(3, ["everyone", "team"]),
    });

    // Nor by naming the collection, nor by a word only it has.
    const hidden = await auditedDuring(async () => {
      const scoped = await outcome(
        outsider.knowledge.search(word, { collectionId: team.collectionId })
      );
      const { hits } = await outsider.knowledge.search(onlyInTeam);
      expect({ scoped, hits }).toStrictEqual({
        scoped: "knowledge.not_found",
        hits: [],
      });
    });
    // To the log, it found nothing, as for any other search.
    expect(hidden.map(({ action }) => action)).toStrictEqual([
      "knowledge.search.empty",
    ]);
  });
});

describe("searches that find nothing", () => {
  it("are recorded with who searched and a key for the question, never its words", async () => {
    const person = await personOf("user");
    const { collectionId } = await collectionWith(person, dutchHandbook);
    const events = await auditedDuring(async () => {
      await person.knowledge.search("pensioenregeling");
      await person.knowledge.search("Pensioën Regeling", { collectionId });
      await person.knowledge.search("regeling pensioen");
      await person.knowledge.search("leaseauto");
      // No words at all: nothing searched, and nothing found.
      await person.knowledge.search("");
      // Found something: recorded as a read (knowledge-tools.test.ts).
      await person.knowledge.search("vakantiedagen", { collectionId });
    });
    const key = (index: number) => events[index]?.detail.queryKey;
    expect({
      events: events.map(({ actor, action, target, detail }) => ({
        actor,
        action,
        target,
        terms: detail.terms,
      })),
      sameQuestion: key(1) === key(2),
      otherQuestion: key(0) !== key(1) && key(0) !== key(3),
      words: JSON.stringify(events).match(/pensio|regeling|leaseauto/giu),
    }).toStrictEqual({
      events: [
        {
          actor: { type: "person", userId: person.userId },
          action: "knowledge.search.empty",
          target: undefined,
          terms: 1,
        },
        {
          actor: { type: "person", userId: person.userId },
          action: "knowledge.search.empty",
          target: { type: "collection", id: collectionId },
          terms: 2,
        },
        {
          actor: { type: "person", userId: person.userId },
          action: "knowledge.search.empty",
          target: undefined,
          terms: 2,
        },
        {
          actor: { type: "person", userId: person.userId },
          action: "knowledge.search.empty",
          target: undefined,
          terms: 1,
        },
        {
          actor: { type: "person", userId: person.userId },
          action: "knowledge.search.empty",
          target: undefined,
          terms: 0,
        },
        {
          actor: { type: "person", userId: person.userId },
          action: "knowledge.search",
          target: { type: "collection", id: collectionId },
          terms: 1,
        },
      ],
      sameQuestion: true,
      otherQuestion: true,
      words: null,
    });
  });

  it("refuses a query past its length or options it doesn't know", async () => {
    const person = await personOf("user");
    await expect(
      Promise.all([
        outcome(person.knowledge.search("a".repeat(501))),
        outcome(person.knowledge.search("verlof", { limit: 51 })),
        outcome(
          person.knowledge.search("verlof", {
            // @ts-expect-error -- not an option
            match: "verlof OR 1",
          })
        ),
        // Only punctuation, or FTS5 syntax: words or nothing.
        outcome(person.knowledge.search('"verlof" NEAR(*)')),
        outcome(person.knowledge.search("?!")),
      ])
    ).resolves.toStrictEqual([
      "knowledge.invalid",
      "knowledge.invalid",
      "knowledge.invalid",
      "ok",
      "ok",
    ]);
  });
});
