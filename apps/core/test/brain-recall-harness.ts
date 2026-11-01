/**
 * Experiment E02's harness (GRA-304): asks each case of
 * brain-recall-cases.ts of the E01 company (brain-harness.ts) as the
 * case's person, through their own API, under three policies:
 *
 * - `fullText`: Knowledge's full-text search, its best sections read, as
 *   E01's `fullText` arm reads them;
 * - `hybrid`: recall as it serves by default (`hybrid@1`: its exact,
 *   full-text and, where a store has one, semantic lanes, fused);
 * - `hybridRerank`: the same recall, asking the deployment's model to
 *   order it (`hybrid@1+rerank@1`).
 *
 * Each policy is asked with each of a case's two inputs, its keywords and
 * its question: an arm is a policy and an input (`hybrid:keywords`), and a
 * policy is only ever compared with full-text search given the same input.
 *
 * Each case is asked cold, then warm (the same reader asking again, as a
 * turn or a run does), over repeats paired by case, the arms' order
 * shuffled with a seed. Between repeats a write the cases' people can't
 * see moves the recall generation, so a repeat is cold again. Each recall
 * records its ranked texts, latency and charged cost; brain-recall-scoring
 * turns them into the report. Cases of the `t1` window are asked as soon
 * as its updates are saved, and again until each arm finds them: how long
 * that takes is the arm's update lag.
 *
 * Only the model provider behind connect is swapped in CI, by the caller:
 * whatever answers the provider the organization connected
 * (model-provider.ts) ranks for the rerank arm.
 */
import type { MemoryPack } from "@grasp-os/brain/contract";
import { recallDefaults } from "@grasp-os/brain/contract";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { env } from "cloudflare:workers";
import { z } from "zod";

import {
  applyWindow,
  brainBudgetDay,
  brainBudgetMonth,
  charged,
  minimumMeaningfulGain,
} from "./brain-harness.ts";
import type { BrainCompany } from "./brain-harness.ts";
import {
  compareRecallArms,
  recallAdoption,
  recallBudgets,
  scoreRecall,
  summarizeRecallArm,
  lagSummary,
} from "./brain-recall-scoring.ts";
import type {
  RecallAdoption,
  RecallArmSummary,
  RecallComparison,
  RecallObservation,
  RecallScore,
  UpdateLag,
} from "./brain-recall-scoring.ts";
import { seededRandom } from "./brain-scoring.ts";
import { brainDocuments, brainUpdates } from "./fixtures/brain-corpus.ts";
import {
  brainRecallCases,
  brainRecallCasesVersion,
} from "./fixtures/brain-recall-cases.ts";
import type { BrainRecallCase } from "./fixtures/brain-recall-cases.ts";

/** Bumped with any change to how the harness runs or measures a recall. */
export const brainRecallHarnessVersion = "1";

export const brainRecallPolicies = [
  "fullText",
  "hybrid",
  "hybridRerank",
] as const;
export type BrainRecallPolicy = (typeof brainRecallPolicies)[number];

/** The policy every other is compared with: what Knowledge served before. */
export const brainRecallBaseline: BrainRecallPolicy = "fullText";

/** What a case is asked with: see brain-recall-cases.ts. */
export const brainRecallInputs = ["keywords", "question"] as const;
export type BrainRecallInput = (typeof brainRecallInputs)[number];

export type BrainRecallArm = `${BrainRecallPolicy}:${BrainRecallInput}`;

export const brainRecallArms: readonly BrainRecallArm[] =
  brainRecallPolicies.flatMap((policy) =>
    brainRecallInputs.map((input): BrainRecallArm => `${policy}:${input}`)
  );

const policyOfArm = (arm: BrainRecallArm): BrainRecallPolicy => {
  const [policy] = arm.split(":");
  const known = brainRecallPolicies.find((each) => each === policy);
  if (known === undefined) {
    throw new Error(`No policy in arm ${arm}`);
  }
  return known;
};

const inputOfArm = (arm: BrainRecallArm): BrainRecallInput =>
  arm.endsWith(":question") ? "question" : "keywords";

