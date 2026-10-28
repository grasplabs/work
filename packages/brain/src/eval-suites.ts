import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { auditedBatch, outboxed, outboxedIfChanged } from "./audit.ts";
import type { Brain, EvalCapability } from "./brain.ts";
import { brainEvalCases, brainEvalSuiteVersions } from "./db/schema.ts";
import { inChunks } from "./documents.ts";
import type { Writer } from "./documents.ts";
import { toHex } from "./encoding.ts";
import { decide, decisionPolicySchema } from "./eval-decision.ts";
import type { DecisionPolicy, Verdict } from "./eval-decision.ts";
import { canonicalJson } from "./json.ts";
import type { Json } from "./json.ts";
import { knowledgeErrors } from "./knowledge.ts";

export type {
  Comparison,
  DecisionPolicy,
  DecisionPolicyInput,
  HoldReason,
  Verdict,
} from "./eval-decision.ts";

// Learning suites, as versions frozen by their digests (GRA-311, L1; the
// Brain design's "Proposed evaluation service"): the cases, grader and
// pinned versions a skill is judged by. A designer proposes a version from
// permitted evidence; it is calibrated (L4) and accepted by its domain
// owner, naming the revision they read; from then on it never changes. A
// grader or case change is a new version, so scores are compared only
// within one.
//
// Cases fall in three splits: development (the optimizer may see them),
// validation (aggregate metrics only) and the sealed final set (the
// evaluator alone). A group of related variants, and every case from one
// source, stays in one split, so nothing leaks from one into another; a
// version whose splits share a group or source is refused. Each split's
// digest is kept with the version, so a run states exactly what it ran.
// Who may do what is the host's to grant (`ports.evaluation`), and each
// capability stays apart (GRA-311, L2; the Brain design's "Proposed
// optimizer and test access"):
//
// - a designer proposes versions and reads their development and
//   validation cases;
// - an evaluator calibrates a version and reads every split, the sealed
//   final one too, as the trusted grader: the final set is theirs alone;
// - an optimizer reads the development cases of an accepted version, and
//   nothing else: never a validation or final case, never an answer key
//   outside development, and it can't propose, calibrate or accept;
// - publication reads results, never a case.
//
// One who holds the optimizer's capability on a suite together with the
// designer's or evaluator's is refused all of them there: the one
// optimizing must never also shape or see what judges it, and the sealed
// final set is the evaluator's alone. Reads of the held-out cases are
// audited. Acceptance is the owner's alone, never its proposer's;
// retirement the owner's or the evaluator's. A version's metadata is
// shown to whoever holds a capability on it, or owns it. Whatever is
// refused answers as missing (`knowledge.not_found`), alike for a suite
// that isn't there. Cases live apart from everything recall, a skill's
// context or memory reads, so no answer key reaches them.

/** The splits of a suite's cases. */
export const evalSplits = ["development", "validation", "final"] as const;
export type EvalSplit = (typeof evalSplits)[number];

/** Most cases one suite version holds. */
export const evalCasesMax = 2000;

const caseSchema = z.strictObject({
  caseId: z.string().min(1).max(100),
  split: z.enum(evalSplits),
  family: z.string().min(1).max(100),
  group: z.string().min(1).max(100),
  source: z.string().min(1).max(200),
  input: z.json(),
  expected: z.json(),
});

const proposalSchema = z
  .strictObject({
    suiteId: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    ownerId: z.string().min(1).max(100),
    cases: z
      .array(caseSchema)
      .min(1)
      .max(evalCasesMax)
      .refine(
        (cases) =>
          new Set(cases.map(({ caseId }) => caseId)).size === cases.length,
        "Each case once"
      ),
    grader: z.strictObject({
      version: z.string().min(1).max(100),
      requiredChecks: z.array(z.string().min(1).max(200)).max(100),
      spec: z.json(),
    }),
    pins: z.strictObject({
      baseline: z.string().min(1).max(200),
      model: z.string().min(1).max(200),
      environment: z.string().min(1).max(200),
      policy: z.string().min(1).max(200),
    }),
    /** What a candidate must show to be published (eval-decision.ts). */
    decision: decisionPolicySchema,
  })
  .refine(
    ({ grader, decision }) =>
      grader.requiredChecks.every((check) =>
        decision.securityGates.includes(check)
      ),
    { message: "Every check the grader requires is a gate of the decision" }
  );
export type EvalSuiteProposal = z.input<typeof proposalSchema>;

