import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";

import { brainEvalCases, brainEvalSuiteVersions } from "../src/db/schema.ts";
import { sha256Hex } from "../src/encoding.ts";
import {
  changeSuiteOwner,
  moveSuiteVersion,
  proposeSuiteVersion,
} from "../src/eval-suites.ts";
import type { EvalSuiteProposal } from "../src/eval-suites.ts";
import { canonicalJson } from "../src/json.ts";
import { knowledgeErrors } from "../src/knowledge.ts";
import { testHost, writerOf } from "./host.ts";

// Learning suites as frozen versions (GRA-311, L1; the Brain design's
// evaluation service). It starts from the ways it can fail: related
// variants leaking across splits; a version changing after it was read,
// or accepted by anyone but its owner, or from a revision they didn't
// read; scores compared across versions whose cases or grader differ;
// answer keys reaching whoever reads a version.

const designer = writerOf("designer");
const owner = writerOf("owner");

/** Why a database write failed, with what caused it, or `ok`. */
const failureOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
    return "ok";
  } catch (error) {
    return error instanceof Error
      ? `${error.message} ${String(error.cause)}`
      : String(error);
  }
};

/** A refusal's code, or `ok`. */
const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
    return "ok";
  } catch (error) {
    return knowledgeErrors.codeOf(error) ?? String(error);
  }
};

/** A case of `family`, `group` and `source`, in `split`. */
const caseOf = (
  caseId: string,
  split: "development" | "validation" | "final",
  group = caseId,
  source = `source-${caseId}`
) => ({
  caseId,
  split,
  family: `family-${group}`,
  group,
  source,
  input: { task: `Do ${caseId}` },
  expected: { answer: `secret answer for ${caseId}` },
});

/** A proposal of suite `suiteId` with `cases`. */
const proposalOf = (
  suiteId: string,
  cases: EvalSuiteProposal["cases"]
): EvalSuiteProposal => ({
  suiteId,
  name: "Access requests",
  ownerId: "owner",
  cases,
  grader: {
    version: "g1",
    requiredChecks: ["account created"],
    spec: { judge: "independent" },
  },
  pins: {
    baseline: "skill@3",
    model: "workers-ai/test",
    environment: "sandbox@1",
    policy: "learning@1",
  },
});

const threeSplits = [
  caseOf("a", "development"),
  caseOf("b", "validation"),
  caseOf("c", "final"),
];