/** How long an arm is asked for an update before it counts as never finding it. */
const lagLimitMs = 5000;

/** How often an arm is asked again while it hasn't found an update. */
const lagPollMs = 100;

type Person = BrainCompany["admin"];

/** What one arm answered: each result's text, and whether each cites `documentId`. */
interface Answered {
  texts: string[];
  cites: (index: number, documentId: string) => boolean;
  degraded: boolean;
}

/** Knowledge's full-text search, its best sections read as the person. */
const searchedFor = async (
  person: Person,
  query: string
): Promise<Answered> => {
  const { hits } = await person.api.knowledge.search(query, {
    limit: recallDefaults.maxItems,
  });
  const reads = await Promise.all(
    hits.map(async (hit) => {
      const read = await person.api.knowledge.read(hit.documentId, {
        section: hit.section,
      });
      return { documentId: hit.documentId, text: read.text };
    })
  );
  return {
    texts: reads.map(({ text }) => text),
    cites: (index, documentId) => reads[index]?.documentId === documentId,
    degraded: false,
  };
};

const citesDocument = (
  pack: MemoryPack,
  index: number,
  documentId: string
): boolean =>
  pack.items[index]?.sourceRefs.some(
    (ref) => ref.kind === "document" && ref.documentId === documentId
  ) ?? false;

/** A recall's pack as the arms compare it. */
const recalledFor = async (
  person: Person,
  question: string,
  rerank: boolean
): Promise<Answered> => {
  const pack = await person.api.knowledge.recall({
    query: question,
    ...(rerank ? { budget: { rerank: true } } : {}),
  });
  return {
    texts: pack.items.map(({ statement }) => statement),
    cites: (index, documentId) => citesDocument(pack, index, documentId),
    degraded: pack.coverage.state === "degraded",
  };
};

const askedOf = async (
  arm: BrainRecallArm,
  person: Person,
  recallCase: BrainRecallCase
): Promise<Answered> => {
  const asked = recallCase[inputOfArm(arm)];
  switch (policyOfArm(arm)) {
    case "fullText": {
      return await searchedFor(person, asked);
    }
    case "hybrid": {
      return await recalledFor(person, asked, false);
    }
    case "hybridRerank": {
      return await recalledFor(person, asked, true);
    }
    default: {
      throw new Error(`No arm ${arm}`);
    }
  }
};

/** The key of the document whose text, at the case's window, holds its marker. */
const documentKeyOf = (marker: string): string | undefined => {
  const updated = brainUpdates.find(
    (update) => update.type === "save" && update.text.includes(marker)
  );
  if (updated !== undefined) {
    return updated.document;
  }
  return Object.entries(brainDocuments).find(([, { text }]) =>
    text.includes(marker)
  )?.[0];
};

/** One recall of `recallCase` under `arm`, as its person, measured. */
const observe = async (
  company: BrainCompany,
  recallCase: BrainRecallCase,
  arm: BrainRecallArm,
  repeat: number,
  phase: RecallObservation["phase"]
): Promise<RecallObservation> => {
  const person = company.people[recallCase.persona];
  const spentBefore = await charged();
  const started = performance.now();
  const answered = await askedOf(arm, person, recallCase);
  const latencyMs = performance.now() - started;
  const { marker } = recallCase;
  const key = marker === undefined ? undefined : documentKeyOf(marker);
  const documentId =
    key === undefined ? undefined : company.documents.get(key)?.id;
  const index =
    marker === undefined
      ? -1
      : answered.texts.findIndex((text) => text.includes(marker));
  return {
    caseId: recallCase.id,
    arm,
    repeat,
    phase,
    texts: answered.texts,
    cited:
      index === -1 || documentId === undefined
        ? null
        : answered.cites(index, documentId),
    latencyMs,
    costMicros: (await charged()) - spentBefore,
    degraded: answered.degraded,
  };
};

/** A seeded shuffle, so arms take turns going first without luck deciding. */
const shuffled = <T>(items: readonly T[], random: () => number): T[] => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const here = result[index];
    const there = result[other];
    if (here !== undefined && there !== undefined) {
      result[index] = there;
      result[other] = here;
    }
  }
  return result;
};

