import { attributeRuleOf, speakerSchema } from "@grasp-os/brain-next/contract";
import type { Speaker } from "@grasp-os/brain-next/contract";
import { z } from "zod";

// By relative path: matching must fold names and values, and key a memory
// filed under no attribute, exactly as the store does, and the package
// exports only its contract and store. Pure functions, read by the
// evaluation alone.
// oxlint-disable-next-line no-restricted-imports -- the Brain's own folding, see above
import { foldName } from "../../../../../packages/brain-next/src/entities.ts";
// oxlint-disable-next-line no-restricted-imports -- the Brain's own restatement key, see above
import { restatementOf } from "../../../../../packages/brain-next/src/remember.ts";
import { isVersionProbe, valuesOf } from "./set.ts";
import type {
  EvalDocument,
  EvalEntity,
  EvalFact,
  EvalProbe,
  ExtractionEvalSet,
} from "./set.ts";

// Scoring a run of the evaluation of extraction (GRA-1992) from what a
// reader of each unit's team read after it (brain-extraction-eval.ts).
// One matching rule throughout, with no thresholds:
//
// - Two entities are the same when they are of one kind and share a name,
//   folded as the store folds names (`foldName`).
// - Two memories say the same when they are about the same entity, under
//   the same attribute, with the same value folded (or the same related
//   entity); two memories filed under no attribute, when the store would
//   take one for a restatement of the other (`restatementOf`).
// - "Same entity and attribute, different value" is counted apart from
//   both: it is where a prompt or an attribute is loose, not a missing
//   fact.

/** An entity as a reader read it: its kind and the names they see. */
export interface ReadEntity {
  kind: string;
  names: readonly string[];
}

/** A memory as a reader of its unit's team read it after the unit. */
export interface ReadMemory {
  about: ReadEntity;
  attribute: string | null;
  value: string | null;
  object: ReadEntity | null;
  type: string;
  statement: string;
  speaker: Speaker;
  /** Not ended (`endedAt` null). */
  current: boolean;
  contested: boolean;
}

/**
 * What a draw of a document left: `clean` drawn as it is, `planted` with
 * the document's plants among what the checker was shown; `parked` when
 * its extraction failed and the queue parked it.
 */
export interface DrawResult {
  document: string;
  draw: "clean" | "planted";
  parked: boolean;
  memories: readonly ReadMemory[];
}

/** What a probe left, in its base's clean draw's team, after its second text. */
export interface ProbeResult {
  probe: string;
  parked: boolean;
  memories: readonly ReadMemory[];
}

/** A share: how many of how many. */
export interface Share {
  count: number;
  of: number;
}

export interface ExtractionScore {
  /** Two draws of each document compared (plants left out). */
  agreement: {
    documents: number;
    same: number;
    valueDiffers: number;
    onlyOne: number;
  };
  /** Planted statements the checker let through. */
  planted: Share;
  /**
   * The clean draws against the labels: precision of filed memories (a
   * memory saying a label or a fact also true is precise), recall of the
   * labels alone.
   */
  labelled: {
    precision: Share;
    recall: Share;
    valueDiffers: number;
    unfiled: number;
  };
  /** What the probes' second texts did to what the first had drawn. */
  probes: {
    /**
     * Facts the first text gave and the newer one says again, drawn after
     * the first and not current after the second: `replaced` when another
     * value now stands in their one-value slot (what a check of a new
     * memory against the one it ends could catch); `notDrawnAgain` when
     * nothing does (the newer version, fully extracted, ended every
     * memory of the first, and its read missed the fact: no such check
     * runs then).
     */
    replaced: Share;
    notDrawnAgain: Share;
    changeMissed: Share;
    wronglyContested: Share;
    contestMissed: Share;
    each: {
      probe: string;
      kind: EvalProbe["kind"];
      replaced: number;
      notDrawnAgain: number;
      changeMissed: number;
      wronglyContested: number;
      contestMissed: number;
    }[];
  };
  /** Units whose extraction parked, so they gave no result. */
  parked: number;
}

