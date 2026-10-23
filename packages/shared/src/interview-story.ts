import { z } from "zod";

import {
  interviewFactSchema,
  interviewSecretSchema,
} from "./interview-links.ts";
import type { InterviewFact } from "./interview-links.ts";
import type { FactTag } from "./interview-turn.ts";
import { interviewerSchema, interviewLocaleSchema } from "./onboarding.ts";

// The read-back at the end of an interview (core's onboarding/story.ts):
// what Stephen wrote down stands on the person's screen a few lines at a
// time (`readBackParts`), and he tells each part back as a short story, not
// line by line, with the lines that belong together in one sentence. The
// lines stay what the person reads, changes and agrees to; the story is
// only how he says them, held to the same rules on the page and in core
// (`storyOf`). Only what they agreed to counts (`agreedFacts`). Ported from
// the prototype (grasplabs/prototype, packages/grasp:
// src/lib/interview-story.ts, and readBackParts in
// src/lib/interview-turn.ts), which the Stephen Lab measures: change the
// rules there and here together.

export const interviewStoryPath = "/api/interview/story";

/** The most lines one part is told from, and the longest a line and a sentence of his may be, in characters. */
export const storyLinesMax = 12;
const storyLineMax = 300;
const sentenceMax = 320;
/**
 * A story is there to be quicker than the lines read one by one: told in
 * more words than this many times theirs, it is not, and the lines are
 * read as they are.
 */
const longer = 1.25;
/** The most bytes one story's request may carry. */
export const interviewStoryMaxBytes = 16 * 1024;

/** A line of the part, as it stands on screen. */
export const storyLineSchema = z.strictObject({
  id: interviewFactSchema.shape.id,
  text: z.string().trim().min(1).max(storyLineMax),
});
export type StoryLine = z.output<typeof storyLineSchema>;

/** What the page asks: the lines of one part, on its link, in whose voice and in which language. */
export const interviewStoryRequestSchema = z.strictObject({
  secret: interviewSecretSchema,
  key: interviewSecretSchema,
  locale: interviewLocaleSchema,
  interviewer: interviewerSchema.default("stephen"),
  lines: z
    .array(storyLineSchema)
    .min(1)
    .max(storyLinesMax)
    .refine(
      (lines) => new Set(lines.map(({ id }) => id)).size === lines.length,
      "Each line once"
    ),
});
export type InterviewStoryRequest = z.output<
  typeof interviewStoryRequestSchema
>;

/** One sentence he says, and the lines on screen it tells: they light up while he says it. */
export interface StorySentence {
  say: string;
  ids: string[];
}

/** The shape the model answers in; `storyOf` holds it to the rules. */
export const storySchema = z.object({
  sentences: z
    .array(
      z.object({
        say: z.string().describe("One sentence, as you say it to them."),
        ids: z
          .array(z.string())
          .describe("The ids of the lines this sentence tells."),
      })
    )
    .describe("What you say, a sentence at a time, in the order you say it."),
});

/** How long a number of lines or sentences are together, in characters. */
const lengthOf = (parts: string[]): number =>
  parts.reduce((sum, part) => sum + part.length, 0);

const loose = z.object({ sentences: z.array(z.unknown()) });
/** A sentence as the model wrote it: what isn't text or a list counts as none. */
const sentenceOf = (value: unknown): { say: string; ids: unknown[] } => {
  const sentence = z
    .object({ say: z.unknown(), ids: z.unknown() })
    .safeParse(value ?? {});
  const say = sentence.success ? sentence.data.say : undefined;
  const ids = sentence.success ? sentence.data.ids : undefined;
  return {
    say: typeof say === "string" ? say : "",
    ids: Array.isArray(ids) ? ids : [],
  };
};

/**
 * What the model told back, held to the rules, or null when it is no story
 * to tell: then the lines are read as they stand. A sentence tells at least
 * one line that no sentence before it told, and a line lights up once; a
 * sentence that tells none is left out, as nothing may be said that is not
 * on screen. A line no sentence tells is said as it stands, after the
 * others, so nothing they agree to goes unsaid. And the whole is no longer
 * than the lines themselves.
 */