/** A suite version, as anyone allowed to see it reads it: never a case. */
export interface EvalSuiteVersion {
  suiteId: string;
  version: number;
  revision: number;
  ownerId: string;
  name: string;
  state: "proposed" | "calibrated" | "accepted" | "retired";
  digests: Record<EvalSplit, string> & { grader: string };
  /** How many cases each split holds, and of how many families. */
  counts: Record<EvalSplit, { cases: number; families: number }>;
  grader: { version: string; requiredChecks: string[] };
  pins: {
    baseline: string;
    model: string;
    environment: string;
    policy: string;
  };
  /** What a candidate must show to be published, as proposed and accepted. */
  decision: DecisionPolicy;
  proposedBy: string;
  acceptedBy: string | null;
  acceptedAt: string | null;
}

/**
 * The keyed digest of a split's cases: an HMAC under a key the host
 * derives from a secret it holds, so a digest shown to whoever reads a
 * version can't confirm a guess at the cases, the sealed final ones
 * included (the GRA-311 review).
 */
const casesDigestOf = async <C>(
  brain: Brain<C>,
  value: Json
): Promise<string> => {
  const key = await brain.ports.keys.hmac("grasp-os eval suite cases v1", [
    "sign",
  ]);
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonicalJson(value))
  );
  return toHex(new Uint8Array(mac));
};

/** A group or source label as compared: trimmed, case and width folded. */
const labelOf = (label: string): string =>
  label.normalize("NFKC").trim().toLowerCase();

/**
 * Refuses, as `knowledge.invalid`, a group or source in more than one
 * split: related variants would leak from one into another.
 */
const requireApart = (cases: readonly z.infer<typeof caseSchema>[]): void => {
  // A group, a source, or the very same input, in one split alone.
  const keys = [
    ["group", (each: z.infer<typeof caseSchema>) => labelOf(each.group)],
    ["source", (each: z.infer<typeof caseSchema>) => labelOf(each.source)],
    ["input", (each: z.infer<typeof caseSchema>) => canonicalJson(each.input)],
  ] as const;
  for (const [name, keyOf] of keys) {
    const seen = new Map<string, EvalSplit>();
    for (const each of cases) {
      const key = keyOf(each);
      const before = seen.get(key);
      if (before !== undefined && before !== each.split) {
        throw knowledgeErrors.create("knowledge.invalid", {
          issues: [
            `cases: a ${name} of ${each.caseId} is in both ${before} and ${each.split}`,
          ],
        });
      }
      seen.set(key, each.split);
    }
  }
  for (const split of evalSplits) {
    if (!cases.some((each) => each.split === split)) {
      throw knowledgeErrors.create("knowledge.invalid", {
        issues: [`cases: none in ${split}`],
      });
    }
  }
};

const graderSchema = z.object({
  version: z.string(),
  requiredChecks: z.array(z.string()),
});

const pinsSchema = z.object({
  baseline: z.string(),
  model: z.string(),
  environment: z.string(),
  policy: z.string(),
});

/** Suite `suiteId`'s version `version`, ungated: never its cases. */
export const versionOf = async <C>(
  brain: Brain<C>,
  suiteId: string,
  version: number
): Promise<EvalSuiteVersion> => {
  const { db } = brain;
  const [row] = await db
    .select()
    .from(brainEvalSuiteVersions)
    .where(
      and(
        eq(brainEvalSuiteVersions.suiteId, suiteId),
        eq(brainEvalSuiteVersions.version, version)
      )
    );
  if (row === undefined) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  const cases = await db
    .select({ split: brainEvalCases.split, family: brainEvalCases.family })
    .from(brainEvalCases)
    .where(
      and(
        eq(brainEvalCases.suiteId, suiteId),
        eq(brainEvalCases.version, version)
      )
    );
  const countsOf = (split: EvalSplit) => {
    const of = cases.filter((each) => each.split === split);
    return {
      cases: of.length,
      families: new Set(of.map(({ family }) => family)).size,
    };
  };
  const grader = graderSchema.parse(JSON.parse(row.grader));
  return {
    suiteId,
    version,
    revision: row.revision,
    ownerId: row.ownerId,
    name: row.name,
    state: row.state,
    digests: {
      development: row.developmentDigest,
      validation: row.validationDigest,
      final: row.finalDigest,
      grader: row.graderDigest,
    },
    counts: {
      development: countsOf("development"),
      validation: countsOf("validation"),
      final: countsOf("final"),
    },
    grader: { version: grader.version, requiredChecks: grader.requiredChecks },
    pins: pinsSchema.parse(JSON.parse(row.pins)),
    decision: decisionPolicySchema.parse(JSON.parse(row.decision)),
    proposedBy: row.proposedBy,
    acceptedBy: row.acceptedBy,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
  };
};

