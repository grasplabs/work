import type { PurgeInput } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-outbox.ts";
import { mockIdp } from "./idp.ts";
import {
  apiWith,
  holding,
  indexedSections,
  lettersOf,
  payOwedRebuilds,
  purgesWith,
  saveOver,
  setUpTime,
  watchingPurge,
  erasing,
} from "./knowledge-purge.ts";
import type { Person } from "./knowledge-purge.ts";
import { ownCollectionOf } from "./knowledge.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

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

const { leaverWith } = purgesWith(idp);

/**
 * Purges `leaver`'s Personal collection as `admin`, saying what it wrote
 * and how often it rebuilt the whole index.
 */
const purgeCounted = async (
  admin: Person,
  leaver: Person,
  watch: Parameters<typeof watchingPurge>[1] = {}
) => {
  const counting = await watchingPurge(admin, watch);
  const input: PurgeInput = {
    type: "personal",
    userId: leaver.userId,
    reason: "offboarding",
  };
  await erasing(admin, leaver.userId);
  const { token } = await counting.api.knowledge.preparePurge(input);
  await counting.api.knowledge.purge(input, token);
  return counting.written;
};

/**
 * A word of a new person's notes that heads a page of the words index, in
 * one segment with a document of the handbook: words in order, alternating
 * between the two, so a page holds both and isn't emptied when the
 * person's go, and its directory entry, made from its first word, stays.
 */
const personsWordHeadingAPage = async (admin: Person) => {
  const handbook = await admin.api.knowledge.createCollection({
    name: "Handbook",
    access: "everyone",
  });
  const stem = `zq${lettersOf(Math.floor(Math.random() * 26 ** 6), 6)}`;
  const words = Array.from(
    { length: 3000 },
    (_, at) => `${stem}${lettersOf(at, 3)}`
  );
  const { leaver, personal } = await leaverWith({
    "even.md": `# Words\n${words.filter((_, at) => at % 2 === 0).join(" ")}`,
  });
  await saveOver(
    admin,
    handbook.id,
    "odd.md",
    `# Words\n${words.filter((_, at) => at % 2 === 1).join(" ")}`
  );
  await env.KNOWLEDGE.prepare(
    "INSERT INTO search_words (search_words) VALUES ('optimize')"
  ).run();
  const { results } = await env.KNOWLEDGE.prepare(
    "SELECT CAST(term AS TEXT) AS term FROM search_words_idx WHERE CAST(term AS TEXT) LIKE ?"
  )
    .bind(`0${stem}%`)
    .all<{ term: string }>();
  const leading = words.find(
    (word, at) =>
      at % 2 === 0 && results.some(({ term }) => term === `0${word}`)
  );
  return { leaver, personal, leading };
};