/** Whether the entity read is `wanted`: one kind, a shared name folded. */
const sameEntity = (
  read: ReadEntity,
  wanted: ReadEntity | EvalEntity
): boolean => {
  if (read.kind !== wanted.kind) {
    return false;
  }
  const names = new Set(read.names.map(foldName));
  const wantedNames = "name" in wanted ? [wanted.name] : wanted.names;
  return wantedNames.some((name) => names.has(foldName(name)));
};

/** Whether `memory` is about the entity and attribute of `fact`. */
const inSlotOf = (memory: ReadMemory, fact: EvalFact): boolean =>
  memory.attribute === fact.attribute && sameEntity(memory.about, fact.about);

/** Whether `fact`'s attribute holds one value: a newer one replaces it. */
const holdsOneValue = (fact: EvalFact): boolean =>
  attributeRuleOf(fact.about.kind, fact.attribute)?.values === "one";

/** Whether two facts of the set are of one entity and attribute. */
const sameSlotOf = (a: EvalFact, b: EvalFact): boolean =>
  a.attribute === b.attribute &&
  sameEntity({ kind: a.about.kind, names: [a.about.name] }, b.about);

/** Whether two facts of the set say the same: one slot, one value or related entity. */
const sameFactOf = (a: EvalFact, b: EvalFact): boolean => {
  if (!sameSlotOf(a, b)) {
    return false;
  }
  if (a.object !== undefined || b.object !== undefined) {
    return (
      a.object !== undefined &&
      b.object !== undefined &&
      sameEntity({ kind: a.object.kind, names: [a.object.name] }, b.object)
    );
  }
  const values = new Set(valuesOf(a).map(foldName));
  return valuesOf(b).some((value) => values.has(foldName(value)));
};

/** Whether `memory` says `fact`. */
export const says = (memory: ReadMemory, fact: EvalFact): boolean => {
  if (!inSlotOf(memory, fact)) {
    return false;
  }
  if (fact.object !== undefined) {
    return memory.object !== null && sameEntity(memory.object, fact.object);
  }
  const value = foldName(memory.value ?? "");
  return valuesOf(fact).some((wanted) => foldName(wanted) === value);
};

/** A memory with what decides whether two say the same. */
interface Keyed {
  memory: ReadMemory;
  restatement: string;
}

const keyed = async (memories: readonly ReadMemory[]): Promise<Keyed[]> =>
  await Promise.all(
    memories.map(async (memory) => ({
      memory,
      restatement: await restatementOf({
        type: memory.type,
        speaker: memory.speaker,
        value: memory.value,
        statement: memory.statement,
      }),
    }))
  );

/** Whether two memories are about one entity under one attribute (both filed). */
const sameSlot = (a: ReadMemory, b: ReadMemory): boolean =>
  a.attribute !== null &&
  a.attribute === b.attribute &&
  sameEntity(a.about, b.about);

/** Whether two memories say the same (above). */
const saySame = (a: Keyed, b: Keyed): boolean => {
  if (!sameEntity(a.memory.about, b.memory.about)) {
    return false;
  }
  if (a.memory.attribute === null || b.memory.attribute === null) {
    return (
      a.memory.attribute === b.memory.attribute &&
      a.restatement === b.restatement
    );
  }
  if (a.memory.attribute !== b.memory.attribute) {
    return false;
  }
  if (a.memory.object !== null || b.memory.object !== null) {
    return (
      a.memory.object !== null &&
      b.memory.object !== null &&
      sameEntity(a.memory.object, b.memory.object)
    );
  }
  return foldName(a.memory.value ?? "") === foldName(b.memory.value ?? "");
};

/**
 * Pairs `left` with `right`, each memory at most once: first those that
 * say the same, then those of one entity and attribute; what is left
 * stands alone.
 */