export const storyOf = (
  value: unknown,
  lines: StoryLine[]
): StorySentence[] | null => {
  const body = loose.safeParse(value);
  if (!body.success || lines.length === 0) {
    return null;
  }
  const known = new Set(lines.map(({ id }) => id));
  const told = new Set<string>();
  const story: StorySentence[] = [];
  for (const each of body.data.sentences) {
    const sentence = sentenceOf(each);
    const say = sentence.say.trim().replaceAll(/\s+/gu, " ");
    if (say.length > sentenceMax) {
      return null;
    }
    const ids = [
      ...new Set(
        sentence.ids.filter(
          (id): id is string =>
            typeof id === "string" && known.has(id) && !told.has(id)
        )
      ),
    ];
    if (say !== "" && ids.length > 0) {
      for (const id of ids) {
        told.add(id);
      }
      story.push({ say, ids });
    }
  }
  if (story.length === 0) {
    return null;
  }
  for (const line of lines) {
    if (!told.has(line.id)) {
      story.push({ say: line.text, ids: [line.id] });
    }
  }
  const said = lengthOf(story.map(({ say }) => say));
  return said > lengthOf(lines.map(({ text }) => text)) * longer ? null : story;
};

/** What stands for a part's lines as they are now: a story is of exactly these, and of no others. */
export const storyKey = (lines: StoryLine[]): string =>
  lines.map(({ id, text }) => `${id}\u0000${text}`).join("\u0001");

/** Which part of the read-back a fact is read in: what they said about AI, the steps, what goes differently, or the numbers and the result. */
export const readBackGroups = [
  "you",
  "steps",
  "differently",
  "result",
] as const;
/** A part of the read-back is of one group, or of several small ones read `together`. */
export type ReadBackGroup = (typeof readBackGroups)[number] | "together";

const groupOf: Record<FactTag, (typeof readBackGroups)[number]> = {
  step: "steps",
  system: "steps",
  handoff: "steps",
  next: "steps",
  workaround: "steps",
  work: "steps",
  exception: "differently",
  wait: "differently",
  rule: "differently",
  judgment: "differently",
  ai: "you",
  wish: "you",
  number: "result",
  done: "result",
  stop: "result",
  case: "result",
  term: "result",
};

/** How many lines are read back at once: few enough to read, check and agree to without scrolling. */
export const readBackLines = 5;
/** The most lines a page has once another part has joined it: parts that fit on one page together are read together. */
export const readBackMost = 7;

/** One part of the read-back: its group, whether it is that group's first part, and its lines. */
export interface ReadBackPart {
  group: ReadBackGroup;
  first: boolean;
  facts: InterviewFact[];
}

/**
 * The read-back in parts: what they said about AI, the steps, what goes
 * differently, then the numbers and the result, each a few lines at a
 * time. Small parts are read together, so five short answers are not five
 * pages to agree to. A line the person added stays in the part they added
 * it to. What was agreed to in an earlier read-back is not read again:
 * back to add something, only what is new or changed is.
 */
export const readBackParts = (facts: InterviewFact[]): ReadBackPart[] => {
  const open = facts.filter(({ agreed }) => agreed !== true);
  const parts: ReadBackPart[] = readBackGroups.flatMap((group) => {
    const own = open.filter(
      (fact) => fact.pin === undefined && groupOf[fact.tag] === group
    );
    return Array.from(
      { length: Math.ceil(own.length / readBackLines) },
      (_, index) => ({
        group,
        first: index === 0,
        facts: own.slice(index * readBackLines, (index + 1) * readBackLines),
      })
    );
  });
  // A short interview has a short read-back: a part joins the one before it for as long as the page stays short.
  const pages: ReadBackPart[] = [];
  for (const part of parts) {
    const before = pages.at(-1);
    if (
      before !== undefined &&
      before.facts.length + part.facts.length <= readBackMost
    ) {
      pages[pages.length - 1] = {
        group: before.group === part.group ? before.group : "together",
        first: before.first,
        facts: [...before.facts, ...part.facts],
      };
    } else {
      pages.push(part);
    }
  }
  return pages.map((part, index) => ({
    ...part,
    facts: [...part.facts, ...open.filter(({ pin }) => pin === index)],
  }));
};

/**
 * What counts of an interview: the facts its person agreed to and didn't
 * take out. Coming back to add something keeps what was agreed; what is
 * added counts once it is agreed to as well. Nothing else is ever drawn.
 */
export const agreedFacts = (facts: InterviewFact[]): InterviewFact[] =>
  facts.filter(({ agreed, out }) => agreed === true && out !== true);

/**
 * What was agreed to, as it stands for the drawing: the same facts, in the
 * same words, mean nothing new to draw.
 */
export const agreedKey = (facts: InterviewFact[]): string =>
  agreedFacts(facts)
    .map(({ id, tag, record }) => `${id}\u0000${tag}\u0000${record}`)
    .join("\u0001");