/**
 * What `reader` may do with suite `suiteId`, the optimizer's never with
 * the designer's or evaluator's: refused whole when held together.
 */
const capabilitiesOf = async <C>(
  brain: Brain<C>,
  reader: C,
  suiteId: string
): Promise<ReadonlySet<EvalCapability>> => {
  const capabilities = brain.ports.evaluation?.capabilities;
  const granted = new Set<EvalCapability>(
    capabilities === undefined ? undefined : await capabilities(reader, suiteId)
  );
  const mixed =
    granted.has("optimizer") &&
    (granted.has("designer") || granted.has("evaluator"));
  return mixed ? new Set() : granted;
};

/** Refuses `by` unless it names the same person as `reader`. */
const requireSame = <C>(brain: Brain<C>, reader: C, by: Writer): void => {
  if (brain.ports.ownerOf(reader) !== by.userId) {
    throw knowledgeErrors.create("knowledge.forbidden");
  }
};

/**
 * Suite `suiteId`'s version `version`, for `reader`: one who holds any
 * capability on it, or its owner. `knowledge.not_found` otherwise. Never
 * its cases.
 */
export const suiteVersion = async <C>(
  brain: Brain<C>,
  reader: C,
  suiteId: string,
  version: number
): Promise<EvalSuiteVersion> => {
  const held = await capabilitiesOf(brain, reader, suiteId);
  const found = await versionOf(brain, suiteId, version);
  if (held.size === 0 && found.ownerId !== brain.ports.ownerOf(reader)) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return found;
};

/** Refuses, as missing, `reader` without `capability` on suite `suiteId`. */
const requireCapability = async <C>(
  brain: Brain<C>,
  reader: C,
  suiteId: string,
  capability: EvalCapability
): Promise<void> => {
  const held = await capabilitiesOf(brain, reader, suiteId);
  if (!held.has(capability)) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
};

/**
 * Proposes the next version of suite `input.suiteId`, as `by`, its
 * designer: recorded `proposed`, with its digests, and audited. A version
 * is never changed after: a correction is another one.
 */
export const proposeSuiteVersion = async <C>(
  brain: Brain<C>,
  reader: C,
  by: Writer,
  input: unknown
): Promise<EvalSuiteVersion> => {
  const proposal = knowledgeErrors.parse(
    "knowledge.invalid",
    proposalSchema,
    input
  );
  requireSame(brain, reader, by);
  await requireCapability(brain, reader, proposal.suiteId, "designer");
  // The gates the platform mandates are every suite's too.
  const mandated = brain.ports.evaluation?.mandatedGates ?? [];
  if (
    mandated.some((gate) => !proposal.decision.securityGates.includes(gate))
  ) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: [
        "decision.securityGates: a gate the platform mandates is missing",
      ],
    });
  }
  requireApart(proposal.cases);
  // Its owner is never its designer, and stays the suite's owner from
  // version to version, unless they hand it on (`changeSuiteOwner`).
  if (proposal.ownerId === by.userId) {
    throw knowledgeErrors.create("knowledge.forbidden");
  }
  const { db } = brain;
  const [latest] = await db
    .select({
      version: brainEvalSuiteVersions.version,
      ownerId: brainEvalSuiteVersions.ownerId,
      nextOwnerId: brainEvalSuiteVersions.nextOwnerId,
    })
    .from(brainEvalSuiteVersions)
    .where(eq(brainEvalSuiteVersions.suiteId, proposal.suiteId))
    .orderBy(desc(brainEvalSuiteVersions.version))
    .limit(1);
  if (
    latest !== undefined &&
    (latest.nextOwnerId ?? latest.ownerId) !== proposal.ownerId
  ) {
    throw knowledgeErrors.create("knowledge.forbidden");
  }
  const version = (latest?.version ?? 0) + 1;
  const ordered = proposal.cases.toSorted((a, b) =>
    a.caseId.localeCompare(b.caseId)
  );
  const digestOfSplit = async (split: EvalSplit) =>
    await casesDigestOf(
      brain,
      ordered.filter((each) => each.split === split)
    );
  const now = brain.ports.clock();
  const grader = {
    version: proposal.grader.version,
    requiredChecks: proposal.grader.requiredChecks,
    spec: proposal.grader.spec,
  };
  try {
    await auditedBatch(brain.ports, db, [
      db.insert(brainEvalSuiteVersions).values({
        suiteId: proposal.suiteId,
        version,
        revision: 1,
        ownerId: proposal.ownerId,
        name: proposal.name,
        developmentDigest: await digestOfSplit("development"),
        validationDigest: await digestOfSplit("validation"),
        finalDigest: await digestOfSplit("final"),
        grader: canonicalJson(grader),
        // Keyed too: a grader's spec may hold expected patterns or
        // thresholds a guess could be checked against.
        graderDigest: await casesDigestOf(brain, grader),
        pins: canonicalJson(proposal.pins),
        decision: canonicalJson(proposal.decision),
        proposedBy: by.userId,
        createdAt: now,
        updatedAt: now,
      }),
      ...inChunks(
        ordered.map((each) => ({
          suiteId: proposal.suiteId,
          version,
          caseId: each.caseId,
          split: each.split,
          family: each.family,
          group: each.group,
          source: each.source,
          input: canonicalJson(each.input),
          expected: canonicalJson(each.expected),
        }))
      ).map((chunk) => db.insert(brainEvalCases).values(chunk)),
      outboxed(brain, {
        actor: by.actor,
        action: "knowledge.eval_suite.proposed",
        target: { type: "eval_suite", id: proposal.suiteId },
        detail: { version, cases: ordered.length },
      }),
    ]);
  } catch (error) {
    // Another version proposed at the same time took this number.
    if (String(error).includes("UNIQUE")) {
      throw knowledgeErrors.create("knowledge.conflict");
    }
    throw error;
  }
  return await versionOf(brain, proposal.suiteId, version);
};

