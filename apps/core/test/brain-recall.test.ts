import type { MemoryPack, RecallInput } from "@grasp-os/shared/brain-api";
import type { KnowledgeApi } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { describe, expect, it } from "vite-plus/test";

import { requestGranted } from "./apps.ts";
import { actingFor, collectionIn, envOf, knowledgeIn } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { readCollection } from "./knowledge.ts";
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

/** A word no other test's documents hold. */
const rareWord = (): string =>
  `zq${crypto.randomUUID().replaceAll(/[^a-f]/gu, "")}`;

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

/** An agent's recall across what it may read (`KnowledgeBinding`). */
interface Recalling {
  recall: (input: RecallInput) => Promise<MemoryPack>;
}

/** The recall of `agent`'s Knowledge tools acting for `person`. */
const agentRecall = async (
  agent: ReturnType<typeof newAgent>,
  person: Person
): Promise<Recalling> => {
  const tools = knowledgeIn(await envOf(actingFor(agent, person.userId)));
  if (!tools) {
    throw new Error("No KNOWLEDGE binding");
  }
  const recalling: unknown = tools;
  // SAFETY: `bindingsFor` gives `KNOWLEDGE` a `KnowledgeBinding`, which
  // has `recall` besides the tools' methods.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return recalling as Recalling;
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
      policy: [1, "fulltext@1"],
      locator: ["Onboarding", "Onboarding", "Owner"],
    });
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

  it("answers an agent only from what it was granted that its person may read, and stops at revocation", async () => {
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
    const grant = await requestGranted(
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
    await admin.api.permissions.revoke(grant);
    const afterTools = cited(await tools.recall({ query: word })).sources;
    const afterStub = await outcome(stub.recall({ query: word }));
    const only = (id: string) => ({
      kind: "document",
      documentId: id,
      collectionId: granted.collectionId,
      version: 1,
      section: 0,
    });
    expect({
      before,
      throughStub,
      widened,
      afterTools,
      afterStub,
    }).toStrictEqual({
      before: [only(granted.documentId)],
      throughStub: [only(granted.documentId)],
      widened: ["brain.not_found", "brain.not_found"],
      afterTools: [],
      afterStub: "brain.denied",
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
      fewTokens: [0, true, "bounded", 1],
      fromTheDocument: true,
    });
  });
});
