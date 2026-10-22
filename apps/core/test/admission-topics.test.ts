import {
  admissionErrors,
  companyMaxTermChars,
  topicLeadMs,
  topicMaxActive,
  topicMaxPending,
  topicMaxTermChars,
  topicMaxTerms,
  topicTermSchema,
} from "@grasp-os/shared/admission";
import type { TopicInput } from "@grasp-os/shared/admission";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { saveTopic } from "../src/knowledge/admission-records.ts";
import {
  personColumns,
  personReferences,
  platformTopics,
} from "../src/knowledge/admission-topics.ts";
import {
  normalized,
  policyMaxRows,
  screen,
  termsPattern,
} from "../src/knowledge/admission.ts";
import { saveUserMemory } from "../src/knowledge/memory.ts";
import { actingFor, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// A company's own exclusion topics: what its admins keep out of the brain
// beyond Grasp's sensitive-data minimum. These tests start from the ways
// they can fail: someone but the company's admins changes them (a member,
// Grasp staff); a new topic lets writes through until it takes effect;
// retiring one loosens admission before its retirement is in effect; a
// topic edit loosens or rewrites Grasp's own topics; two admins' revisions
// overwrite each other; a topic's name or terms reach the audit log; and
// a revision saved while a write is being checked lets that write commit
// after the revision took effect, unchecked against it.

const idp = mockIdp();

/** A topic about a confidential project, with `term` as its one term. */
const topicWith = (term: string): TopicInput => ({
  ifRevision: 0,
  name: "Project Falcon",
  coverage: "The planned acquisition, code-named Falcon.",
  examples: [{ language: "en", text: `The ${term} deal closes in May.` }],
  terms: [term],
});

/** A signed-in person with a collection of their own. */
const personWithCollection = async (role: "admin" | "user" = "admin") => {
  const person = await signedInApi(idp, role);
  const { id } = await person.api.knowledge.createCollection({
    name: `Notes ${unique()}`,
    access: "me",
  });
  return { ...person, collectionId: id };
};

/** A unique word, as a confidential code name. */
const codeName = () => `falcon${unique().replaceAll("-", "")}`;

describe("company topics", { timeout: 60_000 }, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("are changed by the company's admins only, and listed for admins, Grasp staff included", async () => {
    const user = await signedInApi(idp, "user");
    const builder = await signedInApi(idp, "builder");
    const staffSession = await signedIn(idp, "grasp-staff", staffPerson());
    const { core: staffCore } = await openRpc(staffSession);
    const staff = { api: staffCore.authenticate() };
    const admin = await signedInApi(idp, "admin");
    const topic = topicWith(codeName());

    expect({
      userSaves: await outcome(user.api.admission.saveTopic(topic)),
      builderSaves: await outcome(builder.api.admission.saveTopic(topic)),
      staffSaves: await outcome(staff.api.admission.saveTopic(topic)),
      userLists: await outcome(user.api.admission.topics()),
      staffLists: await outcome(staff.api.admission.topics()),
      adminSaves: await outcome(admin.api.admission.saveTopic(topic)),
    }).toStrictEqual({
      userSaves: "role.forbidden",
      builderSaves: "role.forbidden",
      staffSaves: "role.forbidden",
      userLists: "role.forbidden",
      staffLists: "ok",
      adminSaves: "ok",
    });
  });

  it("keep a topic's text out from the moment it's saved, and record only its ID and revision", async () => {
    const admin = await personWithCollection();
    const term = codeName();
    let saved:
      | Awaited<ReturnType<typeof admin.api.admission.saveTopic>>
      | undefined;
    const events = await auditedDuring(async () => {
      saved = await admin.api.admission.saveTopic({
        ...topicWith(term),
        // Sooner than the lead: moved to it.
        effectiveAt: new Date(Date.now() - 3_600_000).toISOString(),
      });
    });
    const save = async (path: string, text: string) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId: admin.collectionId,
          path,
          text,
          ifVersion: 0,
        })
      );
    await admin.api.admission.saveTopic({
      ...topicWith(`${term}x*`),
      name: "Stem",
    });
    const topics = await admin.api.admission.topics();
    const mine = topics.find(
      ({ upcoming, current }) => (upcoming ?? current)?.id === saved?.id
    );

    expect({
      leadKept:
        Date.parse(saved?.effectiveAt ?? "") >= Date.now() + topicLeadMs - 5000,
      // Its terms as matched: any case or accents, any hyphenation.
      excluded: await save(
        "plan.md",
        `# Plan\nThe ${term.toUpperCase()} deal.`
      ),
      other: await save("runbook.md", "# Runbook\nRestart the queue."),
      // A trailing `*` matches any ending.
      stem: await save("stem.md", `The ${term}xyz deal.`),
      // Grasp's own topics, first, and unchanged.
      platformFirst: topics[0]?.current?.owner,
      health: await save("leave.md", "She is on sick leave."),
      listed: {
        upcoming: mine?.upcoming?.name,
        terms: mine?.upcoming?.terms,
        current: mine?.current ?? null,
      },
      events: events.map(({ action, target, detail }) => ({
        action,
        target,
        keys: Object.keys(detail).toSorted(),
      })),
      leaks: JSON.stringify(events).includes(term),
    }).toStrictEqual({
      leadKept: true,
      excluded: "knowledge.excluded",
      other: "ok",
      stem: "knowledge.excluded",
      platformFirst: "platform",
      health: "knowledge.held",
      listed: { upcoming: "Project Falcon", terms: [term], current: null },
      events: [
        {
          action: "knowledge.admission.topic_saved",
          target: { type: "admission_topic", id: saved?.id },
          keys: ["effectiveAt", "revision"],
        },
      ],
      leaks: false,
    });
  });

  it("keep applying a retired topic until its retirement is in effect", async () => {
    const admin = await personWithCollection();
    const term = codeName();
    const saved = await admin.api.admission.saveTopic(topicWith(term));
    const retired = await admin.api.admission.retireTopic({
      id: saved.id,
      ifRevision: 1,
    });
    const text = `# Plan\nThe ${term} deal.`;
    const save = async (path: string) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId: admin.collectionId,
          path,
          text,
          ifVersion: 0,
        })
      );
    const beforeEffect = await save("before.md");
    // Two minutes on: the retirement is in effect.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * topicLeadMs);
    const afterEffect = await save("after.md");

    expect({
      retired: [retired.revision, retired.retired],
      again: await outcome(
        admin.api.admission.retireTopic({ id: saved.id, ifRevision: 2 })
      ),
      revived: await outcome(
        admin.api.admission.saveTopic({
          ...topicWith(term),
          id: saved.id,
          ifRevision: 2,
        })
      ),
      beforeEffect,
      afterEffect,
    }).toStrictEqual({
      retired: [2, true],
      again: "admission.retired",
      revived: "admission.retired",
      beforeEffect: "knowledge.excluded",
      afterEffect: "ok",
    });
  });

  it("refuse to change Grasp's topics, and a revision from one that moved on", async () => {
    const admin = await signedInApi(idp, "admin");
    const term = codeName();
    const saved = await admin.api.admission.saveTopic(topicWith(term));
    const revise = async () =>
      await outcome(
        admin.api.admission.saveTopic({
          ...topicWith(term),
          id: saved.id,
          ifRevision: 1,
          name: "Project Falcon (renamed)",
        })
      );
    const [first, second] = await Promise.all([revise(), revise()]);
    const platform = await outcome(
      admin.api.admission.retireTopic({
        // Not a company topic's ID.
        id: "health",
        ifRevision: 1,
      })
    );
    const missing = await outcome(
      admin.api.admission.retireTopic({
        id: `company-${crypto.randomUUID()}`,
        ifRevision: 1,
      })
    );
    const noTerms = await outcome(
      admin.api.admission.saveTopic({ ...topicWith(term), terms: [] })
    );

    expect({
      revisions: [first, second].toSorted(),
      platform,
      missing,
      noTerms,
      message: admissionErrors.create("admission.conflict").message.length > 0,
    }).toStrictEqual({
      revisions: ["admission.conflict", "ok"],
      platform: "admission.invalid",
      missing: "admission.not_found",
      noTerms: "admission.invalid",
      message: true,
    });
  });

  it("check a write again when a topic may have taken effect between its check and its commit", async () => {
    const admin = await signedInApi(idp, "admin");
    const user = await signedInApi(idp, "user");
    const agent = { type: "agent" as const, agentId: `agent-${unique()}` };
    const asAgent = actingFor(agent, user.userId);
    const work = await newChat(agent);
    const term = codeName();
    const remembered = await outcome(
      saveUserMemory(
        env,
        asAgent,
        work,
        { type: "own" },
        { text: `Works on the ${term} deal.`, ifVersion: 0 },
        // Between admission and the batch: an admin saves a topic, and
        // the write is held up until it's about to take effect.
        async () => {
          await saveTopic(
            env,
            {
              userId: admin.userId,
              email: "",
              name: "",
              role: "admin",
              teams: [],
              staff: false,
              expiresAt: "",
            },
            topicWith(term)
          );
          vi.useFakeTimers({ toFake: ["Date"] });
          // Short of the time admission gave, but too close to it for
          // the batch to be sure to commit before it.
          vi.setSystemTime(Date.now() + topicLeadMs - 5000);
        }
      )
    );
    // Every version's text, as its payload in the Brain bucket holds it.
    const { results } = await env.KNOWLEDGE.prepare(
      "SELECT payload_key AS key FROM versions"
    ).all<{ key: string }>();
    const texts = await Promise.all(
      results.map(async ({ key }) => {
        const object = await env.BRAIN_OBJECTS.get(key);
        return object === null ? "" : await object.text();
      })
    );
    const stored = texts.filter((text) => text.includes(term)).length;

    expect({ remembered, stored }).toStrictEqual({
      remembered: "knowledge.excluded",
      stored: 0,
    });
  });

  it("match a term however it's spaced or hyphenated, in time linear in the text", async () => {
    const admin = await personWithCollection();
    const term = codeName();
    const saved = await admin.api.admission.saveTopic(
      topicWith(`${term}  -  19`)
    );
    const save = async (path: string, text: string) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId: admin.collectionId,
          path,
          text,
          ifVersion: 0,
        })
      );
    // A term spaced to make a backtracking detector try every way to
    // split a run of whitespace, kept as written and as saved.
    const spaced = "pay - - - - - - - - cut";
    const detectors = [
      termsPattern([spaced]),
      termsPattern([topicTermSchema.parse(spaced)]),
    ];
    const size = 50_000;
    const crafted = [
      `pay${" ".repeat(size)}x`,
      `pay ${"- ".repeat(size / 2)}x`,
      `${"pay ".repeat(size / 4)}x`,
    ];
    const slowest = Math.max(
      ...detectors.flatMap((detector) =>
        crafted.map((text) => {
          const started = performance.now();
          screen(text, [detector]);
          return performance.now() - started;
        })
      )
    );

    expect({
      terms: saved.terms,
      hyphenated: await save("plan.md", `The ${term}-19 plan.`),
      spaced: await save("notes.md", `The ${term} 19 notes.`),
      matches: detectors.map((detector) =>
        screen("We took a pay-cut.", [detector])
      ),
      // Each takes milliseconds; a backtracking detector, minutes.
      linear: slowest < 1000,
    }).toStrictEqual({
      terms: [`${term} 19`],
      hyphenated: "knowledge.excluded",
      spaced: "knowledge.excluded",
      matches: ["excluded", "excluded"],
      linear: true,
    });
  });

  it("never apply a revision a higher one supersedes before it takes effect", async () => {
    const admin = await personWithCollection();
    const term = codeName();
    const started = Date.now();
    const year = 365 * 24 * 60 * 60 * 1000;
    const saved = await admin.api.admission.saveTopic(topicWith(term));
    // Revision 2 from a year on, then the topic retired by revision 3,
    // from a minute on: revision 2 never takes effect.
    await admin.api.admission.saveTopic({
      ...topicWith(term),
      id: saved.id,
      ifRevision: 1,
      effectiveAt: new Date(started + year).toISOString(),
    });
    await admin.api.admission.retireTopic({ id: saved.id, ifRevision: 2 });
    const save = async (path: string) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId: admin.collectionId,
          path,
          text: `The ${term} deal.`,
          ifVersion: 0,
        })
      );
    const listed = async () => {
      const topics = await admin.api.admission.topics();
      const state = topics.find(
        ({ current, upcoming }) => (current ?? upcoming)?.id === saved.id
      );
      return {
        current: state?.current?.revision ?? null,
        upcoming: state?.upcoming?.revision ?? null,
      };
    };
    const before = { listed: await listed(), save: await save("before.md") };
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(started + 2 * topicLeadMs);
    const retired = { listed: await listed(), save: await save("retired.md") };
    // Half a minute before revision 2's time: within a write's window.
    // A sign-in doesn't last a year; an agent's memory needs none.
    vi.setSystemTime(started + year - 30_000);
    const agent = { type: "agent" as const, agentId: `agent-${unique()}` };
    const nearlyAYear = await outcome(
      saveUserMemory(
        env,
        actingFor(agent, admin.userId),
        await newChat(agent),
        { type: "own" },
        { text: `Works on the ${term} deal.`, ifVersion: 0 }
      )
    );

    expect({ before, retired, nearlyAYear }).toStrictEqual({
      before: {
        listed: { current: null, upcoming: 3 },
        save: "knowledge.excluded",
      },
      retired: { listed: { current: 3, upcoming: null }, save: "ok" },
      nearlyAYear: "ok",
    });
  });

  it("limit the topics a write's check reads, and hold every write past that", async () => {
    const admin = await personWithCollection();
    const term = codeName();
    const saved = await admin.api.admission.saveTopic(topicWith(term));
    const filler = `company-filler-${unique()}`;
    /** Adds `count` filler topics, each of one revision from `at`. */
    const fill = async (count: number, at: number, from = 0) =>
      await env.DB.prepare(
        `WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO admission_topics (id, revision, name, coverage, examples, owner, effective_at, created_at, terms)
         SELECT ? || '-' || i, 1, 'Filler', 'Filler', '[]', 'company', ?, ?, json_array(? || i) FROM n`
      )
        .bind(from + 1, from + count, filler, at, Date.now(), `${filler}w`)
        .run();
    const save = async (path: string) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId: admin.collectionId,
          path,
          text: "# Runbook\nRestart the queue.",
          ifVersion: 0,
        })
      );
    const stems = {
      short: await outcome(
        admin.api.admission.saveTopic(topicWith(`${term} ab*`))
      ),
      long: await outcome(
        admin.api.admission.saveTopic(topicWith(`${term}abc*`))
      ),
    };
    try {
      await fill(topicMaxActive, Date.now() - 1000);
      const active = {
        create: await outcome(
          admin.api.admission.saveTopic(topicWith(codeName()))
        ),
        revise: await outcome(
          admin.api.admission.saveTopic({
            ...topicWith(term),
            id: saved.id,
            ifRevision: 1,
          })
        ),
      };
      await fill(topicMaxPending, Date.now() + 3_600_000, topicMaxActive);
      const pending = {
        revise: await outcome(
          admin.api.admission.saveTopic({
            ...topicWith(term),
            id: saved.id,
            ifRevision: 2,
          })
        ),
        retire: await outcome(
          admin.api.admission.retireTopic({ id: saved.id, ifRevision: 2 })
        ),
      };
      const withinLimits = await save("within.md");
      await fill(
        policyMaxRows,
        Date.now() - 1000,
        topicMaxActive + topicMaxPending
      );
      const pastLimits = await save("past.md");

      expect({
        stems,
        active,
        pending,
        withinLimits,
        pastLimits,
      }).toStrictEqual({
        stems: { short: "admission.invalid", long: "ok" },
        active: { create: "admission.limit", revise: "ok" },
        pending: { revise: "admission.limit", retire: "ok" },
        withinLimits: "ok",
        pastLimits: "knowledge.held",
      });
    } finally {
      await env.DB.prepare("DELETE FROM admission_topics WHERE id LIKE ?")
        .bind(`${filler}-%`)
        .run();
    }
  });

  it("check a write against the company's topics in time linear in the text, however their terms share prefixes", async () => {
    const admin = await personWithCollection();
    const words = 45;
    /** `count` terms sharing all but their last word: `a a … a z<i>`. */
    const crafted = (prefix: string, count = topicMaxTerms) =>
      Array.from(
        { length: count },
        (_, index) => `${"a ".repeat(words - 1)}${prefix}${index}`
      );
    // As many as fit in the characters a topic's terms may have.
    const fitting = Math.floor(
      topicMaxTermChars / (crafted("z").at(-1)?.length ?? topicMaxTermChars)
    );
    await Promise.all(
      ["z", "y"].map(
        async (prefix) =>
          await admin.api.admission.saveTopic({
            ...topicWith(codeName()),
            terms: crafted(prefix, fitting),
          })
      )
    );
    const text = "a ".repeat(15_000);
    // Topics' terms as the gate compiles them, together, and a topic's own.
    const detectors = [
      termsPattern([...crafted("z"), ...crafted("y")]),
      termsPattern(crafted("z")),
    ];
    const started = performance.now();
    const matches = detectors.map((detector) => screen(text, [detector]));
    const screening = performance.now() - started;
    const save = async (path: string, saved: string) =>
      await outcome(
        admin.api.knowledge.saveDocument({
          collectionId: admin.collectionId,
          path,
          text: saved,
          ifVersion: 0,
        })
      );

    expect({
      matches,
      caught: detectors.map((detector) => screen(`${text}a y7.`, [detector])),
      saved: await save("crafted.md", text),
      excluded: await save("ending.md", `${text}a z${fitting - 1}.`),
      // A few milliseconds; terms tried one by one, about 10 s a topic.
      linear: screening < 500,
    }).toStrictEqual({
      matches: ["admitted", "admitted"],
      caught: ["excluded", "admitted"],
      saved: "ok",
      excluded: "knowledge.excluded",
      linear: true,
    });
  });

  it("limit the characters of terms a topic lists, and those a write's check reads", async () => {
    const admin = await personWithCollection();
    const saved = await admin.api.admission.saveTopic(topicWith(codeName()));
    const word = codeName();
    /** `count` distinct terms of about `length` characters each. */
    const termsOf = (count: number, length: number) =>
      Array.from({ length: count }, (_, index) =>
        `${word}${index}`.padEnd(length, "x")
      );
    const perTerm = Math.ceil(topicMaxTermChars / topicMaxTerms) + 1;
    const perTopic = {
      within: await outcome(
        admin.api.admission.saveTopic({
          ...topicWith(codeName()),
          terms: termsOf(topicMaxTerms, perTerm - 2),
        })
      ),
      past: await outcome(
        admin.api.admission.saveTopic({
          ...topicWith(codeName()),
          terms: termsOf(topicMaxTerms, perTerm),
        })
      ),
      // Six characters as written; each is 18 letters as matched.
      lengthened: await outcome(
        admin.api.admission.saveTopic({
          ...topicWith(codeName()),
          terms: ["\u{FDFA}".repeat(6)],
        })
      ),
    };
    const filler = `company-filler-${unique()}`;
    const termLength = 100;
    try {
      // Topics in use whose terms take up all the room there is.
      await env.DB.prepare(
        `INSERT INTO admission_topics (id, revision, name, coverage, examples, owner, effective_at, created_at, terms)
         VALUES (?, 1, 'Filler', 'Filler', '[]', 'company', ?, ?, ?)`
      )
        .bind(
          `${filler}-1`,
          Date.now() - 1000,
          Date.now(),
          JSON.stringify(termsOf(companyMaxTermChars / termLength, termLength))
        )
        .run();
      const full = {
        create: await outcome(
          admin.api.admission.saveTopic(topicWith(codeName()))
        ),
        revise: await outcome(
          admin.api.admission.saveTopic({
            ...topicWith(codeName()),
            id: saved.id,
            ifRevision: 1,
          })
        ),
        retire: await outcome(
          admin.api.admission.retireTopic({ id: saved.id, ifRevision: 1 })
        ),
      };

      expect({ perTopic, full }).toStrictEqual({
        perTopic: {
          within: "ok",
          past: "admission.invalid",
          lengthened: "admission.invalid",
        },
        full: {
          create: "admission.limit",
          revise: "admission.limit",
          retire: "ok",
        },
      });
    } finally {
      await env.DB.prepare("DELETE FROM admission_topics WHERE id LIKE ?")
        .bind(`${filler}-%`)
        .run();
    }
  });

  it("count only the terms of revisions that will take effect toward the limit", async () => {
    const admin = await personWithCollection();
    const nextYear = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const perTerm = Math.floor(topicMaxTermChars / topicMaxTerms);
    // Topics for next year whose terms take up all the room there is.
    const scheduled = await Promise.all(
      Array.from(
        { length: Math.ceil(companyMaxTermChars / topicMaxTermChars) },
        async () => {
          const word = codeName();
          return await admin.api.admission.saveTopic({
            ...topicWith(word),
            terms: Array.from({ length: topicMaxTerms }, (_, index) =>
              `${word}${index}`.padEnd(perTerm, "x")
            ),
            effectiveAt: nextYear.toISOString(),
          });
        }
      )
    );
    const full = await outcome(
      admin.api.admission.saveTopic(topicWith(codeName()))
    );
    // Each retirement takes effect long before next year: none of those
    // revisions ever will.
    await Promise.all(
      scheduled.map(
        async ({ id }) =>
          await admin.api.admission.retireTopic({ id, ifRevision: 1 })
      )
    );
    const retired = await outcome(
      admin.api.admission.saveTopic(topicWith(codeName()))
    );

    expect({ full, retired }).toStrictEqual({
      full: "admission.limit",
      retired: "ok",
    });
  });
});