const paired = <L, R>(
  left: readonly L[],
  right: readonly R[],
  same: (l: L, r: R) => boolean,
  slot: (l: L, r: R) => boolean
): { same: number; valueDiffers: number; onlyLeft: L[]; onlyRight: R[] } => {
  let leftLeft = [...left];
  const rightLeft = [...right];
  const take = (match: (l: L, r: R) => boolean): number => {
    const unmatched: L[] = [];
    for (const l of leftLeft) {
      const at = rightLeft.findIndex((r) => match(l, r));
      if (at === -1) {
        unmatched.push(l);
      } else {
        rightLeft.splice(at, 1);
      }
    }
    const taken = leftLeft.length - unmatched.length;
    leftLeft = unmatched;
    return taken;
  };
  const sameCount = take(same);
  const valueDiffers = take(slot);
  return {
    same: sameCount,
    valueDiffers,
    onlyLeft: leftLeft,
    onlyRight: rightLeft,
  };
};

/** Whether `memory` is one of `document`'s plants, by its statement. */
const isPlant = (document: EvalDocument, memory: ReadMemory): boolean =>
  document.plants.some(
    ({ statement }) => statement.trim() === memory.statement.trim()
  );

const share = (count: number, of: number): Share => ({ count, of });

/** A match nothing passes: for a pairing by one rule alone. */
const never = (): boolean => false;

/** `results` scored against `set` (above). */
export const scoreExtraction = async (
  set: ExtractionEvalSet,
  {
    draws,
    probes,
  }: { draws: readonly DrawResult[]; probes: readonly ProbeResult[] }
): Promise<ExtractionScore> => {
  const drawOf = (document: string, draw: DrawResult["draw"]) =>
    draws.find(
      (result) => result.document === document && result.draw === draw
    );
  const agreement = { documents: 0, same: 0, valueDiffers: 0, onlyOne: 0 };
  const planted = share(0, 0);
  const labelled = {
    precision: share(0, 0),
    recall: share(0, 0),
    valueDiffers: 0,
    unfiled: 0,
  };
  let parked = draws.filter((draw) => draw.parked).length;
  for (const document of set.documents) {
    const clean = drawOf(document.id, "clean");
    const withPlants = drawOf(document.id, "planted");
    if (withPlants !== undefined && !withPlants.parked) {
      planted.of += document.plants.length;
      planted.count += document.plants.filter(({ statement }) =>
        withPlants.memories.some(
          (memory) => memory.statement.trim() === statement.trim()
        )
      ).length;
    }
    if (clean === undefined || clean.parked) {
      continue;
    }
    if (withPlants !== undefined && !withPlants.parked) {
      // oxlint-disable-next-line no-await-in-loop -- a document at a time
      const first = await keyed(clean.memories);
      // oxlint-disable-next-line no-await-in-loop -- a document at a time
      const second = await keyed(
        withPlants.memories.filter((memory) => !isPlant(document, memory))
      );
      const pairs = paired(first, second, saySame, (a, b) =>
        sameSlot(a.memory, b.memory)
      );
      agreement.documents += 1;
      agreement.same += pairs.same;
      agreement.valueDiffers += pairs.valueDiffers;
      agreement.onlyOne += pairs.onlyLeft.length + pairs.onlyRight.length;
    }
    const filed = clean.memories.filter(({ attribute }) => attribute !== null);
    // The labels first, then what a careful reader may draw too; what is
    // left, against the labels left, by entity and attribute alone.
    const labels = paired(filed, document.facts, says, never);
    const alsoTrue = paired(labels.onlyLeft, document.alsoTrue, says, never);
    const differing = paired(
      alsoTrue.onlyLeft,
      labels.onlyRight,
      never,
      inSlotOf
    );
    labelled.precision.count += labels.same + alsoTrue.same;
    labelled.precision.of += filed.length;
    labelled.recall.count += labels.same;
    labelled.recall.of += document.facts.length;
    labelled.valueDiffers += differing.valueDiffers;
    labelled.unfiled += clean.memories.length - filed.length;
  }
  const each: ExtractionScore["probes"]["each"] = [];
  const scored = {
    replaced: share(0, 0),
    notDrawnAgain: share(0, 0),
    changeMissed: share(0, 0),
    wronglyContested: share(0, 0),
    contestMissed: share(0, 0),
    each,
  };
  for (const probe of set.probes) {
    const base = set.documents.find(({ id }) => id === probe.base);
    const before = drawOf(probe.base, "clean");
    const after = probes.find((result) => result.probe === probe.id);
    if (after?.parked === true) {
      parked += 1;
    }
    if (
      base === undefined ||
      before === undefined ||
      before.parked ||
      after === undefined ||
      after.parked
    ) {
      continue;
    }
    const held = before.memories.filter(({ current }) => current);
    const now = after.memories.filter(({ current }) => current);
    const drawnBefore = (fact: EvalFact) =>
      held.some((memory) => says(memory, fact));
    const standsNow = (fact: EvalFact) =>
      now.some((memory) => says(memory, fact));
    // What should stand after: the newer version's facts, or both sources'.
    const expected = isVersionProbe(probe)
      ? probe.second.facts
      : [...base.facts, ...probe.second.facts];
    const keptFacts = expected.filter(drawnBefore);
    const lost = keptFacts.filter((fact) => !standsNow(fact));
    const replaced = lost.filter(
      (fact) =>
        holdsOneValue(fact) && now.some((memory) => inSlotOf(memory, fact))
    ).length;
    const notDrawnAgain = lost.length - replaced;
    // A fact of the first version the newer one says otherwise: of its
    // entity and one-value attribute, with no value of it. (A many-value
    // attribute gains and loses values beside each other: nothing of it
    // is replaced.)
    const changed = isVersionProbe(probe)
      ? base.facts.filter(
          (fact) =>
            holdsOneValue(fact) &&
            drawnBefore(fact) &&
            probe.second.facts.some((newer) => sameSlotOf(newer, fact)) &&
            !probe.second.facts.some((newer) => sameFactOf(newer, fact))
        )
      : [];
    const changeMissed = changed.filter(standsNow).length;
    const contested = now.filter(
      (memory) =>
        memory.contested && !probe.contested.some((fact) => says(memory, fact))
    );
    const contestMissed = probe.contested.filter(
      (fact) => !now.some((memory) => memory.contested && says(memory, fact))
    ).length;
    scored.replaced.count += replaced;
    scored.replaced.of += keptFacts.length;
    scored.notDrawnAgain.count += notDrawnAgain;
    scored.notDrawnAgain.of += keptFacts.length;
    scored.changeMissed.count += changeMissed;
    scored.changeMissed.of += changed.length;
    scored.wronglyContested.count += contested.length;
    scored.wronglyContested.of += now.length;
    scored.contestMissed.count += contestMissed;
    scored.contestMissed.of += probe.contested.length;
    scored.each.push({
      probe: probe.id,
      kind: probe.kind,
      replaced,
      notDrawnAgain,
      changeMissed,
      wronglyContested: contested.length,
      contestMissed,
    });
  }
  return { agreement, planted, labelled, probes: scored, parked };
};

