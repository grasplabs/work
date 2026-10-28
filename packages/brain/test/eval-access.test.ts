import { describe, expect, it } from "vite-plus/test";

import type { EvalCapability } from "../src/brain.ts";
import {
  moveSuiteVersion,
  proposeSuiteVersion,
  suiteCases,
  suiteVersion,
} from "../src/eval-suites.ts";
import type { EvalSplit } from "../src/eval-suites.ts";
import { knowledgeErrors } from "../src/knowledge.ts";
import { testHost, writerOf } from "./host.ts";

// Who may do what with a learning suite (GRA-311, L2; the Brain design's
// "Proposed optimizer and test access"). It starts from the ways it can
// fail: an optimizer reading a validation or final case, or an answer key
// before the suite is accepted; an optimizer shaping its own judge by
// proposing, calibrating or accepting; one principal holding the
// optimizer's capability with the designer's or evaluator's; anyone the
// host grants nothing reaching a suite at all.

/** A caller the host grants `evaluation` on every suite. */
const callerOf = (userId: string, evaluation: readonly EvalCapability[]) => ({
  userId,
  reads: [],
  evaluation,
});

const asDesigner = callerOf("designer", ["designer"]);
const asEvaluator = callerOf("evaluator", ["evaluator"]);
const asOptimizer = callerOf("optimizer", ["optimizer"]);
const asPublisher = callerOf("publisher", ["publication"]);
const asBoth = callerOf("both", ["optimizer", "designer"]);
const asOwner = callerOf("owner", []);

/** A refusal's code, or `ok`. */
const codeOf = async (call: Promise<unknown>): Promise<string> => {
  try {
    await call;
    return "ok";
  } catch (error) {
    return knowledgeErrors.codeOf(error) ?? String(error);
  }
};

/** A case in `split`. */
const caseOf = (caseId: string, split: EvalSplit) => ({
  caseId,
  split,
  family: `family-${caseId}`,
  group: caseId,
  source: `source-${caseId}`,
  input: { task: `Do ${caseId}` },
  expected: { answer: `answer for ${caseId}` },
});

/** A proposal of `suiteId`, owned by `owner`. */
const proposalOf = (suiteId: string) => ({
  suiteId,
  name: "Access requests",
  ownerId: "owner",
  cases: [
    caseOf("a", "development"),
    caseOf("b", "validation"),
    caseOf("c", "final"),
  ],
  grader: { version: "g1", requiredChecks: [], spec: {} },
  pins: {
    baseline: "skill@3",
    model: "workers-ai/test",
    environment: "sandbox@1",
    policy: "learning@1",
  },
  decision: {
    minimumGain: 0.05,
    confidence: "0.95",
    minimumSamples: 30,
    regressionFloor: 0.1,
    familyFloors: {},
    costCeiling: 1,
    latencyCeilingMs: 60_000,
    securityGates: [],
    minimumGraderAgreement: 0.8,
  },
});

