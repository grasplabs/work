import type { AuditActor } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { drizzle } from "drizzle-orm/d1";

import { keepAuditEvent } from "../audit-outbox.ts";
import { admissionTopics } from "../db/core/schema.ts";
import {
  personColumns,
  personReferences,
  platformTopics,
} from "./admission-topics.ts";
import type { TopicRecord } from "./admission-topics.ts";

// Knowledge admission: the one gate between text and canonical Knowledge
// storage. `writeVersion` (documents.ts) runs it right before its batch,
// so every route that stores a version passes it: a save, a restore, an
// upload's extraction, an agent's memory, an App's entry, a copied skill.
// Only a purge, which removes personal data, and the release's sync of
// the Grasp skills skip it.
//
// It fails closed. Text the platform minimum's detectors match is
// excluded; text they might match, held; both are refused, and nothing
// is kept: no version, section, link or upload original, and no queue of
// held text, which would itself keep it. A policy core can't read throws
// (a retry passes the gate again); a topic in effect that this code has
// no detector for (a company's, or a platform revision newer than the
// code) holds every write. The refusal's error, log line and audit event
// name only the outcome and the policy's revision: never the text, the
// words matched or the topic, so the audit log doesn't become a list of
// who has health or pay data.

/** What admission decides for a text. */
export type AdmissionOutcome = "admitted" | "held" | "excluded";

/** Matches any of `terms` as whole words (admission-topics.ts's syntax). */
const termsPattern = (terms: readonly string[]): RegExp => {
  const alternatives = terms.map((term) => {
    const stem = term.endsWith("*");
    const body = (stem ? term.slice(0, -1) : term)
      .replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)
      .replaceAll(" ", String.raw`\s+`);
    return stem ? String.raw`${body}\p{L}*` : body;
  });
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:${alternatives.join("|")})(?![\p{L}\p{N}])`,
    "u"
  );
};

interface CompiledTopic {
  strong: RegExp | undefined;
  weak: RegExp;
  amounts: boolean;
}

const compiledTopics: readonly CompiledTopic[] = platformTopics.map(
  ({ rules }) => ({
    strong: rules.strong.length > 0 ? termsPattern(rules.strong) : undefined,
    weak: termsPattern(rules.weak),
    amounts: rules.amounts === true,
  })
);

const personPattern = termsPattern(personReferences);
const personColumnPattern = termsPattern(personColumns);

// Every pattern here runs on text anyone may save, so none may backtrack
// over it: each repetition starts only where its match can (a word's
// start, a number's first digit), and none is followed by another that
// can match the same characters.

/** A name's possessive, as English writes it: "Jan's". */
const possessive = /(?<!\p{L})\p{Lu}\p{L}+['’]s(?![\p{L}\p{N}])/u;

/** An email address, which names a person. */
const emailAddress = /(?<![^\s@])[^\s@]+@[^\s@]+\.[^\s@]+/u;

/** An amount of money: a currency next to a number. */
const amount =
  /(?:[€$£]|(?<!\p{L})(?:eur|euro|euros|usd|gbp|chf)(?!\p{L}))\s?\d|(?<![\d.,'])\d[\d.,']*\s?(?:[€$£]|(?:k|eur|euro|euros|usd|gbp|chf)(?!\p{L}))/u;

const accents = /\p{M}/gu;
/** Invisible formatting, such as the soft hyphens of PDF and Word text. */
const invisible = /\p{Cf}/gu;
/** Markdown's emphasis and code marks, which split no word. */
const emphasis = /[*`~]/gu;
const apostrophes = /[‘’ʼ]/gu;
const joiners = /[-‐-―_/]/gu;

/**
 * Lowercased, accents, invisible characters and emphasis removed, hyphens
 * and slashes as spaces.
 */
const normalized = (text: string): string =>
  text
    .normalize("NFKD")
    .replaceAll(accents, "")
    .replaceAll(invisible, "")
    .replaceAll(emphasis, "")
    .replaceAll(apostrophes, "'")
    .toLowerCase()
    .replaceAll(joiners, " ");

/**
 * A sentence's end: not the full stop of an abbreviation such as "Mr." or
 * "Dhr.", whose name belongs to the same sentence.
 */