/**
 * A write no case's person can read, in the admin's own collection: it
 * moves the recall generation, so nothing kept before it is used again.
 */
const forgetKeptRecalls = async (company: BrainCompany, repeat: number) => {
  const collectionId = company.collections.get("private");
  if (collectionId === undefined) {
    throw new Error("The company has no private collection");
  }
  await company.admin.api.knowledge.saveDocument({
    collectionId,
    path: `hr/e02-repeat-${repeat}-${crypto.randomUUID()}.md`,
    text: `# Repeat ${repeat}\n\nA note between the experiment's repeats.`,
    ifVersion: 0,
  });
};

/** Each arm's cold and warm recall of each case of `cases`, in a seeded order. */
const askAll = async (
  company: BrainCompany,
  cases: readonly BrainRecallCase[],
  arms: readonly BrainRecallArm[],
  repeat: number,
  random: () => number
): Promise<RecallObservation[]> => {
  const observations: RecallObservation[] = [];
  for (const recallCase of shuffled(cases, random)) {
    for (const arm of shuffled(arms, random)) {
      for (const phase of ["cold", "warm"] as const) {
        observations.push(
          // oxlint-disable-next-line no-await-in-loop -- one recall at a time, so each is timed and charged alone
          await observe(company, recallCase, arm, repeat, phase)
        );
      }
    }
  }
  return observations;
};

/** How long each arm took to find each of `cases`' markers, once `since` wrote them. */
const lagsOf = async (
  company: BrainCompany,
  cases: readonly BrainRecallCase[],
  arms: readonly BrainRecallArm[],
  since: number
): Promise<UpdateLag[]> => {
  const lags: UpdateLag[] = [];
  for (const recallCase of cases) {
    const { marker } = recallCase;
    if (marker !== undefined) {
      for (const arm of arms) {
        const first = performance.now();
        // Lag runs from the first ask's start, not from `first`: the clock
        // may tick between the two, and an arm the first ask finds lags 0.
        let firstAsk: number | undefined;
        let lagMs: number | null = null;
        while (lagMs === null && performance.now() - first < lagLimitMs) {
          const asking = performance.now();
          firstAsk ??= asking;
          // oxlint-disable-next-line no-await-in-loop -- asked until found
          const { texts } = await askedOf(
            arm,
            company.people[recallCase.persona],
            recallCase
          );
          if (texts.some((text) => text.includes(marker))) {
            lagMs = asking - firstAsk;
          } else {
            // oxlint-disable-next-line no-await-in-loop -- a pause before asking again
            await scheduler.wait(lagPollMs);
          }
        }
        lags.push({
          caseId: recallCase.id,
          arm,
          firstAskedAfterMs: first - since,
          lagMs,
        });
      }
    }
  }
  return lags;
};

export interface BrainRecallOptions {
  repeats: number;
  arms?: readonly BrainRecallArm[];
  cases?: readonly BrainRecallCase[];
  /** Whether the reranker behind connect is a real model, not a stub. */
  measured: boolean;
  seed?: number;
  /** What the run's numbers depend on, beyond the code: its model and profile. */
  identity: { model: string; profile: string; build?: unknown };
}

export interface BrainRecallReport {
  identity: {
    experiment: "E02";
    harnessVersion: string;
    casesVersion: string;
    casesDigest: string;
    policies: Record<string, string>;
    repeats: number;
    seed: number;
    /** Lanes recall read and those it left out, with why, as it reported. */
    lanes: { queried: string[]; omitted: string[] };
    model: string;
    profile: string;
    build?: unknown;
  };
  scores: RecallScore[];
  arms: RecallArmSummary[];
  lags: UpdateLag[];
  lagByArm: Partial<Record<BrainRecallArm, ReturnType<typeof lagSummary>>>;
  comparisons: RecallComparison[];
  adoptions: RecallAdoption[];
  budgets: typeof recallBudgets;
}