/** `part` of `whole` as a percentage, or "n/a" of none. */
const percent = ({ count, of }: Share): string =>
  of === 0 ? "n/a" : `${((count / of) * 100).toFixed(0)}% (${count} of ${of})`;

/** The score as the command prints it. */
export const extractionReport = (score: ExtractionScore): string => {
  const { agreement, planted, labelled, probes } = score;
  const compared = agreement.same + agreement.valueDiffers + agreement.onlyOne;
  return [
    `Two draws of each document (${agreement.documents} documents):`,
    `  the same memory in both:                 ${percent(share(agreement.same, compared))}`,
    `  same entity and attribute, other value:  ${percent(share(agreement.valueDiffers, compared))}`,
    `  in one draw only:                        ${percent(share(agreement.onlyOne, compared))}`,
    `Planted statements the checker let through: ${percent(planted)}`,
    "Against the labels (clean draws):",
    `  precision (filed memories):              ${percent(labelled.precision)}`,
    `  recall:                                  ${percent(labelled.recall)}`,
    `  same entity and attribute, other value:  ${labelled.valueDiffers}`,
    `  filed under no attribute:                ${labelled.unfiled} (not scored: precision covers filed memories only)`,
    "Second versions and second sources (of the true facts drawn first and said again):",
    `  ended, another value now in their slot:  ${percent(probes.replaced)}`,
    `  ended, not drawn again:                  ${percent(probes.notDrawnAgain)}`,
    `  current memories contested wrongly:      ${percent(probes.wronglyContested)}`,
    `  changes not applied:                     ${percent(probes.changeMissed)}`,
    `  real disagreements not contested:        ${percent(probes.contestMissed)}`,
    ...probes.each.map(
      (probe) =>
        `    ${probe.probe} (${probe.kind}): replaced ${probe.replaced}, not drawn again ${probe.notDrawnAgain}, contested wrongly ${probe.wronglyContested}, change missed ${probe.changeMissed}, contest missed ${probe.contestMissed}`
    ),
    `Units that parked (no result): ${score.parked}`,
  ].join("\n");
};