const sentenceEnd =
  /(?<!(?<![\p{L}])(?:mr|mrs|ms|dr|dhr|mevr|sr|sra|mme|m|st|nr|no|vs|etc))[.!?](?=\s)/iu;

const tableRow = /^\s*\|/u;
/** A Markdown heading: not a hashtag or an issue number ("#42"). */
const headingLine = /^ {0,3}#{1,6}(?:\s|$)/u;
const listLine = /^\s*(?:[-*+>]\s|\d+[.)]\s)/u;

/** A unit to judge: a sentence, or a whole table or list. */
interface Unit {
  text: string;
  /** A table's first row, which names its columns. */
  header?: string;
  /** What the heading above it says, as signals: never its text again. */
  heading?: Heading;
}

/**
 * A heading's signals for the blocks under it, worked out once: whether
 * it refers to a person, and which topics' words it has. Carrying these
 * instead of its text keeps a long heading over many sentences cheap.
 */
interface Heading {
  person: boolean;
  topics: ReadonlySet<number>;
}

/** A block's lines: a run of table rows, list or quote lines, or prose. */
type Block = "table" | "list" | "prose";

const blockOf = (line: string): Block | "heading" | "blank" => {
  if (line.trim() === "") {
    return "blank";
  }
  if (headingLine.test(line)) {
    return "heading";
  }
  if (tableRow.test(line)) {
    return "table";
  }
  return listLine.test(line) ? "list" : "prose";
};

/** Whether `unit` refers to a person. */
const refersToPerson = (unit: Unit, plain: string): boolean =>
  personPattern.test(plain) ||
  possessive.test(unit.text) ||
  emailAddress.test(unit.text) ||
  (unit.header !== undefined &&
    personColumnPattern.test(normalized(unit.header)));

/** The signals of the heading `line`. */
const headingOf = (line: string): Heading => {
  const plain = normalized(line);
  const topics = new Set<number>();
  for (const [index, topic] of compiledTopics.entries()) {
    if (topic.weak.test(plain)) {
      topics.add(index);
    }
  }
  return { person: refersToPerson({ text: line }, plain), topics };
};

/**
 * The text's units: each heading, each table and each run of list or
 * quote lines whole (an HR record's lines are one), and the sentences of
 * each paragraph, its lines joined first so a sentence wrapped over two
 * lines is one. Each unit under a heading carries it: "## Jan Jansen"
 * above "Sick since May." is about him.
 */
const unitsOf = (text: string): Unit[] => {
  const units: Unit[] = [];
  let heading: Heading | undefined = undefined;
  let kind: Block | undefined = undefined;
  let lines: string[] = [];
  const end = () => {
    if (kind === "prose") {
      for (const sentence of lines.join(" ").split(sentenceEnd)) {
        units.push({ text: sentence, heading });
      }
    } else if (kind === "table") {
      units.push({ text: lines.join("\n"), header: lines[0], heading });
    } else if (kind === "list") {
      units.push({ text: lines.join("\n"), heading });
    }
    kind = undefined;
    lines = [];
  };
  for (const line of text.split("\n")) {
    const block = blockOf(line);
    if (block !== kind) {
      end();
    }
    if (block === "heading") {
      heading = headingOf(line);
      units.push({ text: line });
    } else if (block !== "blank") {
      kind = block;
      lines.push(line);
    }
  }
  end();
  return units;
};

const judge = (unit: Unit): AdmissionOutcome => {
  const plain = normalized(unit.text);
  let outcome: AdmissionOutcome = "admitted";
  let person: boolean | undefined = undefined;
  for (const [index, topic] of compiledTopics.entries()) {
    if (topic.strong?.test(plain) === true) {
      return "excluded";
    }
    if (topic.weak.test(plain) || unit.heading?.topics.has(index) === true) {
      person ??= unit.heading?.person === true || refersToPerson(unit, plain);
      if (person) {
        if (topic.amounts && amount.test(plain)) {
          return "excluded";
        }
        outcome = "held";
      }
    }
  }
  return outcome;
};

/**
 * What the platform minimum's detectors decide for `text`: excluded if any
 * sentence or table certainly holds a person's sensitive data, held if one
 * might, admitted otherwise. Pure: the topics in effect are the gate's.
 */