describe("a personal purge's search index", setUpTime, () => {
  it("writes no more to it however large the corpus, though the person's words are everyone's", async () => {
    const admin = await personOf("admin");
    const handbook = await admin.api.knowledge.createCollection({
      name: "Handbook",
      access: "everyone",
    });
    const common = "the plan for the team meeting is a note on leave and pay";
    /** Purges a new person's notes, in everyone's words and their name. */
    const purgeOne = async () => {
      const name = `leaver${unique()}`;
      const { leaver } = await leaverWith({
        "notes.md": `# Notes\n${common} with ${name}.\n\n## More\n${common}, ${name}.`,
      });
      return await purgeCounted(admin, leaver);
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
        `# Other ${at}\n${common} ${unique()}.\n\n## Part\n${common} ${unique()}.\n\n## Last\n${common} ${unique()}.`
      );
    }
    // In one segment, as FTS5's own merges put them in time: pages headed
    // by everyone's words.
    await env.KNOWLEDGE.prepare(
      "INSERT INTO search_words (search_words) VALUES ('optimize')"
    ).run();
    await env.KNOWLEDGE.prepare(
      "INSERT INTO search_trigrams (search_trigrams) VALUES ('optimize')"
    ).run();
    const added = (await indexedSections()) - before;
    await payOwedRebuilds();
    // The saves' audit events delivered first: a drain of them while the
    // purge runs would count as its writes.
    await drainAuditOutboxes(env);
    const large = await purgeOne();
    // A rebuild writes at least a row for each section the index holds.
    expect({
      grewBy: large.rows - small.rows,
      bound: large.rows - small.rows < added / 4,
      rebuilds: large.rebuilds,
    }).toMatchObject({ bound: true, rebuilds: 0 });
  });

  it("drops a word of the person's from the page directory, where it was the first term of a page", async () => {
    const admin = await personOf("admin");
    const { leaver, leading } = await personsWordHeadingAPage(admin);
    const heldBefore = leading === undefined ? [] : await holding(leading);
    await purgeCounted(admin, leaver);
    expect({
      found: leading !== undefined,
      heldBefore: heldBefore.includes("search_words_idx.term"),
      heldAfter: await holding(leading ?? ""),
    }).toStrictEqual({ found: true, heldBefore: true, heldAfter: [] });
  });

  it("drops a word the person had only in an earlier version from the page directory", async () => {
    const admin = await personOf("admin");
    const { leaver, personal, leading } = await personsWordHeadingAPage(admin);
    // Saved over: the earlier version's sections go, with secure deletes
    // that leave the page's directory entry, made from the word.
    await saveOver(leaver, personal, "even.md", "# Words\nNothing left here.");
    const heldBefore = leading === undefined ? [] : await holding(leading);
    await purgeCounted(admin, leaver);
    expect({
      found: leading !== undefined,
      heldBefore: heldBefore.includes("search_words_idx.term"),
      heldAfter: await holding(leading ?? ""),
    }).toStrictEqual({ found: true, heldBefore: true, heldAfter: [] });
  });

  it("rebuilds for a word next to a character it can't fold, and when run again after that fails", async () => {
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
    const name = `Visser${lettersOf(Math.floor(Math.random() * 26 ** 6), 6)}`;
    // A plain person, in words of their own (common words may head pages
    // earlier text left): checked, no rebuild.
    const plain = await leaverWith({ "notes.md": `# ${name}\n${name}.` });
    await payOwedRebuilds();
    const plainPurge = await purgeCounted(admin, plain.leaver);
    const { leaver } = await leaverWith({
      "notes.md": `# Notes\nAsk ${name}さん.`,
    });
    const input: PurgeInput = {
      type: "personal",
      userId: leaver.userId,
      reason: "offboarding",
    };
    await erasing(admin, leaver.userId);
    // The first run's rebuild fails, once its deletes committed.
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
    const again = await purgeCounted(admin, leaver);
    expect({
      plainRebuilds: plainPurge.rebuilds,
      first,
      againRebuilds: again.rebuilds,
    }).toStrictEqual({
      plainRebuilds: 0,
      first: "knowledge.purge_index_pending",
      againRebuilds: 1,
    });
  });

  it("rebuilds when the collection changes while the purge reads it", async () => {
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
    const name = `late${unique()}`;
    const { leaver, personal } = await leaverWith({
      "notes.md": "# Notes\nAsk me.",
    });
    await payOwedRebuilds();
    const { rebuilds } = await purgeCounted(admin, leaver, {
      beforeRead: async () => {
        await saveOver(leaver, personal, "notes.md", `# Notes\nAsk ${name}.`);
      },
    });
    expect({ rebuilds, held: await holding(name) }).toStrictEqual({
      rebuilds: 1,
      held: [],
    });
  });

  it("rebuilds when it can't read what the index holds, and never logs a word", async () => {
    const admin = await personOf("admin");
    const name = `refused${unique()}`;
    const { leaver } = await leaverWith({
      "notes.md": `# Notes\nAsk ${name}.`,
    });
    const logged: unknown[] = [];
    const spies = (["log", "info", "warn", "error"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      })
    );
    await payOwedRebuilds();
    let rebuilds = 0;
    try {
      ({ rebuilds } = await purgeCounted(admin, leaver, { refuseRead: true }));
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
      leaked: lines.filter((line) => line.includes(name)),
      rebuilds,
      held: await holding(name),
    }).toStrictEqual({
      checkFailed: true,
      leaked: [],
      rebuilds: 1,
      held: [],
    });
  });

  it("rebuilds past its caps, logging counts and never a word", async () => {
    const admin = await personOf("admin");
    /** Purges a person with `files`, saying what it logged and rebuilt. */
    const purgeLogged = async (files: Record<string, string>[]) => {
      const leaver = await personOf("user");
      const personal = await ownCollectionOf(leaver);
      for (const version of files) {
        for (const [path, text] of Object.entries(version)) {
          // oxlint-disable-next-line no-await-in-loop -- one save at a time
          await saveOver(leaver, personal, path, text);
        }
      }
      const logged: unknown[] = [];
      const spies = (["log", "info", "warn", "error"] as const).map((level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          logged.push(args);
        })
      );
      await payOwedRebuilds();
      try {
        const { rebuilds } = await purgeCounted(admin, leaver);
        return { rebuilds, lines: logged.map((args) => JSON.stringify(args)) };
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
    };
    // More distinct words than keys it looks up.
    const stem = `capped${lettersOf(Math.floor(Math.random() * 26 ** 4), 4)}`;
    const many = await purgeLogged([
      {
        "many.md": `# Many\n${Array.from(
          { length: 21_000 },
          (_, at) => `${stem}${lettersOf(at, 4)}`
        ).join(" ")}`,
      },
    ]);
    // More text than it reads, in short words, over two versions.
    const short = await purgeLogged([
      { "short.md": `# Short\n${"1 ".repeat(300_000)}` },
      { "short.md": `# Short\n${"2 ".repeat(300_000)}` },
    ]);
    // As much text after a NUL, where SQLite's `length` of a text stops:
    // found too much before any of it is read.
    const afterNul = await purgeLogged([
      { "nul.md": `# Nul\n\u0000${"3 ".repeat(300_000)}` },
      { "nul.md": `# Nul\n\u0000${"4 ".repeat(300_000)}` },
    ]);
    // One token of a mebibyte with a digit: as many trigrams as characters.
    const long = await purgeLogged([
      { "long.md": `# Long\n${stem}1${"x".repeat(1_000_000)}` },
    ]);
    // One token of letters longer than it works out, of a key of its own.
    const longWord = await purgeLogged([
      { "word.md": `# Word\n${stem}${"x".repeat(300)}` },
    ]);
    const outcomeOf = ({ rebuilds, lines }: typeof many) => ({
      capped: lines.some((line) =>
        line.includes("knowledge.purge.collection_check_capped")
      ),
      leaked: lines.filter((line) => line.includes(stem)),
      rebuilds,
    });
    const capLines = afterNul.lines.filter((line) =>
      line.includes("knowledge.purge.collection_check_capped")
    );
    expect({
      afterNul: {
        ...outcomeOf(afterNul),
        beforeReading: capLines.every((line) => !line.includes('"keys"')),
      },
      many: outcomeOf(many),
      short: outcomeOf(short),
      long: outcomeOf(long),
      longWord: outcomeOf(longWord),
    }).toStrictEqual({
      afterNul: { capped: true, leaked: [], rebuilds: 1, beforeReading: true },
      many: { capped: true, leaked: [], rebuilds: 1 },
      short: { capped: true, leaked: [], rebuilds: 1 },
      long: { capped: true, leaked: [], rebuilds: 1 },
      longWord: { capped: true, leaked: [], rebuilds: 1 },
    });
  });
});
