import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-outbox.ts";
import { forContext } from "../src/knowledge/memory.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import {
  apiWith,
  hexOf,
  holding,
  indexedSections,
  lettersOf,
  newAgent,
  payOwedRebuilds,
  purged,
  saveOver,
  setUpTime,
  watchingPurge,
} from "./knowledge-purge.ts";
import type { Person } from "./knowledge-purge.ts";
import {
  storedVersionTexts as versionTexts,
  storeTextUnderneath,
} from "./knowledge.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedInApi,
  unique,
} from "./sign-in.ts";

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

/**
 * `person`'s API on a connection that adds up the rows each batch writes,
 * the search index's own included (D1's `meta.changes`): what a purge
 * writes, which a rebuild of the whole index makes grow with the corpus.
 * Not `meta.rows_written`, which counts a rebuild as one row whatever the
 * index holds: its writes to the index's own tables don't show there.
 */
const countingWrites = async (person: Person) => {
  const real = env.KNOWLEDGE;
  const written = { rows: 0 };
  const knowledge: D1Database = {
    prepare: (query) => real.prepare(query),
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
  const { core } = await openRpc(person.session, {
    coreEnv: { ...env, KNOWLEDGE: knowledge },
  });
  return { api: core.authenticate(), written };
};

/** The page directory's entry for `word` joined with さん, as hex. */
const entryOf = (word: string) => `${hexOf(`0${word}`)}E3`;

/**
 * A word whose token joined with さん heads a page of the words index, as
 * a document holds it, with its plain twin in another document: its
 * directory entry is the plain word and the first byte of さ, which the
 * word's own key can't find (search-erasure.ts). `entriesLeft` counts
 * that entry. Letters only: a word with a digit is held to a stricter
 * check of its own.
 */
const joinedWordHeadingAPage = async (admin: Person, before = "") => {
  const handbook = await admin.api.knowledge.createCollection({
    name: "Handbook",
    access: "everyone",
  });
  const stem = `zq${lettersOf(Math.floor(Math.random() * 26 ** 6), 6)}`;
  const words = Array.from(
    { length: 2000 },
    (_, at) => `${stem}${lettersOf(at, 3)}`
  );
  const joined = await saveOver(
    admin,
    handbook.id,
    "joined.md",
    `# Words\n${words.map((word) => `${before}${word}さん`).join(" ")}`
  );
  // The stem alone first: one term more before the pairs, so pages, which
  // fill a pair at a time here, begin on a joined word.
  await saveOver(
    admin,
    handbook.id,
    "plain.md",
    `# Words\n${stem} ${words.join(" ")}`
  );
  await env.KNOWLEDGE.prepare(
    "INSERT INTO search_words (search_words) VALUES ('optimize')"
  ).run();
  const { results } = await env.KNOWLEDGE.prepare(
    "SELECT hex(term) AS entry FROM search_words_idx WHERE hex(term) LIKE ?"
  )
    .bind(`${hexOf(`0${stem}`)}%E3`)
    .all<{ entry: string }>();
  const word = words.find((one) =>
    results.some(({ entry }) => entry === entryOf(one))
  );
  const entriesLeft = async () => {
    const left = await env.KNOWLEDGE.prepare(
      "SELECT count(*) AS n FROM search_words_idx WHERE hex(term) = ?"
    )
      .bind(entryOf(word ?? ""))
      .first<{ n: number }>();
    return left?.n;
  };
  return { joined, word, entriesLeft };
};

/** A new name: Visser and six letters. */
const nameOf = () =>
  `Visser${lettersOf(Math.floor(Math.random() * 26 ** 6), 6)}`;

describe("a purge of content", setUpTime, () => {
  it("rewrites every version of the documents named, and only those", async () => {
    const admin = await personOf("admin");
    const owner = await personOf("user");
    const name = `Jansen${unique()}`;
    const email = `${name.toLowerCase()}.j@acme.test`;
    const notes = await owner.api.knowledge.createCollection({
      name: "Notes",
      access: "me",
    });
    await saveOver(
      owner,
      notes.id,
      "leave.md",
      `# Leave\nAsk ${name} (${email}) about it.`
    );
    await saveOver(
      owner,
      notes.id,
      "leave.md",
      `# ${name}'s leave\nAsk ${name.toUpperCase()} about it.\n\n## More\nNothing else.`,
      `About ${name}`
    );
    const leave = await saveOver(
      owner,
      notes.id,
      "leave.md",
      `# ${name}'s leave\nAsk ${name.toLowerCase()} about it.\n\n## More\nNothing else. See [[other.md]].`
    );
    const other = await saveOver(
      owner,
      notes.id,
      "other.md",
      `# Other\n${name} is here too.`
    );
    const memory = await admin.api.memory.collections();
    const memoryId = memory.memory ?? "";
    const company = await saveOver(
      admin,
      memoryId,
      "MEMORY.md",
      `# Company\n${name} runs payroll.`
    );
    const agent = newAgent();
    const work = await newChat(agent);
    const asAgent = actingFor(agent, admin.userId);
    const before = await forContext(env, asAgent, work, { type: "own" });

    const input: PurgeInput = {
      type: "content",
      documentIds: [leave.id, company.id],
      terms: [name, email],
      reason: "erasure_request",
    };
    let outcomeOf: Awaited<ReturnType<typeof purged>> | undefined;
    const events = await auditedDuring(async () => {
      outcomeOf = await purged(admin, input);
    });

    const after = await forContext(env, asAgent, work, { type: "own" });
    const current = await owner.api.knowledge.getDocument(leave.id);
    const hits = await owner.api.knowledge.search(name);
    const backlinks = await owner.api.knowledge.backlinks(other.id);
    const history = await owner.api.knowledge.history(leave.id);
    const companyTexts = await versionTexts(company.id);
    expect({
      plan: {
        documents: outcomeOf?.plan.documents,
        versions: outcomeOf?.plan.versions,
        inLongerWords: outcomeOf?.plan.inLongerWords,
      },
      result: {
        ...outcomeOf?.result,
        purgeId: typeof outcomeOf?.result.purgeId,
      },
      leave: await versionTexts(leave.id),
      history: history.versions.map(({ message }) => message),
      title: current.title,
      other: await versionTexts(other.id),
      // Earlier tests saved MEMORY.md too.
      company: companyTexts.filter(
        (text) => text.includes(name) || text.includes("(removed)")
      ),
      memoryBefore: before.text.includes(name),
      memoryAfter: after.text.includes(name),
      memoryKeyChanged: after.key !== before.key,
      hits: hits.hits.map(({ documentId }) => documentId),
      backlinks: backlinks.backlinks.map(({ documentId }) => documentId),
    }).toStrictEqual({
      plan: { documents: 2, versions: 4, inLongerWords: 0 },
      result: {
        purgeId: "string",
        documents: 2,
        versions: 4,
        stillFound: 0,
      },
      leave: [
        "# Leave\nAsk (removed) ((removed)) about it.",
        "# (removed)'s leave\nAsk (removed) about it.\n\n## More\nNothing else.",
        "# (removed)'s leave\nAsk (removed) about it.\n\n## More\nNothing else. See [[other.md]].",
        // Saved again, so its sections, title and search rows are made
        // again, and anyone who saved meanwhile conflicts.
        "# (removed)'s leave\nAsk (removed) about it.\n\n## More\nNothing else. See [[other.md]].",
      ],
      history: ["Personal data removed", null, "About (removed)", null],
      title: "(removed)'s leave",
      other: [`# Other\n${name} is here too.`],
      company: [
        "# Company\n(removed) runs payroll.",
        "# Company\n(removed) runs payroll.",
      ],
      memoryBefore: true,
      memoryAfter: false,
      memoryKeyChanged: true,
      hits: [other.id],
      backlinks: [leave.id],
    });
    expect({
      events: events
        .filter(({ action }) => action.startsWith("knowledge.purge"))
        .map(({ action, provenance, detail }) => ({
          action,
          provenance: provenance.toSorted(),
          detail,
        })),
      carriesText: [name, email].some((term) =>
        JSON.stringify(events).toLowerCase().includes(term.toLowerCase())
      ),
    }).toStrictEqual({
      events: [
        {
          action: "knowledge.purge.prepared",
          provenance: [leave.id, company.id].toSorted(),
          detail: {
            kind: "content",
            reason: "erasure_request",
            terms: 2,
            documents: 2,
            versions: 4,
            occurrences: 8,
            inLongerWords: 0,
            memories: 0,
            hostCopies: 0,
          },
        },
        {
          action: "knowledge.purged",
          provenance: [leave.id, company.id].toSorted(),
          detail: {
            purgeId: outcomeOf?.result.purgeId,
            kind: "content",
            reason: "erasure_request",
            terms: 2,
            documents: 2,
          },
        },
      ],
      carriesText: false,
    });
  });

  it("removes a term typed with a combining accent from text typed the same way", async () => {
    const admin = await personOf("admin");
    const decomposed = `Rene\u0301${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${decomposed} runs payroll.`
    );
    const { plan, result } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [decomposed],
      reason: "erasure_request",
    });
    expect({
      occurrences: plan.occurrences,
      stillFound: result.stillFound,
      texts: await versionTexts(document.id),
    }).toStrictEqual({
      occurrences: 1,
      stillFound: 0,
      texts: [
        "# Team\n(removed) runs payroll.",
        "# Team\n(removed) runs payroll.",
      ],
    });
  });

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

  it("rebuilds when run again for a term beside a script, though its text is rewritten already", async () => {
    const admin = await personOf("admin");
    const { joined, word, entriesLeft } = await joinedWordHeadingAPage(admin);
    const input: PurgeInput = {
      type: "content",
      documentIds: [joined.id],
      terms: [word ?? ""],
      reason: "other",
    };
    // The first run's rebuild fails, once its rewrites committed.
    let failed = false;
    let failNext = false;
    const failing = await apiWith(admin, {
      prepare: (query) => {
        if (!failed && query.includes("VALUES ('rebuild')")) {
          failNext = true;
        }
      },
      beforeBatch: () => {
        if (failNext) {
          failNext = false;
          failed = true;
          throw new Error("D1 is unavailable");
        }
      },
    });
    const { token } = await failing.knowledge.preparePurge(input);
    const first = await outcome(failing.knowledge.purge(input, token));
    const read = await admin.api.knowledge.getDocument(joined.id);
    const again = await purged(admin, input);
    expect({
      found: word !== undefined,
      first,
      rewrittenFirst: !read.version.text.includes(`${word}さん`),
      again: again.result.versions,
      entriesLeft: await entriesLeft(),
    }).toStrictEqual({
      found: true,
      first: "knowledge.purge_index_pending",
      rewrittenFirst: true,
      again: 0,
      entriesLeft: 0,
    });
  });

  it("rebuilds for a term its frontmatter joins to a script, written as an escape", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    for (let at = 0; at < 60; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one document at a time
      await saveOver(
        admin,
        handbook.id,
        `filler-${at}.md`,
        `# Filler ${at}\nText ${unique()}.`
      );
    }
    /** Purges `name` from a new document with `title`, saying what it wrote. */
    const purgeTitled = async (name: string, title: string) => {
      const document = await saveOver(
        admin,
        handbook.id,
        `${name}.md`,
        `---\ntitle: "${title}"\n---\nAbout leave.`
      );
      const counting = await countingWrites(admin);
      const input: PurgeInput = {
        type: "content",
        documentIds: [document.id],
        terms: [name],
        reason: "other",
      };
      const { token } = await counting.api.knowledge.preparePurge(input);
      await counting.api.knowledge.purge(input, token);
      const read = await admin.api.knowledge.getDocument(document.id);
      return {
        written: counting.written.rows,
        removed: !read.version.text.includes(name),
      };
    };
    // A plain title: the purge's own check, no rebuild.
    const plainName = nameOf();
    const plain = await purgeTitled(plainName, plainName);
    // YAML decodes this title to "<name>さん", one token to the index, though
    // the text as written has the name next to a backslash.
    const escapedName = nameOf();
    const escaped = await purgeTitled(
      escapedName,
      `${escapedName}\\u3055\\u3093`
    );
    // A rebuild writes a row for each section the index holds, at least.
    expect({
      removed: plain.removed && escaped.removed,
      rebuilt: escaped.written - plain.written >= (await indexedSections()),
    }).toStrictEqual({ removed: true, rebuilt: true });
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

  it("writes no more to the search index for a purge however large the corpus", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    /**
     * Purges a name from a document of its own, saying what it wrote and
     * how often it rebuilt the whole index. Another document keeps the
     * name: a page the name's tokens head is one the index still holds
     * them on, whatever pages the corpus happens to fill, so the purge
     * never owes a rebuild here.
     */
    const purgeOne = async () => {
      const name = `purged${unique()}`;
      const document = await saveOver(
        admin,
        handbook.id,
        `${name}.md`,
        `# ${name}\nWrite to ${name} about leave.\n\n## More\nNothing else ${name}.`
      );
      await saveOver(admin, handbook.id, `kept-${name}.md`, `# Kept\n${name}.`);
      const counting = await watchingPurge(admin);
      const input: PurgeInput = {
        type: "content",
        documentIds: [document.id],
        terms: [name],
        reason: "other",
      };
      const { token } = await counting.api.knowledge.preparePurge(input);
      await counting.api.knowledge.purge(input, token);
      return counting.written;
    };
    // Secure deletes turned on first, as any purge does.
    await purgeOne();
    const small = await purgeOne();
    const before = await indexedSections();
    for (let at = 0; at < 150; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one document at a time
      await saveOver(
        admin,
        handbook.id,
        `other-${at}.md`,
        `# Other ${at}\n${unique()} ${unique()} text.\n\n## Part\nMore ${unique()}.\n\n## Last\nEnd ${unique()}.`
      );
    }
    const added = (await indexedSections()) - before;
    await payOwedRebuilds();
    // The saves' audit events delivered first: a drain of them while the
    // purge runs would count as its writes.
    await drainAuditOutboxes(env);
    const large = await purgeOne();
    // A rebuild of the whole index writes at least a row for each section
    // it holds: what the corpus grew by would show, many times over.
    expect({
      grewBy: large.rows - small.rows,
      bound: large.rows - small.rows < added / 4,
      rebuilds: large.rebuilds,
    }).toMatchObject({ bound: true, rebuilds: 0 });
  });

  it("rebuilds for an ID's trigram that heads a page and only the purged document held", async () => {
    // First: a rebuild re-pages the index.
    await payOwedRebuilds();
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    // IDs of letters and digits, enough to fill pages of the trigram
    // index, shared with a document that stays: a page holds both, so it
    // isn't emptied when the purged ID goes, and its separator stays.
    const ids = Array.from(
      { length: 3000 },
      () => `k${Math.random().toString(36).slice(2, 7)}7`
    );
    const keptIds = Array.from(
      { length: 3000 },
      () => `m${Math.random().toString(36).slice(2, 7)}7`
    );
    const document = await saveOver(
      admin,
      handbook.id,
      "ids.md",
      `# IDs\n${ids.join(" ")}`
    );
    await saveOver(
      admin,
      handbook.id,
      "kept.md",
      `# Kept\n${keptIds.join(" ")}`
    );
    await env.KNOWLEDGE.prepare(
      "INSERT INTO search_trigrams (search_trigrams) VALUES ('optimize')"
    ).run();
    // A trigram heading a page that one ID alone holds, in this document
    // alone.
    const { results: separators } = await env.KNOWLEDGE.prepare(
      "SELECT CAST(term AS TEXT) AS term FROM search_trigrams_idx WHERE CAST(term AS TEXT) GLOB '0[a-z0-9][a-z0-9][a-z0-9]'"
    ).all<{ term: string }>();
    let target: { trigram: string; id: string } | undefined;
    for (const { term } of separators) {
      const trigram = term.slice(1);
      const holders = ids.filter((id) => id.includes(trigram));
      const [only] = holders;
      const keptHolds = keptIds.some((id) => id.includes(trigram));
      if (holders.length === 1 && only !== undefined && !keptHolds) {
        // oxlint-disable-next-line no-await-in-loop -- one trigram at a time
        const rows = await env.KNOWLEDGE.prepare(
          "SELECT count(*) AS n FROM search_trigrams WHERE search_trigrams MATCH ?"
        )
          .bind(`"${trigram}"`)
          .first<{ n: number }>();
        if (rows?.n === 1) {
          target = { trigram, id: only };
          break;
        }
      }
    }
    const watching = await watchingPurge(admin);
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [target?.id ?? ""],
      reason: "other",
    };
    const { token } = await watching.api.knowledge.preparePurge(input);
    await watching.api.knowledge.purge(input, token);
    const left = await env.KNOWLEDGE.prepare(
      "SELECT count(*) AS n FROM search_trigrams_idx WHERE CAST(term AS TEXT) = ?"
    )
      .bind(`0${target?.trigram ?? ""}`)
      .first<{ n: number }>();
    expect({
      found: target !== undefined,
      rebuilds: watching.written.rebuilds,
      separatorLeft: left?.n,
    }).toStrictEqual({ found: true, rebuilds: 1, separatorLeft: 0 });
  });

  it("leaves a rebuild owed when a purge fails after its writes, for the next purge to pay", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const name = `failing${lettersOf(Math.floor(Math.random() * 26 ** 6), 6)}`;
    const failed = await saveOver(
      admin,
      handbook.id,
      "failed.md",
      `# Failed\nAsk ${name}.`
    );
    await payOwedRebuilds();
    // Its writes commit; then its check and its rebuild fail, and it isn't
    // run again.
    let failRebuild = false;
    const failing = await apiWith(admin, {
      prepare: (query) => {
        if (query.includes("_idx")) {
          throw new Error("D1 is unavailable");
        }
        if (query.includes("VALUES ('rebuild')")) {
          failRebuild = true;
        }
      },
      beforeBatch: () => {
        if (failRebuild) {
          failRebuild = false;
          throw new Error("D1 is unavailable");
        }
      },
    });
    const failedInput: PurgeInput = {
      type: "content",
      documentIds: [failed.id],
      terms: [name],
      reason: "other",
    };
    const plan = await failing.knowledge.preparePurge(failedInput);
    const first = await outcome(
      failing.knowledge.purge(failedInput, plan.token)
    );
    // The next purge, of something else, pays the rebuild it owes.
    const other = `other${lettersOf(Math.floor(Math.random() * 26 ** 6), 6)}`;
    const next = await saveOver(
      admin,
      handbook.id,
      "next.md",
      `# ${other}\n${other}.`
    );
    const watching = await watchingPurge(admin);
    const input: PurgeInput = {
      type: "content",
      documentIds: [next.id],
      terms: [other],
      reason: "other",
    };
    const { token } = await watching.api.knowledge.preparePurge(input);
    await watching.api.knowledge.purge(input, token);
    expect({
      first,
      rebuilds: watching.written.rebuilds,
      held: await holding(name),
    }).toStrictEqual({
      first: "knowledge.purge_index_pending",
      rebuilds: 1,
      held: [],
    });
  });

  it("doesn't rebuild for an ID whose trigram heads a page that other text still holds", async () => {
    // First: a rebuild re-pages the index.
    await payOwedRebuilds();
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    for (let at = 0; at < 150; at += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one document at a time
      await saveOver(
        admin,
        handbook.id,
        `other-${at}.md`,
        `# Other ${at}\n${unique()} ${unique()} text.\n\n## Part\nMore ${unique()}.`
      );
    }
    await env.KNOWLEDGE.prepare(
      "INSERT INTO search_trigrams (search_trigrams) VALUES ('optimize')"
    ).run();
    // A trigram that heads a page of the trigram index and that live text
    // holds: an ID with it among its trigrams finds its separator held.
    const { results: separators } = await env.KNOWLEDGE.prepare(
      "SELECT CAST(term AS TEXT) AS term FROM search_trigrams_idx WHERE CAST(term AS TEXT) GLOB '0[a-z0-9][a-z0-9][a-z0-9]'"
    ).all<{ term: string }>();
    let heading: string | undefined;
    for (const { term } of separators) {
      // oxlint-disable-next-line no-await-in-loop -- one trigram at a time
      const live = await env.KNOWLEDGE.prepare(
        "SELECT 1 AS live FROM search_trigrams WHERE search_trigrams MATCH ? LIMIT 1"
      )
        .bind(`"${term.slice(1)}"`)
        .first();
      if (live !== null) {
        heading = term.slice(1);
        break;
      }
    }
    // An ID with that trigram, which another document keeps too.
    const id = `q${heading ?? ""}7`;
    const document = await saveOver(
      admin,
      handbook.id,
      "ticket.md",
      `# Ticket\nCase ${id}.`
    );
    await saveOver(admin, handbook.id, "kept.md", `# Kept\nCase ${id}.`);
    const watching = await watchingPurge(admin);
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: [id],
      reason: "other",
    };
    const { token } = await watching.api.knowledge.preparePurge(input);
    await watching.api.knowledge.purge(input, token);
    const read = await admin.api.knowledge.getDocument(document.id);
    expect({
      found: heading !== undefined,
      removed: !read.version.text.includes(id),
      rebuilds: watching.written.rebuilds,
    }).toStrictEqual({ found: true, removed: true, rebuilds: 0 });
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

  it("leaves frontmatter that still reads, where a name is the title, owner or a tag", async () => {
    const admin = await personOf("admin");
    const name = `Visser${unique()}`;
    const email = `${name.toLowerCase()}@acme.test`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "person.md",
      `---\ntitle: ${name}\nowner: ${email}\ntags: [${name}, hr]\n---\n# Profile\n${name} works in HR.`
    );
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [name, email],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect({
      title: read.title,
      owner: read.owner,
      tags: read.tags,
      text: read.version.text,
    }).toStrictEqual({
      title: "(removed)",
      owner: "(removed)",
      tags: ["(removed)", "hr"],
      text: "---\ntitle: (removed)\nowner: (removed)\ntags: [(removed), hr]\n---\n# Profile\n(removed) works in HR.",
    });
  });

  it("purges a document whose type this release doesn't know, which then saves as a type it does", async () => {
    const admin = await personOf("admin");
    const name = `Visser${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "tasks/offboard.md",
      `# Offboard\n${name} returns the laptop.`
    );
    // As an App once declared it: a `task`, which nothing declares now.
    const task = `---\ntype: task\nstatus: open\n---\n# Offboard\n${name} returns the laptop.`;
    await env.KNOWLEDGE.batch([
      ...(await storeTextUnderneath(document.id, task)),
      env.KNOWLEDGE.prepare("UPDATE documents SET type = ? WHERE id = ?").bind(
        "task",
        document.id
      ),
    ]);

    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: [name],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    const saved = await admin.api.knowledge.saveDocument({
      collectionId: handbook.id,
      path: "tasks/offboard.md",
      text: "---\ntype: doc\n---\n# Offboard\nThe laptop is returned.",
      ifVersion: read.currentVersion,
    });

    expect({
      texts: await versionTexts(document.id),
      saved: { type: saved.type, version: saved.currentVersion },
    }).toStrictEqual({
      texts: [
        // The version it held, rewritten, and the version the purge saves.
        "---\ntype: task\nstatus: open\n---\n# Offboard\n(removed) returns the laptop.",
        "---\ntype: task\nstatus: open\n---\n# Offboard\n(removed) returns the laptop.",
        "---\ntype: doc\n---\n# Offboard\nThe laptop is returned.",
      ],
      saved: { type: "doc", version: 3 },
    });
  });

  it("removes a term as a whole word, in any case and next to punctuation, and counts where it is inside a longer word", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    await saveOver(admin, handbook.id, "team.md", "# Team\nTom planned it.");
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      "# Team\nTom planned it, tom automated it (Tom). Ask Tom, then Tomas or Ann's team.\nMail tom.visser@acme.test or Tom.Visser@ACME.test, not atom.visser@acme.test."
    );
    const { plan } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["Tom", "Ann", "tom.visser@acme.test"],
      reason: "offboarding",
    });
    const purgedText =
      "# Team\n(removed) planned it, (removed) automated it ((removed)). Ask (removed), then Tomas or (removed)'s team.\nMail (removed) or (removed), not atom.visser@acme.test.";
    expect({
      versions: await versionTexts(document.id),
      // Left inside or at the start of a longer word or address, which a
      // search for part of a word still finds: "planned" in the first
      // version; "planned", "automated", "Tomas" and
      // "atom.visser@acme.test" in the second and in the one the purge
      // saves.
      inLongerWords: plan.inLongerWords,
    }).toStrictEqual({
      // The two saved, and the one saved as the purge's.
      versions: ["# Team\n(removed) planned it.", purgedText, purgedText],
      inLongerWords: 9,
    });
  });

  it("counts the forms left in every version it leaves, the one it saves too", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      "# Team\nTom Tomas"
    );
    const { plan } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["Tom"],
      reason: "offboarding",
    });
    expect({
      versions: await versionTexts(document.id),
      inLongerWords: plan.inLongerWords,
    }).toStrictEqual({
      versions: ["# Team\n(removed) Tomas", "# Team\n(removed) Tomas"],
      inLongerWords: 2,
    });
  });

  it("treats an address or a domain as one word, never found inside a longer one, and removes it next to punctuation", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "mail.md",
      "# Mail\nNot tom.visser@acme.test.evil or evil.tom.visser@acme.test, but tom.visser@acme.test.\nOr (tom.visser@acme.test)."
    );
    const { plan } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["tom.visser@acme.test"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect({
      text: read.version.text,
      // Both longer addresses, in the version saved and in the one the
      // purge saves.
      inLongerWords: plan.inLongerWords,
    }).toStrictEqual({
      text: "# Mail\nNot tom.visser@acme.test.evil or evil.tom.visser@acme.test, but (removed).\nOr ((removed)).",
      inLongerWords: 4,
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

  it("removes a name with a hyphen in it", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      "# Team\nAnne-Marie left; Anne stays."
    );
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["Anne-Marie"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect(read.version.text).toBe("# Team\n(removed) left; Anne stays.");
  });

  it("removes a term left joined only by a term removed next to it, and finds nothing when run again", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "log.md",
      "# Log\nTom.Ann left."
    );
    const input: PurgeInput = {
      type: "content",
      documentIds: [document.id],
      terms: ["Tom.", "Ann"],
      reason: "offboarding",
    };
    await purged(admin, input);
    const read = await admin.api.knowledge.getDocument(document.id);
    const again = await admin.api.knowledge.preparePurge(input);
    expect({
      text: read.version.text,
      again: {
        documents: again.documents,
        versions: again.versions,
      },
    }).toStrictEqual({
      text: "# Log\n(removed)(removed) left.",
      again: { documents: 0, versions: 0 },
    });
  });

  it("counts the forms left once the terms are removed", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      "# Team\nToms desk is empty."
    );
    const { plan } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["Tom", "Toms"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect({
      text: read.version.text,
      inLongerWords: plan.inLongerWords,
    }).toStrictEqual({
      text: "# Team\n(removed) desk is empty.",
      inLongerWords: 0,
    });
  });

  it("removes a name wrapped in invisible marks that don't join words", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    // A bidi isolate pair, left-to-right and right-to-left marks, and a
    // byte order mark: text copied from chats and PDFs carries them.
    const [isolate, popIsolate, leftToRight, rightToLeft, byteOrderMark] = [
      0x20_68, 0x20_69, 0x20_0e, 0x20_0f, 0xfe_ff,
    ].map((codePoint) => String.fromCodePoint(codePoint));
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\n${isolate}Tom${popIsolate} left, ${leftToRight}Tom${rightToLeft} left, ${byteOrderMark}Tom left.`
    );
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["Tom"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect(read.version.text).toBe(
      `# Team\n${isolate}(removed)${popIsolate} left, ${leftToRight}(removed)${rightToLeft} left, ${byteOrderMark}(removed) left.`
    );
  });

  it("needs nothing next to a side of a term that can't join a word", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "log.md",
      "# Log\nTom left.Next day, Tom left.\nAtom left.Now\na(Tom)b and Tom张伟"
    );
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["Tom left.", "(Tom)", "张伟"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    // Only "Atom left." stays: there the term starts with a letter, which
    // the "A" before it joins.
    expect(read.version.text).toBe(
      "# Log\n(removed)Next day, (removed)\nAtom left.Now\na(removed)b and Tom(removed)"
    );
  });

  it("finds whole words in any script, with accents as part of the word and what ends the index's token ending it", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    // "José" twice: once with its accent as one character, which only a
    // Unicode-aware boundary keeps from ending "Jos", and once as an e and
    // a combining acute. The index drops the accent from both, so both are
    // "Jose" to it, and go with that term. "Renée" is a longer word than
    // "René" and stays. A soft hyphen and a zero-width non-joiner end a
    // word, as they end the index's token.
    const decomposed = `Jose${String.fromCodePoint(0x3_01)}`;
    const softHyphen = String.fromCodePoint(0xad);
    const nonJoiner = String.fromCodePoint(0x20_0c);
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      `# Team\nRené, rené and RENÉ left; Renée stays.\nJos, Jose, ${decomposed} and José left.\nTom left; Tom${softHyphen}my and Tom${nonJoiner}s go.`
    );
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["René", "Jos", "Jose", "Tom"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect(read.version.text).toBe(
      `# Team\n(removed), (removed) and (removed) left; Renée stays.\n(removed), (removed), (removed) and (removed) left.\n(removed) left; (removed)${softHyphen}my and (removed)${nonJoiner}s go.`
    );
  });

  it("finds a term inside running text in scripts written without spaces", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      handbook.id,
      "team.md",
      "# Team\n我和张伟去了。我和Tom去了。\nฉันกับสมชายไปตลาด\nTomas stays."
    );
    const { plan } = await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["张伟", "สมชาย", "Tom"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect({
      text: read.version.text,
      // Only "Tomas", in the version saved and the one the purge saves:
      // the letters around the others don't make them longer.
      inLongerWords: plan.inLongerWords,
    }).toStrictEqual({
      text: "# Team\n我和(removed)去了。我和(removed)去了。\nฉันกับ(removed)ไปตลาด\nTomas stays.",
      inLongerWords: 2,
    });
  });

  it("leaves frontmatter values that hold a term inside a word, so it can purge the document", async () => {
    const admin = await personOf("admin");
    const decisions = await admin.api.knowledge.createCollection({
      name: "Decisions",
      access: "everyone",
    });
    const document = await saveOver(
      admin,
      decisions.id,
      "tooling.md",
      "---\ntype: decision\nstatus: accepted\n---\n# Tooling\nTed accepted it, as Ann planned."
    );
    await purged(admin, {
      type: "content",
      documentIds: [document.id],
      terms: ["Ted", "Ann"],
      reason: "offboarding",
    });
    const read = await admin.api.knowledge.getDocument(document.id);
    expect(read.version.text).toBe(
      "---\ntype: decision\nstatus: accepted\n---\n# Tooling\n(removed) accepted it, as (removed) planned."
    );
  });

  it("rewrites every version, however many there are", async () => {
    const admin = await personOf("admin");
    const name = `Bakker${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const saved = 23;
    let documentId = "";
    for (let number = 1; number <= saved; number += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one version after another
      const summary = await saveOver(
        admin,
        handbook.id,
        "log.md",
        `# Log\n${name} did thing ${number}.`
      );
      documentId = summary.id;
    }
    const { plan, result } = await purged(admin, {
      type: "content",
      documentIds: [documentId],
      terms: [name],
      reason: "other",
    });
    const texts = await versionTexts(documentId);
    // Run again once finished: nothing found, nothing written.
    const again = await purged(admin, {
      type: "content",
      documentIds: [documentId],
      terms: [name],
      reason: "other",
    });
    const textsAgain = await versionTexts(documentId);
    expect({
      planned: plan.versions,
      rewritten: result.versions,
      versions: texts.length,
      holding: texts.filter((text) => text.includes(name)).length,
      last: texts.at(-1),
      again: { ...again.result, purgeId: typeof again.result.purgeId },
      unchanged: textsAgain,
    }).toStrictEqual({
      planned: saved,
      rewritten: saved,
      versions: saved + 1,
      holding: 0,
      last: `# Log\n(removed) did thing ${saved}.`,
      again: { purgeId: "string", documents: 0, versions: 0, stillFound: 0 },
      unchanged: texts,
    });
  });

  it("purges more documents than one statement may bind values for", async () => {
    const admin = await personOf("admin");
    const name = `Visser${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    // Past 25: four values each, 100 a statement at most.
    const named = 30;
    const documentIds: string[] = [];
    for (let number = 1; number <= named; number += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one document after another
      const summary = await saveOver(
        admin,
        handbook.id,
        `page-${number}.md`,
        `# Page ${number}\n${name} wrote it.`
      );
      documentIds.push(summary.id);
    }
    const { result } = await purged(admin, {
      type: "content",
      documentIds,
      terms: [name],
      reason: "other",
    });
    const stillHolding = await Promise.all(
      documentIds.map(async (documentId) => {
        const texts = await versionTexts(documentId);
        return texts.some((text) => text.includes(name));
      })
    );

    expect({
      documents: result.documents,
      holding: stillHolding.filter(Boolean).length,
    }).toStrictEqual({ documents: named, holding: 0 });
  });

  it("saves a new version when only earlier versions held a term", async () => {
    const admin = await personOf("admin");
    const name = `Dekker${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    await saveOver(admin, handbook.id, "note.md", `# Note\n${name} was here.`);
    const note = await saveOver(
      admin,
      handbook.id,
      "note.md",
      "# Note\nNobody here."
    );
    const { result } = await purged(admin, {
      type: "content",
      documentIds: [note.id],
      terms: [name],
      reason: "other",
    });
    const { versions } = await admin.api.knowledge.history(note.id);
    expect({
      versions: result.versions,
      texts: await versionTexts(note.id),
      messages: versions.map(({ message }) => message),
    }).toStrictEqual({
      versions: 1,
      // So anyone who restored the first before it was purged conflicts.
      texts: [
        "# Note\n(removed) was here.",
        "# Note\nNobody here.",
        "# Note\nNobody here.",
      ],
      messages: ["Personal data removed", null, null],
    });
  });

  it("fails for a save made from text not yet purged, and finishes when run again", async () => {
    const admin = await personOf("admin");
    const name = `Smit${unique()}`;
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    await saveOver(admin, handbook.id, "note.md", `# Note\n${name} one.`);
    const note = await saveOver(
      admin,
      handbook.id,
      "note.md",
      `# Note\n${name} two.`
    );
    // Knowledge as the purge's request sees it: once the purge first
    // writes (its audit event, before any version), someone saves from the
    // text they had open.
    let saved = false;
    const racing = await apiWith(admin, {
      afterBatch: async () => {
        if (!saved) {
          saved = true;
          await saveOver(admin, handbook.id, "note.md", `# Note\n${name} 3.`);
        }
      },
    });
    const input: PurgeInput = {
      type: "content",
      documentIds: [note.id],
      terms: [name],
      reason: "other",
    };
    const { token } = await admin.api.knowledge.preparePurge(input);
    const first = await outcome(racing.knowledge.purge(input, token));
    const afterFirst = await versionTexts(note.id);
    const again = await purged(admin, input);
    expect({
      saved,
      first,
      afterFirst: afterFirst.map((text) => text.includes(name)),
      again: again.result.versions,
      afterAgain: await versionTexts(note.id),
    }).toStrictEqual({
      saved: true,
      first: "knowledge.conflict",
      // The earlier version was rewritten; the current one, and the one
      // saved meanwhile, weren't.
      afterFirst: [false, true, true],
      again: 2,
      afterAgain: [
        "# Note\n(removed) one.",
        "# Note\n(removed) two.",
        "# Note\n(removed) 3.",
        "# Note\n(removed) 3.",
      ],
    });
  });

  it("refuses, before changing anything, a purge that makes an earlier version too large to store", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const log = await saveOver(
      admin,
      handbook.id,
      "log.md",
      "# Log\nQz was here."
    );
    const input: PurgeInput = {
      type: "content",
      documentIds: [log.id],
      terms: ["Qz"],
      reason: "other",
    };
    const { token } = await admin.api.knowledge.preparePurge(input);
    // 600 KB, within a document's 1 MB; 2 MB once each "Qz" is "(removed)".
    const huge = `# Log\n${"Qz ".repeat(200_000)}`;
    await saveOver(admin, handbook.id, "log.md", huge);
    await saveOver(admin, handbook.id, "log.md", "# Log\nNothing else.");
    let refused = "";
    const events = await auditedDuring(async () => {
      refused = await outcome(admin.api.knowledge.purge(input, token));
    });
    const texts = await versionTexts(log.id);
    expect({
      refused,
      prepared: await outcome(admin.api.knowledge.preparePurge(input)),
      purged: events.filter(({ action }) => action === "knowledge.purged")
        .length,
      first: texts[0],
      hugeKept: texts[1] === huge,
      versions: texts.length,
    }).toStrictEqual({
      refused: "knowledge.invalid",
      prepared: "knowledge.invalid",
      purged: 0,
      first: "# Log\nQz was here.",
      hugeKept: true,
      versions: 3,
    });
  });
});
