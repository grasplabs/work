import { topicLeadMs } from "@grasp-os/shared/admission";
import type { TopicOwner } from "@grasp-os/shared/admission";
import type { AuditActor } from "@grasp-os/shared/audit";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { keepAuditEvent } from "../audit-outbox.ts";
import { admissionTopics } from "../db/core/schema.ts";
import {
  personColumns,
  personReferences,
  platformTopics,
} from "./admission-topics.ts";

// Knowledge admission: the one gate between text and canonical Knowledge
// storage. `writeVersion` (documents.ts) runs it right before its batch,
// so every route that stores a version passes it: a save, a restore, an
// upload's extraction, an agent's memory, an App's entry, a copied skill.
// Only a purge, which removes personal data, and the release's sync of
// the Grasp skills skip it.
//
// It fails closed. Text the platform minimum's detectors match is
// excluded; text they might match, held; text a company topic's terms
// match, excluded. All are refused, and nothing is kept: no version,
// section, link or upload original, and no queue of held text, which
// would itself keep it. A policy core can't read throws (a retry passes
// the gate again); a topic in effect that this code can't enforce (a
// platform revision newer than the code, or a company topic without
// terms) holds every write.
//
// Topics live in core's database and versions in Knowledge's, so no one
// transaction covers both. Instead a topic revision takes effect no
// sooner than `topicLeadMs` after it's saved, a write is checked against
// every revision in effect at any time over that window ahead, and it
// commits within the window or is checked again (`AdmittedUntil`). The refusal's error, log line and audit event
// name only the outcome and the policy's revision: never the text, the
// words matched or the topic, so the audit log doesn't become a list of
// who has health or pay data.

/** What admission decides for a text. */
export type AdmissionOutcome = "admitted" | "held" | "excluded";

const special = /[.*+?^${}()|[\]\\]/gu;
/** A gap between a term's words, however it's written. */
const wordGap = /[\s-]+/u;

/** A gap between two of a term's words, however long, in the text. */
const gapSource = String.raw`\s+`;

/** A node of a prefix trie over terms' characters and the gaps between words. */
interface TermNode {
  /** What may come next: an escaped character, or `gapSource`. */
  next: Map<string, TermNode>;
  /** Whether a term ends here. */
  end: boolean;
  /** Whether a stem ends here: any letters may follow. */
  stem: boolean;
}

const termNode = (): TermNode => ({ next: new Map(), end: false, stem: false });

/**
 * The trie below `node` as a regular expression. A run of nodes with one
 * way on is written out in a loop, so it nests a group only where terms
 * part, at most as deep as the longest term.
 */
const trieSource = (node: TermNode): string => {
  let prefix = "";
  let at = node;
  while (at.next.size === 1 && !at.end && !at.stem) {
    const [token, child] = at.next.entries().next().value ?? [];
    if (token === undefined || child === undefined) {
      break;
    }
    prefix += token;
    at = child;
  }
  const alternatives = [...at.next].map(
    ([token, child]) => `${token}${trieSource(child)}`
  );
  if (at.stem) {
    alternatives.push(String.raw`\p{L}*`);
  } else if (at.end) {
    alternatives.push("");
  }
  return alternatives.length === 1
    ? `${prefix}${alternatives[0]}`
    : `${prefix}(?:${alternatives.join("|")})`;
};

/**
 * Matches any of `terms` as whole words (admission-topics.ts's syntax).
 * Each gap between a term's words, however many spaces or hyphens it was
 * written with, becomes exactly one `\s+`: two in a row could split a
 * run of whitespace between them in every way, and text anyone may save
 * would make that take polynomial time.
 *
 * The terms are compiled into a prefix trie, not a flat alternation: a
 * flat one is tried term by term at every word's start, so terms sharing
 * a long prefix ("a a … a z1", "a a … a z2") cost their total length per
 * character of text. The trie reads a shared prefix once, so the work at
 * each word's start is bounded by the longest term and the ways terms
 * part along it. Which texts match, and where the first match starts,
 * are the same as a flat alternation's.
 */