/**
 * Which states a version may move to here, from which. A version is
 * calibrated only by a calibration that passed (eval-calibration.ts).
 */
const moves = {
  accepted: ["calibrated"],
  retired: ["proposed", "calibrated", "accepted"],
} as const;

/**
 * Moves suite version `version` to `to`, as `by`, if it stands at
 * `expectedRevision` in a state it may move from: `knowledge.conflict`
 * otherwise. Only its owner accepts it, never its designer on their
 * behalf; an accepted version is never changed, only retired.
 */
export const moveSuiteVersion = async <C>(
  brain: Brain<C>,
  reader: C,
  by: Writer,
  suiteId: string,
  version: number,
  to: keyof typeof moves,
  expectedRevision: number
): Promise<EvalSuiteVersion> => {
  requireSame(brain, reader, by);
  // Acceptance the owner's alone, never its proposer's; retirement the
  // owner's or the evaluator's: anyone else finds nothing.
  const current = await versionOf(brain, suiteId, version);
  const held = await capabilitiesOf(brain, reader, suiteId);
  // Never one who optimizes against it, though they own it.
  const owns =
    current.ownerId === by.userId &&
    current.proposedBy !== by.userId &&
    !held.has("optimizer");
  const evaluates = to === "retired" && held.has("evaluator");
  if (!owns && !evaluates) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  const from: readonly string[] = moves[to];
  if (current.revision !== expectedRevision || !from.includes(current.state)) {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  const { db } = brain;
  const now = brain.ports.clock();
  const [moved] = await auditedBatch(brain.ports, db, [
    db
      .update(brainEvalSuiteVersions)
      .set({
        state: to,
        revision: expectedRevision + 1,
        updatedAt: now,
        ...(to === "accepted"
          ? { acceptedBy: by.userId, acceptedAt: now }
          : {}),
      })
      .where(
        and(
          eq(brainEvalSuiteVersions.suiteId, suiteId),
          eq(brainEvalSuiteVersions.version, version),
          eq(brainEvalSuiteVersions.revision, expectedRevision)
        )
      )
      .returning({ version: brainEvalSuiteVersions.version }),
    outboxedIfChanged(brain, {
      actor: by.actor,
      action: `knowledge.eval_suite.${to}`,
      target: { type: "eval_suite", id: suiteId },
      detail: { version, revision: expectedRevision + 1 },
    }),
  ]);
  if (moved.length === 0) {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  return await versionOf(brain, suiteId, version);
};

/**
 * Hands suite `suiteId` on to `ownerId`, as `by`, its owner now: the
 * versions proposed after its latest one, at `expectedRevision`, are
 * theirs. A version's own owner never changes. Never to the designer who
 * proposed it. Until the next version is proposed, the hand-on is still
 * the current owner's: they may redirect it, and the incoming owner can't
 * act on it yet. That fails toward the owner who stands behind the suite.
 */
export const changeSuiteOwner = async <C>(
  brain: Brain<C>,
  reader: C,
  by: Writer,
  suiteId: string,
  ownerId: string,
  expectedRevision: number
): Promise<EvalSuiteVersion> => {
  requireSame(brain, reader, by);
  const { db } = brain;
  const [latest] = await db
    .select()
    .from(brainEvalSuiteVersions)
    .where(eq(brainEvalSuiteVersions.suiteId, suiteId))
    .orderBy(desc(brainEvalSuiteVersions.version))
    .limit(1);
  if (latest === undefined) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  if (latest.ownerId !== by.userId || latest.proposedBy === ownerId) {
    throw knowledgeErrors.create("knowledge.forbidden");
  }
  if (latest.revision !== expectedRevision) {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  const now = brain.ports.clock();
  const [moved] = await auditedBatch(brain.ports, db, [
    db
      .update(brainEvalSuiteVersions)
      // From the next version on: a version's own owner never changes.
      .set({
        nextOwnerId: ownerId,
        revision: expectedRevision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(brainEvalSuiteVersions.suiteId, suiteId),
          eq(brainEvalSuiteVersions.version, latest.version),
          eq(brainEvalSuiteVersions.revision, expectedRevision)
        )
      )
      .returning({ version: brainEvalSuiteVersions.version }),
    outboxedIfChanged(brain, {
      actor: by.actor,
      action: "knowledge.eval_suite.owner_changed",
      target: { type: "eval_suite", id: suiteId },
      detail: { version: latest.version, ownerId },
    }),
  ]);
  if (moved.length === 0) {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  return await versionOf(brain, suiteId, latest.version);
};

/** One case, as a reader allowed its split reads it. */
export interface EvalCase {
  caseId: string;
  split: EvalSplit;
  family: string;
  group: string;
  input: Json;
  expected: Json;
}

/**
 * The cases of `split` of suite version `version`, for `reader`, as its
 * capabilities allow: a designer and an evaluator read every split; an
 * optimizer the development cases of an accepted version alone;
 * publication none. `knowledge.not_found` otherwise.
 */
export const suiteCases = async <C>(
  brain: Brain<C>,
  reader: C,
  suiteId: string,
  version: number,
  split: EvalSplit
): Promise<EvalCase[]> => {
  const held = await capabilitiesOf(brain, reader, suiteId);
  const current = await versionOf(brain, suiteId, version);
  const allowed = {
    development:
      held.has("designer") ||
      held.has("evaluator") ||
      (held.has("optimizer") && current.state === "accepted"),
    validation: held.has("designer") || held.has("evaluator"),
    // The sealed set: the evaluator's alone.
    final: held.has("evaluator"),
  }[split];
  if (!allowed) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  // A held-out read is audited.
  if (split !== "development") {
    await auditedBatch(brain.ports, brain.db, [
      outboxed(brain, {
        actor: brain.ports.actorOf(reader),
        action: "knowledge.eval_suite.cases_read",
        target: { type: "eval_suite", id: suiteId },
        detail: { version, split },
      }),
    ]);
  }
  const rows = await brain.db
    .select()
    .from(brainEvalCases)
    .where(
      and(
        eq(brainEvalCases.suiteId, suiteId),
        eq(brainEvalCases.version, version),
        eq(brainEvalCases.split, split)
      )
    )
    .orderBy(brainEvalCases.caseId);
  return rows.map((row) => ({
    caseId: row.caseId,
    split: row.split,
    family: row.family,
    group: row.group,
    input: z.json().parse(JSON.parse(row.input)),
    expected: z.json().parse(JSON.parse(row.expected)),
  }));
};

/**
 * The verdict of version `version`'s decision policy on `comparison`, for
 * the families its cases hold, never fewer (eval-decision.ts `decide`):
 * for the evaluator or publication, on an accepted version alone.
 */
export const decideVersion = async <C>(
  brain: Brain<C>,
  reader: C,
  suiteId: string,
  version: number,
  comparison: unknown
): Promise<Verdict> => {
  // The evaluator's or publication's, and only on an accepted version.
  const held = await capabilitiesOf(brain, reader, suiteId);
  if (!held.has("evaluator") && !held.has("publication")) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  const current = await versionOf(brain, suiteId, version);
  if (current.state !== "accepted") {
    throw knowledgeErrors.create("knowledge.conflict");
  }
  const rows = await brain.db
    .selectDistinct({ family: brainEvalCases.family })
    .from(brainEvalCases)
    .where(
      and(
        eq(brainEvalCases.suiteId, suiteId),
        eq(brainEvalCases.version, version)
      )
    );
  return decide(
    current.decision,
    comparison,
    rows.map(({ family }) => family)
  );
};

/** Refuses, as missing, `reader` unless the evaluator of suite `suiteId`, and `by` them. */
export const requireEvaluator = async <C>(
  brain: Brain<C>,
  reader: C,
  by: Writer,
  suiteId: string
): Promise<void> => {
  requireSame(brain, reader, by);
  await requireCapability(brain, reader, suiteId, "evaluator");
};