const special = /[.*+?^${}()|[\]\\]/gu;
const termGap = /[\s-]+/u;
const stemMark = /\*$/u;

/**
 * Terms as one flat alternation, each tried in turn: the detector the
 * trie replaced, kept as the reference its matches must equal.
 */
const flatPattern = (terms: readonly string[]): RegExp => {
  const alternatives = terms.map((term) => {
    const stem = term.endsWith("*");
    const body = (stem ? term.slice(0, -1) : term)
      .split(termGap)
      .filter((word) => word !== "")
      .map((word) => word.replaceAll(special, String.raw`\$&`))
      .join(String.raw`\s+`);
    return stem ? String.raw`${body}\p{L}*` : body;
  });
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:${alternatives.join("|")})(?![\p{L}\p{N}])`,
    "u"
  );
};

/** A small seeded generator, so a failing text can be found again. */
const seeded = (seed: number) => {
  let state = seed;
  return (below: number): number => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % below;
  };
};

describe("company terms' detector", () => {
  it("matches what a flat alternation of the terms matches, where it does", () => {
    const termSets: Record<string, readonly string[]> = {
      crafted: [
        "pay",
        "pay cut",
        "pay cuts",
        "payroll",
        "pay*",
        "payr*",
        "reorgani*",
        "covid 19",
        "o'brien",
        "a.b",
        "a.b c",
        "sick",
        "sick*",
        "sick leave",
        "sick leave*",
        "ab cd ef",
        "ab cd*",
        "ab",
        "x",
        "café",
        "a a a b",
        "a a b",
        "a a a a c1",
        "a a a a c2",
      ],
      platform: [
        ...new Set(
          platformTopics.flatMap(({ rules }) => [
            ...rules.strong,
            ...rules.weak,
          ])
        ),
      ],
      people: [...personReferences, ...personColumns],
    };
    const vocabulary = [
      ...new Set(
        Object.values(termSets).flatMap((terms) =>
          terms.flatMap((term) => term.replace(stemMark, "").split(termGap))
        )
      ),
      "payrolls",
      "paycheck",
      "reorganisation",
      "reorganization2",
      "sickness",
      "o'briens",
      "a.b.c",
      "19",
      "cafe",
      "ABC",
      "€5",
      "",
    ];
    const separators = [
      " ",
      "  ",
      "\n",
      "\t",
      "-",
      " - ",
      ".",
      ",",
      "'",
      "_",
      "/",
    ];
    const random = seeded(1019);
    const pick = (items: readonly string[]): string =>
      items[random(items.length)] ?? "";
    const texts = Array.from({ length: 1500 }, () => {
      let text = pick(vocabulary);
      for (let words = random(12); words > 0; words -= 1) {
        text += `${pick(separators)}${pick(vocabulary)}`;
      }
      return text;
    });
    const differences = Object.entries(termSets).flatMap(([name, terms]) => {
      const trie = termsPattern(terms);
      const flat = flatPattern(terms);
      return texts
        .flatMap((text) => [text, normalized(text)])
        .filter((text) => trie.exec(text)?.index !== flat.exec(text)?.index)
        .map((text) => `${name}: ${JSON.stringify(text)}`);
    });
    const matched = texts.filter((text) =>
      termsPattern(termSets.crafted ?? []).test(normalized(text))
    ).length;

    expect({
      differences,
      // The corpus matches often, and not always.
      varied: matched > texts.length / 10 && matched < texts.length,
    }).toStrictEqual({ differences: [], varied: true });
  });
});