export const termsPattern = (terms: readonly string[]): RegExp => {
  const root = termNode();
  for (const term of terms) {
    const stem = term.endsWith("*");
    const words = (stem ? term.slice(0, -1) : term)
      .split(wordGap)
      .filter((word) => word !== "");
    let node = root;
    for (const [index, word] of words.entries()) {
      const tokens = index > 0 ? [gapSource] : [];
      // By code point, as the `u` flag reads the pattern.
      for (const character of word) {
        tokens.push(character.replaceAll(special, String.raw`\$&`));
      }
      for (const token of tokens) {
        let child = node.next.get(token);
        if (child === undefined) {
          child = termNode();
          node.next.set(token, child);
        }
        node = child;
      }
    }
    if (stem) {
      node.stem = true;
    } else {
      node.end = true;
    }
  }
  return new RegExp(
    String.raw`(?<![\p{L}\p{N}])(?:${trieSource(root)})(?![\p{L}\p{N}])`,
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
export const normalized = (text: string): string => {
  const plain = lowered(text);
  if (!text.includes("<") && !text.includes("](")) {
    return plain;
  }
  const linked = text.replaceAll(link, "$<text>");
  const spaced = linked.replaceAll(tag, " ");
  const joined = linked.replaceAll(tag, "");
  return `${plain}\n${lowered(spaced)}\n${lowered(joined)}`;
};

/**
 * A sentence's end: not the full stop of an abbreviation such as "Mr." or
 * "Dhr.", whose name belongs to the same sentence.
 */
const sentenceEnd =
  /(?<!(?<![\p{L}])(?:mr|mrs|ms|dr|dhr|mevr|sr|sra|mme|m|st|nr|no|vs|etc))[.!?](?=\s)/iu;

const tableRow = /^\s*\|/u;
/** A Markdown heading's level: not a hashtag or an issue number ("#42"). */
const atxHeading = /^ {0,3}(?<marks>#{1,6})(?:\s|$)/u;
/** The line under a setext heading: `===` for level 1, `---` for 2. */
const setextUnderline = /^ {0,3}(?:=+|-+)[ \t]*$/u;
const listLine = /^\s*(?:[-*+>]\s|\d+[.)]\s)/u;

/** A unit to judge: a sentence, a table or list, or a run of lines. */
interface Unit {
  text: string;
  /** A table's first row, which names its columns. */
  header?: string;
  /** What the headings above it say, as signals: never their text again. */
  heading?: Heading;
  /**
   * A run of blocks judged together: it may only hold, never exclude by
   * an amount, which may belong to another of its sentences.
   */
  wide?: true;
}

/**
 * Headings' signals for the blocks under them, worked out once: whether
 * one refers to a person, and which topics' words they have. Carrying
 * these instead of their text keeps a long heading over many sentences
 * cheap.
 */
interface Heading {
  person: boolean;
  topics: ReadonlySet<number>;
}

/** A block's lines: a run of table rows, list or quote lines, or prose. */
type Block = "table" | "list" | "prose";

const blockOf = (line: string): Block | "blank" => {
  if (line.trim() === "") {
    return "blank";
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

/** The signals of the heading `line`, with those of `above` it. */
const headingOf = (line: string, above: Heading | undefined): Heading => {
  const plain = normalized(line);
  const topics = new Set<number>(above?.topics);
  for (const [index, topic] of compiledTopics.entries()) {
    if (topic.weak.test(plain)) {
      topics.add(index);
    }
  }
  return {
    person: above?.person === true || refersToPerson({ text: line }, plain),
    topics,
  };
};

/** The heading level `line` starts, with the line under it: 0 for none. */
const headingLevel = (line: string, next: string | undefined): number => {
  const marks = atxHeading.exec(line)?.groups?.marks;
  if (marks !== undefined) {
    return marks.length;
  }
  if (
    next !== undefined &&
    blockOf(line) === "prose" &&
    setextUnderline.test(next)
  ) {
    return next.trimStart().startsWith("=") ? 1 : 2;
  }
  return 0;
};

/**
 * The text's units: each heading; each table and each run of list or
 * quote lines whole (an HR record's lines are one), list items one blank
 * line apart included; the sentences of each paragraph, its lines joined
 * first so a sentence wrapped over two lines is one; and each run of
 * non-blank lines, whatever its blocks, as a wide unit (prose above a
 * list, two tables). Each unit carries the headings above it, of every
 * level: "# Employee Jan" over "## Status" over "sick leave" is about Jan.
 */
const unitsOf = (text: string): Unit[] => {
  const units: Unit[] = [];
  const lines = text.split("\n");
  // Each level's heading, with the signals of those above it.
  const headings: (Heading | undefined)[] = [];
  let heading: Heading | undefined = undefined;
  let kind: Block | undefined = undefined;
  let block: string[] = [];
  let run: string[] = [];
  let runHeader: string | undefined = undefined;
  // How many units there were when the run began.
  let runStart = 0;
  const endBlock = () => {
    if (kind === "prose") {
      for (const sentence of block.join(" ").split(sentenceEnd)) {
        units.push({ text: sentence, heading });
      }
    } else if (kind === "table") {
      units.push({ text: block.join("\n"), header: block[0], heading });
    } else if (kind === "list") {
      units.push({ text: block.join("\n"), heading });
    }
    kind = undefined;
    block = [];
  };
  const endRun = () => {
    endBlock();
    // Judged whole too when split into more than one unit: blocks, or
    // sentences split where an abbreviation ("Ph.D.", "e.g.") looked
    // like a sentence's end.
    if (units.length - runStart > 1) {
      units.push({
        text: run.join("\n"),
        header: runHeader,
        heading,
        wide: true,
      });
    }
    run = [];
    runHeader = undefined;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const next = lines[index + 1];
    const level = headingLevel(line, next);
    if (level > 0) {
      endRun();
      headings.length = level - 1;
      heading = headingOf(
        line,
        headings.findLast((h) => h !== undefined)
      );
      headings[level - 1] = heading;
      units.push({ text: line });
      if (atxHeading.exec(line) === null) {
        // A setext heading's underline.
        index += 1;
      }
      continue;
    }
    const lineKind = blockOf(line);
    if (lineKind === "blank") {
      // List items a blank line apart are one list.
      const looseList =
        kind === "list" && next !== undefined && blockOf(next) === "list";
      if (!looseList) {
        endRun();
      }
      continue;
    }
    if (lineKind !== kind) {
      endBlock();
    }
    kind = lineKind;
    block.push(line);
    if (run.length === 0) {
      runStart = units.length;
    }
    run.push(line);
    if (lineKind === "table") {
      runHeader ??= line;
    }
  }
  endRun();
  return units;
};

const judge = (unit: Unit, company: readonly RegExp[]): AdmissionOutcome => {
  const plain = normalized(unit.text);
  if (company.some((pattern) => pattern.test(plain))) {
    return "excluded";
  }
  let outcome: AdmissionOutcome = "admitted";
  let person: boolean | undefined = undefined;
  for (const [index, topic] of compiledTopics.entries()) {
    if (topic.strong?.test(plain) === true) {
      return "excluded";
    }
    if (topic.weak.test(plain) || unit.heading?.topics.has(index) === true) {
      person ??= unit.heading?.person === true || refersToPerson(unit, plain);
      if (person) {
        if (topic.amounts && unit.wide !== true && amount.test(plain)) {
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
const screenWritten = (
  text: string,
  company: readonly RegExp[]
): AdmissionOutcome => {
  let outcome: AdmissionOutcome = "admitted";
  for (const unit of unitsOf(text)) {
    const judged = judge(unit, company);
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
 * What the platform minimum's detectors, and the company topics' terms
 * (`company`), decide for `text`: excluded if any sentence or table
 * certainly holds what a topic covers, held if one might, admitted
 * otherwise. The text is also read as rendered, with its HTML character
 * references decoded (`&#99;ancer` is "cancer"), and with words a
 * line-end hyphen breaks joined ("can-\ncer"); the worst reading decides.
 * Pure: the topics in effect are the gate's.
 */
export const screen = (
  text: string,
  company: readonly RegExp[] = []
): AdmissionOutcome => {
  const rendered = text.includes("&") ? decodedReferences(text) : text;
  const readings = new Set([
    text,
    rendered,
    text.replaceAll(lineEndHyphen, ""),
    rendered.replaceAll(lineEndHyphen, ""),
  ]);
  let outcome: AdmissionOutcome = "admitted";
  for (const reading of readings) {
    outcome = worse(outcome, screenWritten(reading, company));
    if (outcome === "excluded") {
      return outcome;
    }
  }
  return outcome;
};

/** The topics a write is checked against, and whether all are enforced. */
interface Policy {
  /** Every revision applied, as a short hash. */
  revision: string;
  /** The company topics' detectors. */
  company: RegExp[];
  /** Whether a topic applied can't be enforced: then everything holds. */
  unenforced: boolean;
}

type TopicRow = typeof admissionTopics.$inferSelect;

/**
 * Every topic revision recorded, the platform's current ones among them:
 * any of those missing (a new deployment, or a release with a new
 * revision) is recorded first, so the record always shows what is
 * enforced. Throws when core's database can't be read or written.
 */
export const topicRows = async (env: Env): Promise<TopicRow[]> => {
  const db = drizzle(env.DB);
  const rows = await db.select().from(admissionTopics).all();
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
  return await db.select().from(admissionTopics).all();
};

/**
 * Most topic revisions a write's check reads: Grasp's, and well over the
 * company's topics in use and revisions to come that saving allows
 * (`topicMaxActive`, `topicMaxPending`).
 */
export const policyMaxRows = 1000;

/**
 * The revisions a policy from `now` can apply, at most one more than
 * `policyMaxRows`: each topic's latest revision in effect, unless it
 * retires the topic, and every revision still to come that a higher one
 * doesn't supersede (`superseded`; one whose effective time isn't a number
 * among them: SQLite orders text after numbers). A topic's older
 * revisions, and retired topics, are never read again, so a check reads
 * no more as revisions pile up. Throws when core's database
 * can't be read or written.
 */
const policyRows = async (env: Env, now: Date): Promise<TopicRow[]> => {
  const db = drizzle(env.DB);
  const at = now.getTime();
  const read = async () =>
    await db
      .select()
      .from(admissionTopics)
      .where(
        sql`(${admissionTopics.effectiveAt} > ${at} AND NOT EXISTS (SELECT 1 FROM admission_topics h WHERE h.id = ${admissionTopics.id} AND h.revision > ${admissionTopics.revision} AND h.effective_at <= ${admissionTopics.effectiveAt})) OR (${admissionTopics.retired} = 0 AND ${admissionTopics.revision} = (SELECT max(r.revision) FROM admission_topics r WHERE r.id = ${admissionTopics.id} AND r.effective_at <= ${at}))`
      )
      .limit(policyMaxRows + 1)
      .all();
  const rows = await read();
  const recorded = new Set(rows.map((row) => `${row.id}@${row.revision}`));
  const missing = platformTopics.some(
    ({ record }) => !recorded.has(`${record.id}@${record.revision}`)
  );
  if (!missing) {
    return rows;
  }
  // Grasp's current revisions recorded first (`topicRows`), unless one is
  // older than a revision recorded already: then it's held as unenforced.
  await topicRows(env);
  return await read();
};

/** A topic revision, as the policy reads it. */
interface Revision {
  id: string;
  revision: number;
  owner: TopicOwner;
  effectiveAt: Date;
  terms: string;
  retired: boolean;
}

/**
 * Whether `row` never takes effect: a higher revision of its topic takes
 * effect no later than it does, and the highest revision in effect is the
 * topic's. A revision saved for next year is superseded by a retirement
 * saved after it for next minute.
 */
const superseded = <
  Row extends Pick<Revision, "id" | "revision" | "effectiveAt">,
>(
  row: Row,
  rows: readonly Row[]
): boolean =>
  rows.some(
    (other) =>
      other.id === row.id &&
      other.revision > row.revision &&
      other.effectiveAt <= row.effectiveAt
  );

/**
 * The revisions that apply over [`from`, `until`]: each topic's revision
 * in effect at `from`, and every later one taking effect by `until` that
 * a higher one doesn't supersede. Applying them all is the strictest of
 * the policies over the window: a revision that narrows or retires a
 * topic loosens nothing until it is in effect, and one that adds to it
 * holds from as soon as it's saved.
 */
export const applying = <
  Row extends Pick<Revision, "id" | "revision" | "effectiveAt">,
>(
  rows: readonly Row[],
  from: Date,
  until: Date
): Row[] => {
  const current = new Map<string, Row>();
  const coming: Row[] = [];
  for (const row of rows) {
    if (row.effectiveAt <= from) {
      const held = current.get(row.id);
      if (held === undefined || row.revision > held.revision) {
        current.set(row.id, row);
      }
    } else if (row.effectiveAt <= until && !superseded(row, rows)) {
      coming.push(row);
    }
  }
  return [...current.values(), ...coming];
};

const termsSchema = z.array(z.string().min(1));

/**
 * Most company detectors kept per isolate: one per set of company
 * revisions applied, which changes only when an admin saves a topic.
 */
const companyPatternsKept = 16;

/**
 * Company detectors, by the revisions they cover (`id@revision`, sorted:
 * revisions never change), the least recently used first.
 */
const companyPatterns = new Map<string, RegExp | null>();

/**
 * One detector for all of `rows`, company revisions: their terms in one
 * trie (`termsPattern`), so a write's check reads text once however many
 * topics there are; `null` if one lists no valid terms.
 */
const companyPattern = (rows: readonly Revision[]): RegExp | null => {
  const key = rows
    .map((row) => `${row.id}@${row.revision}`)
    .toSorted()
    .join("\n");
  const cached = companyPatterns.get(key);
  if (cached !== undefined) {
    companyPatterns.delete(key);
    companyPatterns.set(key, cached);
    return cached;
  }
  const terms: string[] = [];
  let valid = true;
  for (const row of rows) {
    const parsed = termsSchema.safeParse(JSON.parse(row.terms));
    if (parsed.success && parsed.data.length > 0) {
      terms.push(...parsed.data);
    } else {
      valid = false;
    }
  }
  const pattern = valid ? termsPattern(terms) : null;
  companyPatterns.set(key, pattern);
  for (const [oldest] of companyPatterns) {
    if (companyPatterns.size <= companyPatternsKept) {
      break;
    }
    companyPatterns.delete(oldest);
  }
  return pattern;
};

/**
 * The policy over the window from `now`. The platform topics are enforced
 * from code whatever their rows say; a row can only add to them, and one
 * this code can't enforce holds everything. Throws when core's database
 * can't be read, so a write fails rather than pass unchecked.
 */
const policyFrom = async (env: Env, now: Date): Promise<Policy> => {
  const rows = await policyRows(env, now);
  const enforced = new Map(
    platformTopics.map(({ record }) => [record.id, record.revision])
  );
  const applied = applying(rows, now, new Date(now.getTime() + topicLeadMs));
  const company: RegExp[] = [];
  // More rows than the limits allow (saves racing past them) may leave
  // one unread: everything holds. So does a row whose effective time
  // can't be read, which may be in effect.
  let unenforced =
    rows.length > policyMaxRows ||
    rows.some((row) => Number.isNaN(row.effectiveAt.getTime()));
  const companyRows: TopicRow[] = [];
  for (const row of applied) {
    if (row.owner === "platform") {
      // Its own detector, or none this code knows: a newer revision.
      unenforced ||= enforced.get(row.id) !== row.revision;
    } else if (!row.retired) {
      companyRows.push(row);
    }
  }
  if (companyRows.length > 0) {
    const pattern = companyPattern(companyRows);
    if (pattern === null) {
      unenforced = true;
    } else {
      company.push(pattern);
    }
  }
  const revisions = new Set([
    ...applied.map((row) => `${row.id}@${row.revision}`),
    ...[...enforced].map(([id, revision]) => `${id}@${revision}`),
  ]);
  const digest = await sha256Hex([...revisions].toSorted().join("\n"));
  return { revision: digest.slice(0, 16), company, unenforced };
};

/**
 * Until when, in milliseconds since the epoch, an admitted write may
 * commit: past it, a topic revision saved after the check may be in
 * effect, and the write is checked again.
 */
export type AdmittedUntil = number;

/**
 * How long before its `AdmittedUntil` a write is checked again: its batch
 * takes time too, and has to commit before then.
 */
export const admissionMarginMs = 10_000;

/** Whether a write admitted `until` then must be checked again first. */
export const admissionDue = (until: AdmittedUntil): boolean =>
  Date.now() >= until - admissionMarginMs;

/**
 * Admits `text` into canonical Knowledge in `collectionId`, or refuses it:
 * `knowledge.excluded` or `knowledge.held`, recorded in the audit log by
 * outcome and policy revision only. Run it last before the write's batch,
 * and the batch before the time it returns.
 */
export const admitToKnowledge = async (
  env: Env,
  actor: AuditActor,
  collectionId: string,
  text: string
): Promise<AdmittedUntil> => {
  const now = new Date();
  const policy = await policyFrom(env, now);
  const outcome = policy.unenforced ? "held" : screen(text, policy.company);
  if (outcome === "admitted") {
    return now.getTime() + topicLeadMs;
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