/** The lanes and policies a recall reports, as one person's first recall saw them. */
const policyOf = async (company: BrainCompany) => {
  const pack = await company.people.ana.api.knowledge.recall({
    query: "fleet",
  });
  return {
    policy: pack.retrievalPolicyVersion,
    queried: pack.coverage.queriedRoutes,
    omitted: pack.coverage.omittedRoutes.map(
      ({ route, reason }) => `${route}:${reason}`
    ),
  };
};

/**
 * Runs E02 on `company`, loaded at `t0`: the `t0` cases over every repeat,
 * then the `t1` window's updates, their lag, and the `t1` cases. Model
 * calls count in the E01 run's month, as its `charged` reads them.
 */
export const runBrainRecallComparison = async (
  company: BrainCompany,
  {
    repeats,
    arms = brainRecallArms,
    cases = brainRecallCases,
    measured,
    seed = 304,
    identity,
  }: BrainRecallOptions
): Promise<BrainRecallReport> => {
  const before = {
    month: env.MODEL_BUDGET_MONTH,
    day: env.MODEL_BUDGET_DAY,
  };
  env.MODEL_BUDGET_MONTH = brainBudgetMonth;
  env.MODEL_BUDGET_DAY = brainBudgetDay;
  try {
    const random = seededRandom(seed);
    const { policy, queried, omitted } = await policyOf(company);
    const early = cases.filter(({ window }) => window === "t0");
    const late = cases.filter(({ window }) => window === "t1");
    const observations: RecallObservation[] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      if (repeat > 0) {
        // oxlint-disable-next-line no-await-in-loop -- each repeat starts cold
        await forgetKeptRecalls(company, repeat);
      }
      observations.push(
        // oxlint-disable-next-line no-await-in-loop -- one repeat at a time
        ...(await askAll(company, early, arms, repeat, random))
      );
    }
    await applyWindow(company, "t1");
    const lags = await lagsOf(company, late, arms, performance.now());
    observations.push(...(await askAll(company, late, arms, 0, random)));

    const byId = new Map(cases.map((each) => [each.id, each]));
    const scores = observations.flatMap((observation) => {
      const recallCase = byId.get(observation.caseId);
      return recallCase === undefined
        ? []
        : [scoreRecall(recallCase, observation)];
    });
    const scoresOf = (arm: string) => scores.filter((each) => each.arm === arm);
    const summaries = arms.map((arm) => summarizeRecallArm(arm, scoresOf(arm)));
    const comparisons = arms.flatMap((arm) => {
      const baseline: BrainRecallArm = `${brainRecallBaseline}:${inputOfArm(arm)}`;
      return policyOfArm(arm) === brainRecallBaseline ||
        !arms.includes(baseline)
        ? []
        : [
            compareRecallArms(
              { arm, scores: scoresOf(arm) },
              { arm: baseline, scores: scoresOf(baseline) },
              minimumMeaningfulGain,
              seed
            ),
          ];
    });
    const adoptions = comparisons.flatMap((comparison) => {
      const summary = summaries.find(({ arm }) => arm === comparison.candidate);
      return summary === undefined
        ? []
        : [recallAdoption(summary, comparison, { measured })];
    });
    return {
      identity: {
        experiment: "E02",
        harnessVersion: brainRecallHarnessVersion,
        casesVersion: brainRecallCasesVersion,
        casesDigest: await sha256Hex(canonicalJson(z.json().parse(cases))),
        policies: {
          fullText: "knowledge.search",
          hybrid: policy,
          hybridRerank: `${policy}+rerank@1`,
        },
        repeats,
        seed,
        lanes: { queried, omitted },
        ...identity,
      },
      scores,
      arms: summaries,
      lags,
      lagByArm: Object.fromEntries(
        arms.map((arm) => [
          arm,
          lagSummary(lags.filter((lag) => lag.arm === arm)),
        ])
      ),
      comparisons,
      adoptions,
      budgets: recallBudgets,
    };
  } finally {
    env.MODEL_BUDGET_MONTH = before.month;
    env.MODEL_BUDGET_DAY = before.day;
  }
};
