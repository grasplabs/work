import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  holding,
  joinedWordHeadingAPage,
  purged,
  saveOver,
  setUpTime,
} from "./knowledge-purge.ts";
import { openRpc, signedInApi, unique } from "./sign-in.ts";

// Purging personal data from Knowledge. These tests start from the ways a
// purge can fail or be abused: the text survives somewhere (an earlier
// version, a section, a title, the search index's pages, a Brain memory, memory cached
// by version); the purge record in the audit log,
// which can't be purged, carries the text it removed; a purge reaches
// documents it wasn't aimed at; someone other than the client's admins
// purges, or purges without confirming, or confirms a purge other than the
// one prepared; and a purge leaves a document that can't be read.

const idp = mockIdp();

const personOf = async (role: Role) => await signedInApi(idp, role);

describe("a purge of content", setUpTime, () => {
  it("drops a term from the index's page directory, where it was the first term of a page", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    // A first purge turns secure deletes on, as any purge does.
    const first = await saveOver(
      admin,
      handbook.id,
      "first.md",
      "# First\nA note."
    );
    await purged(admin, {
      type: "content",
      documentIds: [first.id],
      terms: ["note"],
      reason: "other",
    });
    // Enough words, in order, to fill pages, alternating between two
    // documents: a page holds words of both, so it isn't emptied when one
    // document's words go, and its directory entry, made from its first
    // word, all of it here, stays.
    const stem = `zq${unique()}`;
    const words = Array.from(
      { length: 3000 },
      (_, at) => `${stem}${String(at).padStart(5, "0")}`
    );
    const document = await saveOver(
      admin,
      handbook.id,
      "even.md",
      `# Words\n${words.filter((_, at) => at % 2 === 0).join(" ")}`
    );
    await saveOver(
      admin,
      handbook.id,
      "odd.md",
      `# Words\n${words.filter((_, at) => at % 2 === 1).join(" ")}`
    );
    // Their words in one segment, as FTS5's own merges put them in time.
    await env.KNOWLEDGE.prepare(
      "INSERT INTO search_words (search_words) VALUES ('optimize')"
    ).run();
    const { results } = await env.KNOWLEDGE.prepare(
      "SELECT CAST(term AS TEXT) AS term FROM search_words_idx WHERE CAST(term AS TEXT) LIKE ?"
    )
      .bind(`0${stem}%`)
      .all<{ term: string }>();
    // A word of the document purged that heads a page.
    const leading = words.find(
      (word, at) =>
        at % 2 === 0 && results.some(({ term }) => term === `0${word}`)
    );
    const heldBefore = leading === undefined ? [] : await holding(leading);
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [leading ?? ""],
      reason: "other",
    });
    expect({
      found: leading !== undefined,
      heldBefore: heldBefore.includes("search_words_idx.term"),
      heldAfter: await holding(leading ?? ""),
    }).toStrictEqual({
      found: true,
      heldBefore: true,
      heldAfter: [],
    });
  });

  it("leaves nothing of a term the index held as part of a longer token, beside a script written without spaces", async () => {
    const admin = await personOf("admin");
    const { joined, word, entriesLeft } = await joinedWordHeadingAPage(admin);
    await purged(admin, {
      type: "content",
      documentIds: [joined.id],
      terms: [word ?? ""],
      reason: "other",
    });
    const read = await admin.api.knowledge.getDocument(joined.id);
    expect({
      found: word !== undefined,
      removed: !read.version.text.includes(`${word}さん`),
      entriesLeft: await entriesLeft(),
    }).toStrictEqual({ found: true, removed: true, entriesLeft: 0 });
  });

  it("leaves nothing of a term beside a script that only a term removed before it left whole", async () => {
    const admin = await personOf("admin");
    // "Foo." joins the term on its left, so the term is removed only once
    // "Foo." is; the index reads "Foo." as its own token either way.
    const { joined, word, entriesLeft } = await joinedWordHeadingAPage(
      admin,
      "Foo."
    );
    await purged(admin, {
      type: "content",
      documentIds: [joined.id],
      terms: ["Foo.", word ?? ""],
      reason: "other",
    });
    const read = await admin.api.knowledge.getDocument(joined.id);
    expect({
      found: word !== undefined,
      removed: !read.version.text.includes(`${word}さん`),
      entriesLeft: await entriesLeft(),
    }).toStrictEqual({ found: true, removed: true, entriesLeft: 0 });
  });

  it("never logs a purged term, though checking the index for it fails", async () => {
    const admin = await personOf("admin");
    const secret = `logged${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "people.md",
      `# People\nWrite to ${secret}.`
    );
    // The index's directory refuses the lookup, whose failure repeats its
    // query and parameters, as a platform's refusal would.
    const real = env.KNOWLEDGE;
    const knowledge: D1Database = {
      prepare: (query) =>
        real.prepare(
          query.includes("_idx")
            ? query.replace(
                "WHERE segments.id IS NOT NULL",
                "WHERE segments.id IS NOT NULL AND refused_here"
              )
            : query
        ),
      batch: async <T>(statements: D1PreparedStatement[]) =>
        await real.batch<T>(statements),
      exec: async (query) => await real.exec(query),
      // oxlint-disable-next-line typescript/no-deprecated -- D1Database still has it
      dump: async () => await real.dump(),
      withSession: (constraint) => real.withSession(constraint),
    };
    const { core } = await openRpc(admin.session, {
      coreEnv: { ...env, KNOWLEDGE: knowledge },
    });
    const refusing = core.authenticate();
    const logged: unknown[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      })
    );
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [secret],
      reason: "other",
    };
    try {
      const { token } = await refusing.knowledge.preparePurge(input);
      await refusing.knowledge.purge(input, token);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
    const lines = logged.map((args) => JSON.stringify(args));
    expect({
      checkFailed: lines.some((line) =>
        line.includes("knowledge.purge.index_check_failed")
      ),
      leaked: lines.filter((line) => line.toLowerCase().includes(secret)),
      heldAfter: await holding(secret),
    }).toStrictEqual({ checkFailed: true, leaked: [], heldAfter: [] });
  });

  it("removes a term with accents from every table, though its tokens can't be checked one by one", async () => {
    const admin = await personOf("admin");
    const secret = `Renée${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "people.md",
      `# ${secret}\nWrite to ${secret} for leave.`
    );
    const folded = `renee${secret.slice(5)}`;
    /**
     * Whether the words index finds the folded token: asked of the index,
     * since its pages keep a term after another that shares its first
     * letters as only the letters that differ, which a scan of their
     * bytes can't see once a merge put such a term before it.
     */
    const indexed = async (): Promise<boolean> =>
      (await env.KNOWLEDGE.prepare(
        "SELECT 1 FROM search_words WHERE search_words MATCH ? LIMIT 1"
      )
        .bind(`"${folded}"`)
        .first()) !== null;
    const indexedBefore = await indexed();
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [secret],
      reason: "other",
    });
    expect({
      indexedBefore,
      indexedAfter: await indexed(),
      heldAfter: await holding(folded),
      heldAfterAsWritten: await holding(secret),
    }).toStrictEqual({
      indexedBefore: true,
      indexedAfter: false,
      heldAfter: [],
      heldAfterAsWritten: [],
    });
  });

  it("drops the terms from the search index and its pages", async () => {
    const admin = await personOf("admin");
    const secret = `pietersz${unique()}`;
    const kept = `kept${unique()}`;
    // A passage, with characters a pattern would read otherwise.
    const passage = `on paid leave (course${unique()}) since May.`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "people.md",
      `---\ndescription: About ${secret}\n---\n# ${secret}\nWrite to ${secret} for leave.\nShe is ${passage}\n\n## Other\nNothing ${kept}.`
    );
    const heldBefore = await holding(secret);
    const foundBefore = await admin.api.knowledge.search(secret);
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [secret, passage],
      reason: "other",
    });
    const text = await admin.api.knowledge.getDocument(document.id);
    const foundAfter = await admin.api.knowledge.search(secret);
    const stillFound = await admin.api.knowledge.search(kept);
    expect({
      heldBefore,
      foundBefore: foundBefore.hits.length,
      heldAfter: await holding(secret),
      passageAfter: await holding(passage.slice(15, -12)),
      text: text.version.text,
      foundAfter: foundAfter.hits.length,
      stillFound: stillFound.hits.map(({ documentId, title }) => ({
        documentId,
        title,
      })),
    }).toStrictEqual({
      heldBefore: [
        "BRAIN_OBJECTS",
        "documents.description",
        "documents.title",
        "search_trigrams.c0",
        "search_trigrams.c1",
        "search_trigrams.c2",
        "search_trigrams.c3",
        "search_words.description",
        "search_words.headings",
        "search_words.text",
        "search_words.title",
        "search_words_content.c0",
        "search_words_content.c1",
        "search_words_content.c2",
        "search_words_content.c3",
        "search_words_data.block",
        "sections.headings",
        "sections.text",
      ],
      foundBefore: 2,
      heldAfter: [],
      passageAfter: [],
      text: `---\ndescription: About (removed)\n---\n# (removed)\nWrite to (removed) for leave.\nShe is (removed)\n\n## Other\nNothing ${kept}.`,
      foundAfter: 0,
      stillFound: [{ documentId: document.id, title: "(removed)" }],
    });
  });

  // Ending in "e", the acute after it merges with it into one character
  // ("é"), which the index splits apart again; ending in "x", it can't.
  it.each(["e", "x"])(
    "removes a term wherever the search index keeps it as a token of its own, so no search finds it after, for a name ending in %s",
    async (ending) => {
      const admin = await personOf("admin");
      const handbook = await admin.api.knowledge.createCollection({
        name: "Handbook",
        access: "everyone",
      });
      // The index's tokenizer ends a token at each of these, where a name is
      // still the name: an underscore, a dot, an at sign, a soft hyphen, a
      // zero-width joiner, a spacing vowel sign, a combining grapheme joiner,
      // a variation selector, an Arabic tanween, a Devanagari vowel sign
      // that is a combining mark. It drops a combining acute from the token,
      // so the name with one after it is the name: both go. A private-use
      // character it keeps in the token, which the name goes from too.
      const name = `Visser${unique()}${ending}`;
      const [
        softHyphen,
        joiner,
        visarga,
        graphemeJoiner,
        variation,
        tanween,
        vowelSign,
        acute,
        privateUse,
      ] = [
        0xad, 0x20_0d, 0x9_03, 0x3_4f, 0xfe_0f, 0x6_4b, 0x9_41, 0x3_01, 0xe0_00,
      ].map((codePoint) => String.fromCodePoint(codePoint));
      const marks = [graphemeJoiner, variation, tanween, vowelSign];
      const document = await saveOver(
        admin,
        handbook.id,
        "team.md",
        `# Team\n${name}_jan, Tom.${name}, ${name.toLowerCase()}@acme.test, ${name}${softHyphen}jan, ${name}${joiner}jan and ${name}${visarga} left.\n${marks.map((mark) => `${name}${mark}jan`).join(", ")}, ${name}${acute} and ${name}${privateUse} left.`
      );
      const heldBefore = await holding(name);
      const { plan, result } = await purged(admin, {
        type: "content",
        documentIds: [document.id],
        terms: [name],
        reason: "offboarding",
      });
      const read = await admin.api.knowledge.getDocument(document.id);
      const found = await admin.api.knowledge.search(name);
      expect({
        heldBefore: heldBefore.includes("search_words_data.block"),
        occurrences: plan.occurrences,
        text: read.version.text,
        held: await holding(name),
        found: found.hits.length,
        stillFound: result.stillFound,
      }).toStrictEqual({
        heldBefore: true,
        // Twelve in the version saved.
        occurrences: 12,
        text: `# Team\n(removed)_jan, Tom.(removed), (removed)@acme.test, (removed)${softHyphen}jan, (removed)${joiner}jan and (removed)${visarga} left.\n${marks.map((mark) => `(removed)${mark}jan`).join(", ")}, (removed) and (removed)${privateUse} left.`,
        held: [],
        found: 0,
        stillFound: 0,
      });
    }
  );
});
