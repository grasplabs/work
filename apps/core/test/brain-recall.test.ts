import type { MemoryPack, RecallInput } from "@grasp-os/brain/contract";
import type { KnowledgeApi, KnowledgeTools } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { brainOf } from "../src/knowledge/ports.ts";
import { d1BrainStore } from "../src/knowledge/recall-store.ts";
import { recall } from "../src/knowledge/recall.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { actingFor, collectionIn, envOf, knowledgeIn } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { newTeam, readCollection } from "./knowledge.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// The Brain's recall (knowledge/recall.ts), through the boundaries callers
// reach it by: a person's Knowledge RPC, an agent's Knowledge tools across
// what it may read, and a collection's stub. These tests start from the
// ways it can fail (GRA-296's threat note): forged authority in the
// arguments, a filter wider than the caller's reach, evidence from a
// collection the caller can't read, a binding kept after its grant is
// revoked, and a budget a recall ignores. Every caller reads through the
// same service and the same access predicate, so the same source answers
// the same way.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const personOf = async (role: Role) => {
  const person = await signedInApi(idp, role);
  const knowledge: KnowledgeApi = person.api.knowledge;
  return { ...person, knowledge };
};

type Person = Awaited<ReturnType<typeof personOf>>;

const newAgent = () => ({
  type: "agent" as const,
  agentId: `agent-${unique()}`,
});

const rareLetters = "abcdefghijklmnopqrstuvwxyz";

/** Random letters after the "zq" a rare word starts with. */
const rareWordLength = 16;

/**
 * A word no other test's document holds, nor comes close to: a recall that
 * finds nothing tries trigrams with room for one typo (search.ts), so two
 * rare words sharing two of their three pieces would find each other. A
 * UUID's letters alone (a to f, often under ten of them) did, about once in
 * a thousand pairs; 16 letters of 26 leave pieces no other word shares.
 */
const rareWord = (): string =>
  `zq${Array.from(
    crypto.getRandomValues(new Uint8Array(rareWordLength)),
    (byte) => rareLetters.charAt(byte % rareLetters.length)
  ).join("")}`;

/** A collection of `access` with one document saying `text`. */
const collectionSaying = async (
  owner: Person,
  access: "everyone" | "me",
  text: string
) => {
  const { id: collectionId } = await owner.knowledge.createCollection({
    name: `Handbook ${unique()}`,
    access,
  });
  const document = await owner.knowledge.saveDocument({
    collectionId,
    path: "onboarding.md",
    text,
    ifVersion: 0,
  });
  return { collectionId, documentId: document.id };
};

/** What the Brain answered, as a test compares it. */
const cited = (pack: MemoryPack) => ({
  sources: pack.sourceVersions,
  statements: pack.items.map(({ statement }) => statement),
  coverage: pack.coverage,
  truncated: pack.truncated,
});

/** The Knowledge tools of `agent` acting for `person`, recall among them. */
const agentRecall = async (
  agent: ReturnType<typeof newAgent>,
  person: Person
): Promise<KnowledgeTools> => {
  const tools = knowledgeIn(await envOf(actingFor(agent, person.userId)));
  if (!tools) {
    throw new Error("No KNOWLEDGE binding");
  }
  return tools;
};