// What a run prints (brain-eval-extraction.test.ts), one JSON line per
// marker, and what the command reads back (scripts/brain-eval-extraction.ts).

export const extractionMarkers = {
  run: "BRAIN_EVAL_EXTRACTION_RUN",
  draw: "BRAIN_EVAL_EXTRACTION_DRAW",
  probe: "BRAIN_EVAL_EXTRACTION_PROBE",
  end: "BRAIN_EVAL_EXTRACTION_END",
} as const;

const readEntitySchema = z.object({
  kind: z.string(),
  names: z.array(z.string()),
});

const readMemorySchema = z.object({
  about: readEntitySchema,
  attribute: z.string().nullable(),
  value: z.string().nullable(),
  object: readEntitySchema.nullable(),
  type: z.string(),
  statement: z.string(),
  speaker: speakerSchema,
  current: z.boolean(),
  contested: z.boolean(),
});

const drawResultSchema = z.object({
  document: z.string(),
  draw: z.enum(["clean", "planted"]),
  parked: z.boolean(),
  memories: z.array(readMemorySchema),
});

const probeResultSchema = z.object({
  probe: z.string(),
  parked: z.boolean(),
  memories: z.array(readMemorySchema),
});

/** What a run says of itself first: the set, the model, and each prompt's version. */
export const extractionRunInfoSchema = z.object({
  set: z.string(),
  model: z.string(),
  prompts: z.object({ read: z.string(), check: z.string() }),
});

/** How a run ended: stopped at its budget, failed, and what it spent. */
export const extractionRunEndSchema = z.object({
  stopped: z.boolean(),
  failed: z.boolean(),
  spentUsd: z.number(),
});

/** A marker and the JSON after it, up to the next marker on its line. */
const printedLine = new RegExp(
  `(${Object.values(extractionMarkers).join("|")}) (.*?)(?=(?:${Object.values(extractionMarkers).join("|")}) |$)`,
  "gmu"
);

export interface ExtractionRunRead {
  info: z.infer<typeof extractionRunInfoSchema> | undefined;
  end: z.infer<typeof extractionRunEndSchema> | undefined;
  draws: DrawResult[];
  probes: ProbeResult[];
  /** Lines with a marker that didn't read: cut short or garbled. */
  unread: number;
}

/** What `output` printed of a run, each marked line read with its schema. */
export const readExtractionRun = (output: string): ExtractionRunRead => {
  const read: ExtractionRunRead = {
    info: undefined,
    end: undefined,
    draws: [],
    probes: [],
    unread: 0,
  };
  for (const [, marker = "", text = ""] of output.matchAll(printedLine)) {
    let value: unknown = undefined;
    try {
      value = JSON.parse(text.trim());
    } catch {
      read.unread += 1;
      continue;
    }
    if (marker === extractionMarkers.run) {
      read.info = extractionRunInfoSchema.safeParse(value).data;
      read.unread += read.info === undefined ? 1 : 0;
      continue;
    }
    if (marker === extractionMarkers.end) {
      read.end = extractionRunEndSchema.safeParse(value).data;
      read.unread += read.end === undefined ? 1 : 0;
      continue;
    }
    const parsed =
      marker === extractionMarkers.draw
        ? drawResultSchema.safeParse(value)
        : probeResultSchema.safeParse(value);
    if (!parsed.success) {
      read.unread += 1;
    } else if ("draw" in parsed.data) {
      read.draws.push(parsed.data);
    } else {
      read.probes.push(parsed.data);
    }
  }
  return read;
};
