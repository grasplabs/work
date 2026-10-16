/**
 * The Brain baseline at scale (GRA-678): the frozen company of
 * brain-corpus.ts, grown to a scale size with the seeded distractors of
 * brain-distractors.ts, then measured as brain-harness.ts measures the
 * frozen one, with the same arms, tasks, gate and stubbed model provider.
 *
 * The distractors are loaded the way the corpus is: through the admin's
 * own Knowledge API, one document per save, so loading them is the index
 * build and its time is the build time. Each person reads only a few of
 * the 24 team collections they add, and each agent is granted them all:
 * restrictive permission sets, which every search and listing filters.
 * Odd repeats start each question in a just-evicted object, as the
 * baseline's do: cold caches.
 *
 * Per arm the report gives evidence recall, completion, p50, p95 and p99
 * latency, and the share of trials whose full context was truncated; for
 * the run, the index build time, each window's incremental update time,
 * the chunks indexed and Knowledge's stored size. Its identity is the
 * baseline's, with the distractors' version, seed, size and digest next to
 * the suite's.
 *
 * Latency here is workerd's on one machine: indicative, never a budget on
 * its own. See the GRA-678 comment in Linear for the results and for where
 * each size runs.
 */
import { sha256Hex } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";

import { runBrainBaseline } from "./brain-harness.ts";
import type {
  BrainArm,
  BrainCompany,
  BrainProvider,
  BrainReport,
  BrainRunOptions,
  KnowledgeStateCheck,
  RunIdentity,
} from "./brain-harness.ts";
import { percentile } from "./brain-scoring.ts";
import type { TrialScore } from "./brain-scoring.ts";
import {
  brainStubModel,
  modelStrings,
  stubReader,
} from "./brain-stub-model.ts";
import { brainPersonas } from "./fixtures/brain-corpus.ts";
import type { BrainPersona } from "./fixtures/brain-corpus.ts";
import type { DistractorCollection } from "./fixtures/brain-distractors.ts";
import {
  brainDistractorVersion,
  distractorCanary,
  distractorCollections,
  distractorDocuments,
  distractorReaders,
  distractorTeams,
} from "./fixtures/brain-distractors.ts";
import { newTeam } from "./knowledge.ts";
import { openRpc } from "./sign-in.ts";

/** Documents saved at once while loading: Knowledge orders their writes. */
const loadConcurrency = 8;

/** What pins a generated corpus: its generator, seed, size and output. */
export interface DistractorIdentity {
  version: string;
  seed: number;
  /** Distractor chunks generated, the frozen corpus's not counted. */
  chunks: number;
  /** SHA-256 chained over every generated document's path and text. */
  digest: string;
}

/** The distractors loaded into a company, and what loading them took. */
export interface LoadedDistractors {
  identity: DistractorIdentity;
  documents: number;
  /** Saving every document through Knowledge's API: the index build. */
  buildMs: number;
}

/**
 * Chains `digest` over one more document: the same documents in the same
 * order give the same digest, and any change to one changes it.
 */
const chained = async (
  digest: string,
  { path, text }: { path: string; text: string }
): Promise<string> => await sha256Hex(`${digest}\n${path}\n${text}`);

/** The SHA-256 chain of the distractors for `seed` and `chunks`, unloaded. */
export const distractorDigest = async (options: {
  seed: number;
  chunks: number;
}): Promise<string> => {
  let digest = "";
  for (const document of distractorDocuments(options)) {
    // oxlint-disable-next-line no-await-in-loop -- a chain, in order
    digest = await chained(digest, document);
  }
  return digest;
};

/**
 * Loads the distractors for `seed` and `chunks` into `company`: the 24
 * team collections and their teams, then every document, saved as the
 * admin. Grants nothing yet: `company.granted` names the team collections,
 * which each persona's agent is granted when the run sets it up.
 */