describe("the Brain's recall", setUpTime, () => {
  it("answers a person evidence cited at its exact version and section, and the newer version once it changes", async () => {
    const admin = await personOf("admin");
    const word = rareWord();
    const { collectionId, documentId } = await collectionSaying(
      admin,
      "everyone",
      `# Onboarding\n\n## Owner\nJan owns ${word}.`
    );
    const first = await admin.knowledge.recall({ query: word });
    await admin.knowledge.saveDocument({
      collectionId,
      path: "onboarding.md",
      text: `# Onboarding\n\n## Owner\nPriya owns ${word} now.`,
      ifVersion: 1,
    });
    const second = await admin.knowledge.recall({ query: word });
    expect({
      first: cited(first),
      second: cited(second).sources,
      policy: [first.contractVersion, first.retrievalPolicyVersion],
      locator: first.items[0]?.citationLocator,
    }).toStrictEqual({
      first: {
        sources: [
          {
            kind: "document",
            documentId,
            collectionId,
            version: 1,
            section: 1,
          },
        ],
        statements: [`## Owner\nJan owns ${word}.`],
        coverage: {
          state: "complete",
          queriedRoutes: ["fulltext"],
          omittedRoutes: [{ route: "semantic", reason: "not_enabled" }],
        },
        truncated: false,
      },
      second: [
        { kind: "document", documentId, collectionId, version: 2, section: 1 },
      ],
      policy: [1, "fulltext@2"],
      locator: ["Onboarding", "Onboarding", "Owner"],
    });
  });

  it("finds a question's section by its words, the one holding most of them first", async () => {
    const admin = await personOf("admin");
    const word = rareWord();
    const { collectionId, documentId } = await collectionSaying(
      admin,
      "everyone",
      [
        "# Depot",
        "",
        "## Parking",
        `Parking at the ${word} depot is behind the building.`,
        "",
        "## Opening hours",
        `On weekdays the ${word} depot opens at seven in the morning.`,
      ].join("\n")
    );
    const pack = await admin.knowledge.recall({
      query: `When does the ${word} depot open on weekdays?`,
      filters: { collectionIds: [collectionId] },
    });
    const sections = pack.items.flatMap(({ sourceRefs }) =>
      sourceRefs.flatMap((ref) =>
        ref.kind === "document" && ref.documentId === documentId
          ? [ref.section]
          : []
      )
    );
    // Every section repeats the document's title, so each matches; the
    // one with the question's own words ranks first, the parking next.
    expect(sections.slice(0, 2)).toStrictEqual([2, 1]);
  });

  it("refuses forged authority and wider reach in its arguments, before reading anything", async () => {
    const admin = await personOf("admin");
    const user = await personOf("user");
    const word = rareWord();
    const mine = await collectionSaying(admin, "me", `# Private\n${word}`);
    const refused = await Promise.all(
      [
        { query: word, actor: user.userId },
        { query: word, admin: true },
        { query: word, filters: { scope: "company" } },
        { query: word, filters: { sql: "1=1" } },
        { query: word, budget: { maxItems: 1000 } },
      ].map(
        async (forged) =>
          // SAFETY: invalid on purpose; the service must refuse it.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
          await outcome(user.knowledge.recall(forged as RecallInput))
      )
    );
    // Another person's collection and one that doesn't exist answer alike.
    const hidden = await outcome(
      user.knowledge.recall({
        query: word,
        filters: { collectionIds: [mine.collectionId] },
      })
    );
    const missing = await outcome(
      user.knowledge.recall({
        query: word,
        filters: { collectionIds: ["no-such-collection"] },
      })
    );
    const unfiltered = await user.knowledge.recall({ query: word });
    expect({
      refused,
      hidden,
      missing,
      found: cited(unfiltered).sources,
    }).toStrictEqual({
      refused: [
        "brain.invalid",
        "brain.invalid",
        "brain.invalid",
        "brain.invalid",
        "brain.invalid",
      ],
      hidden: "brain.not_found",
      missing: "brain.not_found",
      found: [],
    });
  });

  it("answers an agent only under its brain grant, only from the collections it was granted, and stops when either is revoked", async () => {
    const admin = await personOf("admin");
    const agent = newAgent();
    const word = rareWord();
    const granted = await collectionSaying(
      admin,
      "everyone",
      `# Granted\n${word} lives here.`
    );
    const ungranted = await collectionSaying(
      admin,
      "everyone",
      `# Ungranted\n${word} lives here too.`
    );
    const collectionGrant = await requestGranted(
      idp,
      admin,
      readCollection(agent, granted.collectionId)
    );
    const tools = await agentRecall(agent, admin);
    const stub = collectionIn(
      await envOf(actingFor(agent, admin.userId)),
      "HANDBOOK"
    );
    if (!stub) {
      throw new Error("No HANDBOOK binding");
    }
    // A collection grant alone gives no recall: Apps and agents start
    // without the Brain.
    const withoutBrain = await Promise.all([
      outcome(tools.recall({ query: word })),
      outcome(stub.recall({ query: word })),
    ]);
    const brainGrant = await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const before = cited(await tools.recall({ query: word })).sources;
    const throughStub = cited(await stub.recall({ query: word })).sources;
    const widened = await Promise.all([
      outcome(
        tools.recall({
          query: word,
          filters: { collectionIds: [ungranted.collectionId] },
        })
      ),
      outcome(
        stub.recall({
          query: word,
          filters: { collectionIds: [ungranted.collectionId] },
        })
      ),
    ]);
    await admin.api.permissions.revoke(collectionGrant);
    const afterCollection = [
      cited(await tools.recall({ query: word })).sources,
      await outcome(stub.recall({ query: word })),
    ];
    await requestGranted(
      idp,
      admin,
      readCollection(agent, granted.collectionId)
    );
    await admin.api.permissions.revoke(brainGrant);
    const afterBrain = await outcome(tools.recall({ query: word }));
    const only = {
      kind: "document",
      documentId: granted.documentId,
      collectionId: granted.collectionId,
      version: 1,
      section: 0,
    };
    expect({
      withoutBrain,
      before,
      throughStub,
      widened,
      afterCollection,
      afterBrain,
    }).toStrictEqual({
      withoutBrain: ["brain.denied", "brain.denied"],
      before: [only],
      throughStub: [only],
      widened: ["brain.not_found", "brain.not_found"],
      afterCollection: [[], "brain.denied"],
      afterBrain: "brain.denied",
    });
  });

  it("holds a recall to its budget, and says the pack was cut", async () => {
    const admin = await personOf("admin");
    const word = rareWord();
    const { documentId } = await collectionSaying(
      admin,
      "everyone",
      [
        "# Onboarding",
        `## One\n${word} one.`,
        `## Two\n${word} two.`,
        `## Three\n${word} three.`,
      ].join("\n\n")
    );
    const all = await admin.knowledge.recall({ query: word });
    const one = await admin.knowledge.recall({
      query: word,
      budget: { maxItems: 1 },
    });
    const fewTokens = await admin.knowledge.recall({
      query: word,
      budget: { maxTokens: 1 },
    });
    expect({
      all: [all.items.length, all.truncated, all.coverage.state],
      one: [one.items.length, one.truncated, one.coverage.state],
      fewTokens: [
        fewTokens.items.length,
        fewTokens.truncated,
        fewTokens.coverage.state,
        fewTokens.gaps.length,
      ],
      fromTheDocument: all.items.every(({ sourceRefs }) =>
        sourceRefs.every(
          (ref) => ref.kind === "document" && ref.documentId === documentId
        )
      ),
    }).toStrictEqual({
      all: [3, false, "complete"],
      one: [1, true, "bounded"],
      // Evidence matched; the budget cut it: no gap claimed.
      fewTokens: [0, true, "bounded", 0],
      fromTheDocument: true,
    });
  });

  it("records a recall as a read of what it returned, quotes at most 4,000 characters of a section, and changes its access revision with access", async () => {
    const admin = await personOf("admin");
    const user = await personOf("user");
    const word = rareWord();
    const { documentId } = await collectionSaying(
      admin,
      "everyone",
      `# Long\n\n## Section\n${word} ${"filler ".repeat(2000)}`
    );
    const found = await user.knowledge.recall({ query: word });
    const nothing = await user.knowledge.recall({ query: rareWord() });
    const logged = await allEvents();
    const events = logged.filter(
      ({ actor }) => actor.type === "person" && actor.userId === user.userId
    );
    const recalls = events
      .filter(({ detail }) => detail.via === "recall")
      .map(({ action, provenance }) => [
        action,
        provenance?.includes(documentId),
      ]);
    // A collection the person can read is added: what they may read changed.
    await collectionSaying(user, "me", "# Mine\nNothing here.");
    const afterNew = await user.knowledge.recall({ query: word });
    expect({
      quoted: found.items[0]?.statement.length,
      recalls,
      emptySearches: events.filter(
        ({ action }) => action === "knowledge.search.empty"
      ).length,
      sameAccess: nothing.accessRevision === found.accessRevision,
      changedAccess: afterNew.accessRevision === found.accessRevision,
    }).toStrictEqual({
      quoted: 4000,
      recalls: [
        ["knowledge.search", true],
        ["knowledge.search", false],
      ],
      emptySearches: 0,
      sameAccess: true,
      changedAccess: false,
    });
  });

  it("answers an agent nothing from a granted collection its person can't read", async () => {
    const admin = await personOf("admin");
    const user = await personOf("user");
    const agent = newAgent();
    const word = rareWord();
    const team = await newTeam(admin, [admin]);
    const { id: collectionId } = await admin.knowledge.createCollection({
      name: `Team ${unique()}`,
      access: "teams",
      teams: [team],
    });
    await admin.knowledge.saveDocument({
      collectionId,
      path: "plan.md",
      text: `# Plan\n${word}`,
      ifVersion: 0,
    });
    await requestGranted(idp, admin, readCollection(agent, collectionId));
    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const forUser = await agentRecall(agent, user);
    const forAdmin = await agentRecall(agent, admin);
    expect({
      user: cited(await forUser.recall({ query: word })).sources.length,
      userNamed: await outcome(
        forUser.recall({
          query: word,
          filters: { collectionIds: [collectionId] },
        })
      ),
      admin: cited(await forAdmin.recall({ query: word })).sources.length,
    }).toStrictEqual({ user: 0, userNamed: "brain.not_found", admin: 1 });
  });

  it("quotes a match deep in a long section with the words around it", async () => {
    const admin = await personOf("admin");
    const word = rareWord();
    await collectionSaying(
      admin,
      "everyone",
      `# Long\n\n## Section\n${"filler ".repeat(1500)}${word} closes the matter. ${"tail ".repeat(400)}`
    );
    const pack = await admin.knowledge.recall({ query: word });
    const statement = pack.items[0]?.statement ?? "";
    expect({
      holdsTheMatch: statement.includes(`${word} closes the matter.`),
      length: statement.length,
    }).toStrictEqual({ holdsTheMatch: true, length: 4000 });
  });

  it("refuses a hidden or missing collection however short its deadline, never answering an empty pack", async () => {
    const admin = await personOf("admin");
    const user = await personOf("user");
    const word = rareWord();
    const mine = await collectionSaying(admin, "me", `# Private\n${word}`);
    const asked = async (collectionId: string) =>
      await outcome(
        user.knowledge.recall({
          query: word,
          filters: { collectionIds: [collectionId] },
          budget: { deadlineMs: 1 },
        })
      );
    await expect(
      Promise.all([asked(mine.collectionId), asked("no-such-collection")])
    ).resolves.toStrictEqual(["brain.not_found", "brain.not_found"]);
  });

  it("counts the time its access reads take against its deadline, reading no evidence once that is spent", async () => {
    const admin = await personOf("admin");
    const word = rareWord();
    await collectionSaying(admin, "everyone", `# Onboarding\n${word}`);
    const person = await admin.api.whoami();
    const store = d1BrainStore(brainOf(env));
    let searched = false;
    const slowAccess = {
      ...store,
      accessKey: async (reader: Parameters<typeof store.accessKey>[0]) => {
        await scheduler.wait(400);
        return await store.accessKey(reader);
      },
      findEvidence: async (
        ...args: Parameters<typeof store.findEvidence>
      ): ReturnType<typeof store.findEvidence> => {
        searched = true;
        return await store.findEvidence(...args);
      },
    };
    const started = Date.now();
    const pack = await recall(
      brainOf(env),
      { type: "person", person },
      { query: word, budget: { deadlineMs: 200 } },
      undefined,
      slowAccess
    );
    const took = Date.now() - started;
    expect({
      coverage: pack.coverage.state,
      items: pack.items.length,
      gaps: pack.gaps.length,
      searched,
      withinAccessTimeAndAMargin: took < 400 + 150,
    }).toStrictEqual({
      coverage: "degraded",
      items: 0,
      gaps: 0,
      searched: false,
      withinAccessTimeAndAMargin: true,
    });
  });
});
