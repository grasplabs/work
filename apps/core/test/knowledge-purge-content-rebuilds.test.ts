import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { mockIdp } from "./idp.ts";
import {
  apiWith,
  holding,
  indexedSections,
  joinedWordHeadingAPage,
  lettersOf,
  payOwedRebuilds,
  purged,
  saveOver,
  setUpTime,
  watchingPurge,
} from "./knowledge-purge.ts";
import type { Person } from "./knowledge-purge.ts";
import { openRpc, outcome, signedInApi, unique } from "./sign-in.ts";

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

/** A new name: Visser and six letters. */
const nameOf = () =>
  `Visser${lettersOf(Math.floor(Math.random() * 26 ** 6), 6)}`;

describe("a purge of content", setUpTime, () => {
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
      // The same purge, gone on with (GRA-1122): what it rewrote in all.
      again: 1,
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
});