describe("a learning suite version", () => {
  it("keeps related variants and sources in one split, and every split filled", async () => {
    const { brain } = testHost();
    const suiteId = `suite-${crypto.randomUUID()}`;
    expect({
      group: await codeOf(
        proposeSuiteVersion(
          brain,
          designer,
          proposalOf(suiteId, [...threeSplits, caseOf("a2", "final", "a")])
        )
      ),
      source: await codeOf(
        proposeSuiteVersion(
          brain,
          designer,
          proposalOf(suiteId, [
            ...threeSplits,
            caseOf("d", "final", "d", "source-a"),
          ])
        )
      ),
      emptySplit: await codeOf(
        proposeSuiteVersion(
          brain,
          designer,
          proposalOf(suiteId, [
            caseOf("a", "development"),
            caseOf("b", "validation"),
          ])
        )
      ),
      apart: await codeOf(
        proposeSuiteVersion(brain, designer, proposalOf(suiteId, threeSplits))
      ),
    }).toStrictEqual({
      group: "knowledge.invalid",
      source: "knowledge.invalid",
      emptySplit: "knowledge.invalid",
      apart: "ok",
    });
  });

  it("is frozen by its digests: the same cases give the same digests as a new version, other cases or another grader give others, and no answer key is read back", async () => {
    const { brain } = testHost();
    const suiteId = `suite-${crypto.randomUUID()}`;
    const first = await proposeSuiteVersion(
      brain,
      designer,
      proposalOf(suiteId, threeSplits)
    );
    const reordered = await proposeSuiteVersion(
      brain,
      designer,
      proposalOf(suiteId, threeSplits.toReversed())
    );
    const changed = await proposeSuiteVersion(brain, designer, {
      ...proposalOf(suiteId, [
        ...threeSplits.slice(0, 2),
        { ...caseOf("c", "final"), expected: { answer: "another" } },
      ]),
      grader: {
        version: "g2",
        requiredChecks: ["account created"],
        spec: { judge: "independent" },
      },
    });
    expect({
      versions: [first.version, reordered.version, changed.version],
      sameDigests: reordered.digests,
      final: changed.digests.final === first.digests.final,
      grader: changed.digests.grader === first.digests.grader,
      development: changed.digests.development === first.digests.development,
      counts: first.counts,
      keys: JSON.stringify(first).includes("secret answer"),
    }).toStrictEqual({
      versions: [1, 2, 3],
      sameDigests: first.digests,
      final: false,
      grader: false,
      development: true,
      counts: {
        development: { cases: 1, families: 1 },
        validation: { cases: 1, families: 1 },
        final: { cases: 1, families: 1 },
      },
      keys: false,
    });
  });

  it("is accepted only by its owner, once calibrated, from the revision they read, and never changes after", async () => {
    const { brain } = testHost();
    const suiteId = `suite-${crypto.randomUUID()}`;
    const proposed = await proposeSuiteVersion(
      brain,
      designer,
      proposalOf(suiteId, threeSplits)
    );
    const early = await codeOf(
      moveSuiteVersion(brain, owner, suiteId, 1, "accepted", 1)
    );
    const calibrated = await moveSuiteVersion(
      brain,
      designer,
      suiteId,
      1,
      "calibrated",
      proposed.revision
    );
    const byDesigner = await codeOf(
      moveSuiteVersion(brain, designer, suiteId, 1, "accepted", 2)
    );
    const stale = await codeOf(
      moveSuiteVersion(brain, owner, suiteId, 1, "accepted", 1)
    );
    const accepted = await moveSuiteVersion(
      brain,
      owner,
      suiteId,
      1,
      "accepted",
      calibrated.revision
    );
    const again = await codeOf(
      moveSuiteVersion(brain, designer, suiteId, 1, "calibrated", 3)
    );
    const retiredByDesigner = await codeOf(
      moveSuiteVersion(brain, designer, suiteId, 1, "retired", 3)
    );
    const retired = await moveSuiteVersion(
      brain,
      owner,
      suiteId,
      1,
      "retired",
      accepted.revision
    );
    expect({
      early,
      byDesigner,
      stale,
      accepted: {
        state: accepted.state,
        by: accepted.acceptedBy,
        revision: accepted.revision,
      },
      again,
      retiredByDesigner,
      retired: retired.state,
    }).toStrictEqual({
      early: "knowledge.conflict",
      byDesigner: "knowledge.forbidden",
      stale: "knowledge.conflict",
      accepted: { state: "accepted", by: "owner", revision: 3 },
      again: "knowledge.conflict",
      retiredByDesigner: "knowledge.not_found",
      retired: "retired",
    });
  });

  it("is never owned by its designer, and keeps its owner from version to version unless the owner hands it on, from the next version", async () => {
    const { brain } = testHost();
    const suiteId = `suite-${crypto.randomUUID()}`;
    const selfOwned = await codeOf(
      proposeSuiteVersion(brain, designer, {
        ...proposalOf(suiteId, threeSplits),
        ownerId: "designer",
      })
    );
    const first = await proposeSuiteVersion(
      brain,
      designer,
      proposalOf(suiteId, threeSplits)
    );
    const otherOwner = await codeOf(
      proposeSuiteVersion(brain, designer, {
        ...proposalOf(suiteId, threeSplits),
        ownerId: "someone-else",
      })
    );
    const byDesigner = await codeOf(
      changeSuiteOwner(brain, designer, suiteId, "designer", first.revision)
    );
    const toDesigner = await codeOf(
      changeSuiteOwner(brain, owner, suiteId, "designer", first.revision)
    );
    const handed = await changeSuiteOwner(
      brain,
      owner,
      suiteId,
      "owner2",
      first.revision
    );
    const keptOld = await codeOf(
      proposeSuiteVersion(brain, designer, proposalOf(suiteId, threeSplits))
    );
    const next = await proposeSuiteVersion(brain, designer, {
      ...proposalOf(suiteId, threeSplits),
      ownerId: "owner2",
    });
    expect({
      selfOwned,
      otherOwner,
      byDesigner,
      toDesigner,
      handed: handed.ownerId,
      keptOld,
      next: next.ownerId,
    }).toStrictEqual({
      selfOwned: "knowledge.forbidden",
      otherOwner: "knowledge.forbidden",
      byDesigner: "knowledge.forbidden",
      toDesigner: "knowledge.forbidden",
      // A version's own owner never changes: the next one is theirs.
      handed: "owner",
      keptOld: "knowledge.forbidden",
      next: "owner2",
    });
  });

  it("compares labels as folded, refuses the same input in two splits, keys its digests, and refuses any edit in place", async () => {
    const { brain } = testHost();
    const suiteId = `suite-${crypto.randomUUID()}`;
    const folded = await codeOf(
      proposeSuiteVersion(
        brain,
        designer,
        proposalOf(suiteId, [...threeSplits, caseOf("a2", "final", " A ")])
      )
    );
    const sameInput = await codeOf(
      proposeSuiteVersion(
        brain,
        designer,
        proposalOf(suiteId, [
          ...threeSplits,
          { ...caseOf("e", "final"), input: { task: "Do a" } },
        ])
      )
    );
    const version = await proposeSuiteVersion(
      brain,
      designer,
      proposalOf(suiteId, threeSplits)
    );
    const plain = await sha256Hex(
      canonicalJson(threeSplits.filter(({ split }) => split === "final"))
    );
    const editCase = await failureOf(
      brain.db
        .update(brainEvalCases)
        .set({ expected: "{}" })
        .where(eq(brainEvalCases.suiteId, suiteId))
    );
    const editDigest = await failureOf(
      brain.db
        .update(brainEvalSuiteVersions)
        .set({ finalDigest: plain })
        .where(eq(brainEvalSuiteVersions.suiteId, suiteId))
    );
    expect({
      folded,
      sameInput,
      keyed: version.digests.final !== plain,
      editCase: editCase.includes("never updated"),
      editDigest: editDigest.includes("never updated"),
    }).toStrictEqual({
      folded: "knowledge.invalid",
      sameInput: "knowledge.invalid",
      keyed: true,
      editCase: true,
      editDigest: true,
    });
  });
});