export const loadDistractors = async (
  company: BrainCompany,
  { seed, chunks }: { seed: number; chunks: number }
): Promise<LoadedDistractors> => {
  const { admin, people } = company;
  for (const team of distractorTeams) {
    // oxlint-disable-next-line no-await-in-loop -- one team at a time
    const teamId = await newTeam(
      admin,
      team.members.map((persona) => ({ userId: people[persona].userId }))
    );
    // oxlint-disable-next-line no-await-in-loop -- one collection at a time
    const created = await admin.api.knowledge.createCollection({
      name: team.name,
      description: team.description,
      access: "teams",
      teams: [teamId],
    });
    company.collections.set(team.key, created.id);
  }
  company.granted = distractorTeams.map(({ key }) => key);
  // An open connection reads who its person is only every few seconds
  // (`sessionRecheckMs`): a new one each, so the teams they just joined
  // reach the retrieval arms from the first trial on.
  for (const persona of brainPersonas) {
    const person = people[persona];
    // oxlint-disable-next-line no-await-in-loop -- one person at a time
    const { core, closed } = await openRpc(person.session);
    people[persona] = { ...person, core, closed, api: core.authenticate() };
    person.core[Symbol.dispose]();
  }
  const collectionOf = (key: string): string => {
    const id = company.collections.get(key);
    if (id === undefined) {
      throw new Error(`No collection ${key} to load distractors into`);
    }
    return id;
  };
  let digest = "";
  let documents = 0;
  const started = performance.now();
  let batch: Promise<unknown>[] = [];
  for (const document of distractorDocuments({ seed, chunks })) {
    // oxlint-disable-next-line no-await-in-loop -- a chain, in order
    digest = await chained(digest, document);
    documents += 1;
    batch.push(
      admin.api.knowledge.saveDocument({
        collectionId: collectionOf(document.collection),
        path: document.path,
        text: document.text,
        ifVersion: 0,
      })
    );
    if (batch.length === loadConcurrency) {
      // oxlint-disable-next-line no-await-in-loop -- a few saves at a time
      await Promise.all(batch);
      batch = [];
    }
  }
  await Promise.all(batch);
  return {
    identity: { version: brainDistractorVersion, seed, chunks, digest },
    documents,
    buildMs: performance.now() - started,
  };
};

/** Knowledge's database as stored: its bytes, and the chunks it indexes. */
export const storedKnowledge = async (): Promise<{
  bytes: number;
  chunks: number;
}> => {
  const { meta } = await env.KNOWLEDGE.prepare("SELECT 1").run();
  const indexed = await env.KNOWLEDGE.prepare(
    "SELECT count(*) AS chunks FROM search_rows"
  ).first<{ chunks: number }>();
  return { bytes: meta.size_after, chunks: indexed?.chunks ?? 0 };
};

/**
 * The distractor collections whose canary `input` holds although
 * `persona` may not read them: what a broken permission at scale would
 * hand a model.
 */
export const distractorLeaksIn = (
  input: string,
  persona: BrainPersona
): string[] =>
  distractorCollections.filter(
    (collection) =>
      !distractorReaders(collection).includes(persona) &&
      input.includes(distractorCanary(collection))
  );

/** A distractor a trial's model was sent although its person may not read it. */
export interface DistractorLeak {
  taskId: string;
  collection: string;
}

/** What the models of a run were sent of the distractors. */
interface DistractorsSeen {
  leaks: DistractorLeak[];
  /** The distractor collections that reached each person's model. */
  reached: Record<BrainPersona, Set<DistractorCollection>>;
}

/**
 * The stub provider, checking every request of a question for a canary of
 * a distractor collection its person may not read. It answers as the stub
 * does: the run's provider is still the stub.
 */
const watchingStub =
  (seen: DistractorsSeen): BrainProvider =>
  (turn) => {
    const answer = stubReader(turn);
    return (requests) => {
      const current = turn();
      if (current.phase === "question") {
        const { id, persona } = current.task;
        const input = modelStrings(requests.at(-1)?.body).join("\n");
        for (const collection of distractorLeaksIn(input, persona)) {
          seen.leaks.push({ taskId: id, collection });
        }
        for (const collection of distractorCollections) {
          if (input.includes(distractorCanary(collection))) {
            seen.reached[persona].add(collection);
          }
        }
      }
      return answer(requests);
    };
  };

