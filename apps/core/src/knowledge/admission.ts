import type { AuditActor } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { drizzle } from "drizzle-orm/d1";
import markdownIt from "markdown-it";
import type { Token } from "markdown-it";

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
/** An HTML tag, as Markdown may hold one, or anything else in `<…>`. */
const tag = /<[^<>\n]*>/gu;
/** A Markdown link, `[text](url)`. */
const link = /\[(?<text>[^[\]\n]*)\]\([^()\s]*\)/gu;
/** Markdown's emphasis and code marks, which split no word. */
const emphasis = /[*`~]/gu;
const apostrophes = /[‘’ʼ]/gu;
const joiners = /[-‐-―_/]/gu;

/**
 * Lowercased, accents, invisible characters and emphasis removed, hyphens
 * and slashes as spaces.
 */
const lowered = (text: string): string =>
  text
    .normalize("NFKD")
    .replaceAll(accents, "")
    .replaceAll(invisible, "")
    .replaceAll(emphasis, "")
    .replaceAll(apostrophes, "'")
    .toLowerCase()
    .replaceAll(joiners, " ");

/**
 * `text` as the detectors read it (`lowered`). Text with markup is read
 * three times, joined: as written; with its tags as spaces and its links
 * reduced to their text, so a word a tag or link splits ("trade
 * <span>union</span>") is seen, and so is one inside what only looks like
 * a tag ("hours < 8, on sick leave > 5 days") or in a link's address; and
 * with its tags and comments removed, as the Knowledge reader drops raw
 * HTML and shows the halves around it joined ("can<b></b>cer"). A word
 * any reading has counts: when unsure, hold.
 */
const normalized = (text: string): string => {
  const plain = lowered(text);
  if (!text.includes("<") && !text.includes("](")) {
    return plain;
  }
  const linked = text.replaceAll(link, "$<text>");
  const spaced = linked.replaceAll(tag, " ");
  const joined = linked.replaceAll(tag, "");
  return `${plain}\n${lowered(spaced)}\n${lowered(joined)}`;
};

/** A unit to judge: a leaf block, such as a paragraph, heading or table row. */
interface Unit {
  text: string;
  /** Its table's first row, which names its columns. */
  header?: string;
  /** What its section and the preamble say. */
  context?: Signals;
}

/**
 * What a text says, worked out once: whether it refers to a person, and
 * which topics' words it has. Carrying these instead of the text keeps a
 * long section over many blocks cheap.
 */
interface Signals {
  person: boolean;
  topics: ReadonlySet<number>;
}

/** Whether `unit` refers to a person. */
const refersToPerson = (unit: Unit, plain: string): boolean =>
  personPattern.test(plain) ||
  possessive.test(unit.text) ||
  emailAddress.test(unit.text) ||
  (unit.header !== undefined &&
    personColumnPattern.test(normalized(unit.header)));

const signalsOf = (unit: Unit): Signals => {
  const plain = normalized(unit.text);
  const topics = new Set<number>();
  for (const [index, topic] of compiledTopics.entries()) {
    if (topic.weak.test(plain)) {
      topics.add(index);
    }
  }
  return { person: refersToPerson(unit, plain), topics };
};

const together = (
  first: Signals | undefined,
  second: Signals | undefined
): Signals | undefined => {
  if (first === undefined || second === undefined) {
    return first ?? second;
  }
  return {
    person: first.person || second.person,
    topics: new Set([...first.topics, ...second.topics]),
  };
};

/** The deepest nesting parsed; anything deeper is held. */
const maxNesting = 100;

/**
 * CommonMark, with GFM's tables. Only its block parser runs: the units are
 * the source's lines, which the detectors read with their markup. A link
 * reference definition is read as the paragraph it is otherwise, since
 * the parser keeps no block for it.
 */
const markdown = markdownIt("default", { html: true, maxNesting }).disable(
  "reference"
);

/** The leaf blocks: everything else that opens a block contains others. */
const leaves: ReadonlySet<string> = new Set([
  "code_block",
  "fence",
  "heading_open",
  "html_block",
  "paragraph_open",
  "tr_open",
]);

/**
 * The text's units: each leaf block of its CommonMark structure (a
 * paragraph, heading, table row or code block), judged with what its
 * section says. A section is a heading and every block up to the next
 * heading of its level or higher, its subsections included; the blocks
 * before the first heading are the preamble, which is context for the
 * whole text. A person and a topic anywhere in one section, or in it and
 * the preamble, hold: "Employee Jan Jansen" over "## Notes", "## Status"
 * and "On sick leave" is about Jan. An amount stays certain only in its
 * own block. Each block's signals are read once and joined per outermost
 * section, which holds those of the sections in it, so this is linear.
 * Returns undefined for text nested deeper than the parser reads.
 */
const unitsOf = (text: string): Unit[] | undefined => {
  const tokens: Token[] = [];
  markdown.block.parse(text, markdown, {}, tokens);
  // Each line's start, and the end of the text.
  const starts = [0];
  for (
    let at = text.indexOf("\n");
    at !== -1;
    at = text.indexOf("\n", at + 1)
  ) {
    starts.push(at + 1);
  }
  starts.push(text.length + 1);
  const source = (first: number, end: number): string =>
    text.slice(starts[first], (starts[end] ?? 0) - 1);
  const units: Unit[] = [];
  // Each unit's outermost section, 0 for the preamble, and their signals.
  const sectionOf: number[] = [];
  const sections: (Signals | undefined)[] = [undefined];
  let depth = 0;
  let header: string | undefined = undefined;
  for (const token of tokens) {
    if (token.level >= maxNesting - 1) {
      return undefined;
    }
    if (token.map === null) {
      continue;
    }
    const [first, end] = token.map;
    if (token.type === "table_open") {
      header = source(first, first + 1);
    }
    if (!leaves.has(token.type)) {
      continue;
    }
    const unit: Unit = {
      text: source(first, end),
      header: token.type === "tr_open" ? header : undefined,
    };
    // A heading in a list or quote is a block inside the section.
    if (token.type === "heading_open" && token.level === 0) {
      const level = Number(token.tag.slice(1));
      if (depth === 0 || level <= depth) {
        depth = level;
        sections.push(undefined);
      }
    }
    const section = sections.length - 1;
    sections[section] = together(sections[section], signalsOf(unit));
    sectionOf.push(section);
    units.push(unit);
  }
  for (const [index, unit] of units.entries()) {
    const section = sectionOf[index] ?? 0;
    unit.context = together(
      sections[0],
      section > 0 ? sections[section] : undefined
    );
  }
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
    if (topic.weak.test(plain) || unit.context?.topics.has(index) === true) {
      person ??= unit.context?.person === true || refersToPerson(unit, plain);
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

/** An HTML character reference, as Markdown renders one: `&#99;`, `&amp;`. */
const characterReference =
  /&(?:#(?<decimal>\d{1,7})|#[xX](?<hex>[\da-fA-F]{1,6})|(?<name>[a-zA-Z][a-zA-Z\d]{0,31}));/gu;

/**
 * A named reference to a letter: an accented one (`&eacute;`), or a
 * script, fraktur or double-struck one (`&cscr;`), each read as its plain
 * letter, as the detectors read accents anyway.
 */
const letterReference =
  /^(?<letter>[a-zA-Z])(?:acute|grave|circ|uml|tilde|ring|cedil|caron|macr|breve|ogon|dot|dblac|strok|scr|fr|opf)$/u;

/** Other named references to what the detectors read. */
const namedReferences: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  lsquo: "‘",
  rsquo: "’",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  hyphen: "-",
  dash: "-",
  ndash: "–",
  mdash: "—",
  sol: "/",
  ast: "*",
  lowbar: "_",
  num: "#",
  colon: ":",
  period: ".",
  commat: "@",
  dollar: "$",
  euro: "€",
  pound: "£",
  szlig: "ss",
  aelig: "ae",
  AElig: "AE",
  oelig: "oe",
  OElig: "OE",
  oslash: "o",
  Oslash: "O",
  newline: "\n",
};

/** The largest code point. */
const maxCodePoint = 0x10_ff_ff;

const fromCodePoint = (code: number): string =>
  code > 0 && code <= maxCodePoint ? String.fromCodePoint(code) : "";

/**
 * `text` with its HTML character references decoded, as a Markdown
 * renderer shows it. A named one this code doesn't know is dropped, so
 * the letters around an invisible one (`&ZeroWidthSpace;`) join up: when
 * unsure, read the word whole.
 */
const decodedReferences = (text: string): string =>
  text.replaceAll(
    characterReference,
    (
      _reference: string,
      decimal: string | undefined,
      hex: string | undefined,
      name: string | undefined
    ) => {
      if (decimal !== undefined) {
        return fromCodePoint(Number(decimal));
      }
      if (hex !== undefined) {
        return fromCodePoint(Number.parseInt(hex, 16));
      }
      const named = name ?? "";
      return (
        namedReferences[named] ??
        letterReference.exec(named)?.groups?.letter ??
        ""
      );
    }
  );

/** The worse of two outcomes. */
const worse = (
  first: AdmissionOutcome,
  second: AdmissionOutcome
): AdmissionOutcome => {
  if (first === "excluded" || second === "excluded") {
    return "excluded";
  }
  return first === "held" || second === "held" ? "held" : "admitted";
};

/** What the detectors decide for `text`, read as written. */
const screenWritten = (text: string): AdmissionOutcome => {
  const units = unitsOf(text);
  if (units === undefined) {
    return "held";
  }
  let outcome: AdmissionOutcome = "admitted";
  for (const unit of units) {
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

/**
 * A hyphen that breaks a word at a line's end, as PDF text keeps it:
 * "diag-\nnosed". Only before a lowercase letter, which continues a word.
 */
const lineEndHyphen = /-[ \t]*\n[ \t]*(?=\p{Ll})/gu;

/**
 * What the platform minimum's detectors decide for `text`: excluded if any
 * sentence or table certainly holds a person's sensitive data, held if one
 * might, admitted otherwise. The text is also read as rendered, with its
 * HTML character references decoded (`&#99;ancer` is "cancer"), and with
 * words a line-end hyphen breaks joined ("can-\ncer"); the worst reading
 * decides. Pure: the topics in effect are the gate's.
 */
export const screen = (text: string): AdmissionOutcome => {
  const rendered = text.includes("&") ? decodedReferences(text) : text;
  const readings = new Set([
    text,
    rendered,
    text.replaceAll(lineEndHyphen, ""),
    rendered.replaceAll(lineEndHyphen, ""),
  ]);
  let outcome: AdmissionOutcome = "admitted";
  for (const reading of readings) {
    outcome = worse(outcome, screenWritten(reading));
    if (outcome === "excluded") {
      return outcome;
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