export const screen = (text: string): AdmissionOutcome => {
  let outcome: AdmissionOutcome = "admitted";
  for (const unit of unitsOf(text)) {
    const judged = judge(unit);
    if (judged === "excluded") {
      return judged;
    }
    if (judged === "held") {
      outcome = judged;
    }
  }
  return outcome;
};

/** The topics in effect, and whether this code enforces all of them. */
interface Policy {
  /** The revision every topic in effect is at, as a short hash. */
  revision: string;
  /** Whether a topic in effect has no detector here: then everything holds. */
  unenforced: boolean;
}

/**
 * Every topic revision recorded, the platform's current ones among them:
 * any of those missing (a new deployment, or a release with a new
 * revision) is recorded first, so the record always shows what is
 * enforced. Throws when core's database can't be read or written.
 */
const topicRows = async (env: Env) => {
  const db = drizzle(env.DB);
  const read = async () =>
    await db
      .select({
        id: admissionTopics.id,
        revision: admissionTopics.revision,
        owner: admissionTopics.owner,
        effectiveAt: admissionTopics.effectiveAt,
      })
      .from(admissionTopics)
      .all();
  const rows = await read();
  const recorded = new Set(rows.map((row) => `${row.id}@${row.revision}`));
  const missing = platformTopics.filter(
    ({ record }) => !recorded.has(`${record.id}@${record.revision}`)
  );
  if (missing.length === 0) {
    return rows;
  }
  const now = new Date();
  await db
    .insert(admissionTopics)
    .values(
      missing.map(({ record }) => ({
        id: record.id,
        revision: record.revision,
        name: record.name,
        coverage: record.coverage,
        examples: JSON.stringify(record.examples),
        owner: record.owner,
        effectiveAt: record.effectiveAt,
        createdAt: now,
      }))
    )
    .onConflictDoNothing();
  return await read();
};

/** Each topic's latest revision in effect at `now`. */
const inEffect = (
  rows: Pick<TopicRecord, "id" | "revision" | "owner" | "effectiveAt">[],
  now: Date
) => {
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const current = latest.get(row.id);
    if (
      row.effectiveAt <= now &&
      (current === undefined || row.revision > current.revision)
    ) {
      latest.set(row.id, row);
    }
  }
  return [...latest.values()];
};

/**
 * The policy in effect now. The platform topics are enforced from code
 * whatever their rows say; a row can only add a topic, and one with no
 * detector here holds everything. Throws when core's database can't be
 * read, so a write fails rather than pass unchecked.
 */
const policyNow = async (env: Env): Promise<Policy> => {
  const rows = await topicRows(env);
  const enforced = new Map(
    platformTopics.map(({ record }) => [record.id, record.revision])
  );
  const effective = inEffect(rows, new Date());
  // A row whose effective time can't be read may be in effect: it holds.
  const unreadable = rows.some((row) =>
    Number.isNaN(row.effectiveAt.getTime())
  );
  const unenforced =
    unreadable ||
    effective.some(
      (row) => row.owner !== "platform" || enforced.get(row.id) !== row.revision
    );
  const revisions = new Set([
    ...effective.map((row) => `${row.id}@${row.revision}`),
    ...[...enforced].map(([id, revision]) => `${id}@${revision}`),
  ]);
  const digest = await sha256Hex([...revisions].toSorted().join("\n"));
  return { revision: digest.slice(0, 16), unenforced };
};

/**
 * Admits `text` into canonical Knowledge in `collectionId`, or refuses it:
 * `knowledge.excluded` or `knowledge.held`, recorded in the audit log by
 * outcome and policy revision only. Run it last before the write's batch.
 */
export const admitToKnowledge = async (
  env: Env,
  actor: AuditActor,
  collectionId: string,
  text: string
): Promise<void> => {
  const policy = await policyNow(env);
  const outcome = policy.unenforced ? "held" : screen(text);
  if (outcome === "admitted") {
    return;
  }
  await keepAuditEvent(env, drizzle(env.KNOWLEDGE), {
    actor,
    action: "knowledge.admission.refused",
    target: { type: "collection", id: collectionId },
    detail: { outcome, policy: policy.revision },
  });
  throw knowledgeErrors.create(
    outcome === "held" ? "knowledge.held" : "knowledge.excluded"
  );
};