/** One arm at one size: what the issue asks to record. */
export interface ScaleArm {
  arm: BrainArm;
  trials: number;
  evidenceRecall: number | null;
  completionRate: number;
  latencyMs: {
    p50: number | null;
    p95: number | null;
    p99: number | null;
    coldP95: number | null;
    warmP95: number | null;
  };
  /** Of the arm's trials, the share whose sources left some out. */
  truncatedShare: number;
}

export interface BrainScaleReport {
  /** The baseline's identity, and the distractors' next to its suite. */
  identity: RunIdentity & {
    distractors: DistractorIdentity;
    knowledgeState: KnowledgeStateCheck;
  };
  arms: ScaleArm[];
  build: {
    /** Loading the frozen corpus, then the distractors. */
    corpusMs: number;
    distractorsMs: number;
    documents: number;
  };
  /** Each window's frozen updates, applied to the grown index. */
  updates: { window: string; ms: number }[];
  stored: { bytes: number; chunks: number };
  gate: BrainReport["gate"];
  /** Distractors whose person may not read them that reached a model. */
  distractorLeaks: DistractorLeak[];
  /** The distractor collections that reached each person's model, sorted. */
  distractorsReached: Record<BrainPersona, DistractorCollection[]>;
  /** The baseline's own report, for anything else it measured. */
  baseline: BrainReport;
}

const latenciesOf = (scores: readonly TrialScore[]) =>
  scores.map(({ latencyMs }) => latencyMs);

const scaleArm = (report: BrainReport, arm: BrainArm): ScaleArm => {
  const scores = report.scores.filter((score) => score.arm === arm);
  const summary = report.arms.find((each) => each.arm === arm);
  const all = latenciesOf(scores);
  return {
    arm,
    trials: scores.length,
    evidenceRecall: summary?.evidenceRecall ?? null,
    completionRate: summary?.completionRate ?? 0,
    latencyMs: {
      p50: percentile(all, 50),
      p95: percentile(all, 95),
      p99: percentile(all, 99),
      coldP95: summary?.latencyMs.coldP95 ?? null,
      warmP95: summary?.latencyMs.warmP95 ?? null,
    },
    truncatedShare:
      scores.length === 0
        ? 0
        : scores.filter(({ truncated }) => truncated === true).length /
          scores.length,
  };
};

export interface BrainScaleOptions extends Omit<
  BrainRunOptions,
  "knowledgeState" | "respond" | "providerName"
> {
  /** Distractor chunks: one of `brainScaleSizes`, or any other size. */
  chunks: number;
  distractorSeed: number;
  /**
   * How the gate reads Knowledge: every row by default, row counts for a
   * corpus too large to read twice a trial.
   */
  knowledgeState?: KnowledgeStateCheck;
}

/**
 * Grows a company loaded at `t0` by `chunks` distractors and runs the
 * baseline on it.
 */
export const runBrainScale = async (
  company: BrainCompany,
  {
    chunks,
    distractorSeed,
    knowledgeState = "rows",
    ...options
  }: BrainScaleOptions
): Promise<BrainScaleReport> => {
  const loaded = await loadDistractors(company, {
    seed: distractorSeed,
    chunks,
  });
  const stored = await storedKnowledge();
  const seen: DistractorsSeen = {
    leaks: [],
    reached: { ana: new Set(), bram: new Set() },
  };
  const baseline = await runBrainBaseline(company, {
    ...options,
    knowledgeState,
    respond: watchingStub(seen),
    providerName: brainStubModel,
  });
  const arms = baseline.identity.schedule.arms.map((arm) =>
    scaleArm(baseline, arm)
  );
  return {
    identity: {
      ...baseline.identity,
      distractors: loaded.identity,
      knowledgeState,
    },
    arms,
    build: {
      corpusMs: company.build.ms,
      distractorsMs: loaded.buildMs,
      documents: loaded.documents,
    },
    updates: baseline.costs.updates.map(({ window, ms }) => ({ window, ms })),
    stored,
    gate: baseline.gate,
    distractorLeaks: seen.leaks,
    distractorsReached: {
      ana: [...seen.reached.ana].toSorted(),
      bram: [...seen.reached.bram].toSorted(),
    },
    baseline,
  };
};