describe("who may do what with a learning suite", () => {
  it("lets an optimizer read the development cases of an accepted version, and nothing else", async () => {
    const { brain } = testHost();
    const suiteId = `suite-${crypto.randomUUID()}`;
    const proposed = await proposeSuiteVersion(
      brain,
      asDesigner,
      writerOf("designer"),
      proposalOf(suiteId)
    );
    const beforeAccepted = await codeOf(
      suiteCases(brain, asOptimizer, suiteId, 1, "development")
    );
    const calibrated = await moveSuiteVersion(
      brain,
      asEvaluator,
      writerOf("evaluator"),
      suiteId,
      1,
      "calibrated",
      proposed.revision
    );
    await moveSuiteVersion(
      brain,
      asOwner,
      writerOf("owner"),
      suiteId,
      1,
      "accepted",
      calibrated.revision
    );
    const development = await suiteCases(
      brain,
      asOptimizer,
      suiteId,
      1,
      "development"
    );
    expect({
      beforeAccepted,
      development: development.map(({ caseId }) => caseId),
      validation: await codeOf(
        suiteCases(brain, asOptimizer, suiteId, 1, "validation")
      ),
      final: await codeOf(suiteCases(brain, asOptimizer, suiteId, 1, "final")),
      propose: await codeOf(
        proposeSuiteVersion(
          brain,
          asOptimizer,
          writerOf("optimizer"),
          proposalOf(suiteId)
        )
      ),
      calibrate: await codeOf(
        moveSuiteVersion(
          brain,
          asOptimizer,
          writerOf("optimizer"),
          suiteId,
          1,
          "calibrated",
          3
        )
      ),
      retire: await codeOf(
        moveSuiteVersion(
          brain,
          asOptimizer,
          writerOf("optimizer"),
          suiteId,
          1,
          "retired",
          3
        )
      ),
    }).toStrictEqual({
      beforeAccepted: "knowledge.not_found",
      development: ["a"],
      validation: "knowledge.not_found",
      final: "knowledge.not_found",
      propose: "knowledge.not_found",
      calibrate: "knowledge.not_found",
      retire: "knowledge.not_found",
    });
  });

  it("lets the evaluator read the sealed final set, publication no case, and refuses everything to one who optimizes and designs too", async () => {
    const { brain } = testHost();
    const suiteId = `suite-${crypto.randomUUID()}`;
    await proposeSuiteVersion(
      brain,
      asDesigner,
      writerOf("designer"),
      proposalOf(suiteId)
    );
    const final = await suiteCases(brain, asEvaluator, suiteId, 1, "final");
    expect({
      evaluator: final.map(({ expected }) => expected),
      publication: await codeOf(
        suiteCases(brain, asPublisher, suiteId, 1, "development")
      ),
      bothRead: await codeOf(
        suiteCases(brain, asBoth, suiteId, 1, "development")
      ),
      bothPropose: await codeOf(
        proposeSuiteVersion(
          brain,
          asBoth,
          writerOf("both"),
          proposalOf(suiteId)
        )
      ),
      ungranted: await codeOf(
        proposeSuiteVersion(
          brain,
          asOwner,
          writerOf("owner"),
          proposalOf(suiteId)
        )
      ),
    }).toStrictEqual({
      evaluator: [{ answer: "answer for c" }],
      publication: "knowledge.not_found",
      bothRead: "knowledge.not_found",
      bothPropose: "knowledge.not_found",
      ungranted: "knowledge.not_found",
    });
  });

  it("leaves the sealed set to the evaluator, retirement to the owner or evaluator, shows a version only to whoever has a part in it, audits held-out reads, and holds one identity", async () => {
    const { brain, events } = testHost();
    const suiteId = `suite-${crypto.randomUUID()}`;
    await proposeSuiteVersion(
      brain,
      asDesigner,
      writerOf("designer"),
      proposalOf(suiteId)
    );
    const designerFinal = await codeOf(
      suiteCases(brain, asDesigner, suiteId, 1, "final")
    );
    await suiteCases(brain, asEvaluator, suiteId, 1, "final");
    const nobody = callerOf("nobody", []);
    const retiredByNobody = await codeOf(
      moveSuiteVersion(
        brain,
        nobody,
        writerOf("nobody"),
        suiteId,
        1,
        "retired",
        1
      )
    );
    const shownToNobody = await codeOf(suiteVersion(brain, nobody, suiteId, 1));
    const shownToOwner = await suiteVersion(brain, asOwner, suiteId, 1);
    const mismatched = await codeOf(
      moveSuiteVersion(
        brain,
        asEvaluator,
        writerOf("someone-else"),
        suiteId,
        1,
        "calibrated",
        1
      )
    );
    const retired = await moveSuiteVersion(
      brain,
      asEvaluator,
      writerOf("evaluator"),
      suiteId,
      1,
      "retired",
      1
    );
    expect({
      designerFinal,
      retiredByNobody,
      shownToNobody,
      shownToOwner: shownToOwner.version,
      mismatched,
      retired: retired.state,
      audited: events.some(
        (event) =>
          event.action === "knowledge.eval_suite.cases_read" &&
          event.detail?.split === "final"
      ),
    }).toStrictEqual({
      designerFinal: "knowledge.not_found",
      retiredByNobody: "knowledge.not_found",
      shownToNobody: "knowledge.not_found",
      shownToOwner: 1,
      mismatched: "knowledge.forbidden",
      retired: "retired",
      audited: true,
    });
  });

  it("never lets an owner who optimizes against a suite accept or retire it, whatever else they hold", async () => {
    const { brain } = testHost();
    const suiteId = `suite-${crypto.randomUUID()}`;
    const proposed = await proposeSuiteVersion(
      brain,
      asDesigner,
      writerOf("designer"),
      proposalOf(suiteId)
    );
    const calibrated = await moveSuiteVersion(
      brain,
      asEvaluator,
      writerOf("evaluator"),
      suiteId,
      1,
      "calibrated",
      proposed.revision
    );
    /** What the owner holding `evaluation` gets moving the version `to`. */
    const ownerMoves = async (
      evaluation: readonly EvalCapability[],
      to: "accepted" | "retired"
    ) =>
      await codeOf(
        moveSuiteVersion(
          brain,
          callerOf("owner", evaluation),
          writerOf("owner"),
          suiteId,
          1,
          to,
          calibrated.revision
        )
      );

    expect({
      optimizer: await ownerMoves(["optimizer"], "accepted"),
      // Holding the optimizer's capability with another refuses that
      // other one, never the optimizer's restriction: it still holds.
      withDesigner: await ownerMoves(["optimizer", "designer"], "accepted"),
      withEvaluator: await ownerMoves(["optimizer", "evaluator"], "accepted"),
      retiresWithDesigner: await ownerMoves(
        ["optimizer", "designer"],
        "retired"
      ),
      retiresWithEvaluator: await ownerMoves(
        ["optimizer", "evaluator"],
        "retired"
      ),
    }).toStrictEqual({
      optimizer: "knowledge.not_found",
      withDesigner: "knowledge.not_found",
      withEvaluator: "knowledge.not_found",
      retiresWithDesigner: "knowledge.not_found",
      retiresWithEvaluator: "knowledge.not_found",
    });
  });
});
