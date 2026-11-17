import { z } from "zod";

import { sha256Hex } from "./encoding.ts";
import { defineErrorFamily } from "./errors.ts";
import { canonicalJson } from "./json.ts";
import { interviewerSchema } from "./onboarding.ts";
import type { InterviewKind } from "./onboarding.ts";

// Everyone who takes part in the onboarding has a link of their own
// (core's onboarding/links.ts). It opens their interview, and nothing
// else, from the day it goes out until the interviews close, for them
// alone: they sign in with the company's sign-in, and the first account
// to open it whose address the link was sent to is the one the interview
// belongs to from then on (GRA-1790). The link's secret is 256 bits, only
// ever in the URL's fragment and in request bodies; core keeps only its
// hash. Anyone else holding the link, the company's admin who handed it
// out included, is told it opens nothing, as for a link that never was.

/** Where the interview's page talks to core: one POST per action. */
export const interviewApiPath = "/api/interview";

/** Where an interview link leads: the page, with the secret after the `#`. */
export const interviewPagePath = "/interview";

/** A link's secret: 32 random bytes, base64url. */
export const interviewSecretSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u, "An interview link's secret");

/** The parts of an interview, in order. */
export const interviewPhases = [
  "open",
  "you",
  "anchor",
  "story",
  "steps",
  "exceptions",
  "numbers",
  "result",
  "readback",
] as const;

/** What a fact is about: the kinds Stephen marks in what someone says. */
export const factTags = [
  "step",
  "system",
  "handoff",
  "wait",
  "exception",
  "rule",
  "judgment",
  "workaround",
  "ai",
  "wish",
  "number",
  "done",
  "stop",
  "case",
  "term",
  "next",
  "work",
  /**
   * Who does the work someone was asked about and does not do, by the
   * name they said: whom Grasp asks about it next (GRA-1285).
   */
  "who",
] as const;

/** Where someone invited stands. */
export const personStates = [
  "invited",
  "opened",
  "progress",
  "incomplete",
  "completed",
  "expired",
] as const;

/** How Stephen says a line. */
export const voiceTags = [
  "warm, relaxed",
  "sincere, steady",
  "curious, gently",
  "softly",
  "interested, a little lighter",
  "patient",
  "neutral, light",
  "upbeat, understanding",
  "upbeat, reassuring",
  "sincere, steady, reassuring",
  "amused, soft chuckle",
  "warm",
  "easy, light",
  "clear, measured pace",
  "warm, grateful",
  "warm, kind",
] as const;

/** The most lines and facts one interview keeps, and the longest of each. */
export const interviewLimits = {
  lines: 400,
  facts: 200,
  marks: 40,
  line: 4000,
  fact: 300,
  file: 200,
} as const;

const factTagSchema = z.enum(factTags);
type FactTag = (typeof factTags)[number];

/** One line said in an interview: Stephen's, or the person's. */
export const interviewLineSchema = z.strictObject({
  from: z.enum(["stephen", "person"]),
  text: z.string().max(interviewLimits.line),
  /** A person's line that was typed, not heard. */
  typed: z.literal(true).optional(),
  /** In a person's line: what Stephen marked in it. */
  marks: z
    .array(
      z.strictObject({
        quote: z.string().max(interviewLimits.fact),
        tag: factTagSchema,
      })
    )
    .max(interviewLimits.marks)
    .optional(),
  /** A file they shared with this line, by its name. */
  file: z.string().max(interviewLimits.file).optional(),
  /** How Stephen said his line. */
  tone: z.enum(voiceTags).optional(),
  /**
   * Removed by the person whose interview it is (GRA-1897): its words, its
   * marks and its file's name are gone, and it keeps only its place, so
   * the conversation's positions stay where they were.
   */
  removed: z.literal(true).optional(),
});
export type InterviewLine = z.output<typeof interviewLineSchema>;

/** A line as an interview keeps it: one removed holds nothing but who said it. */
const keptLineSchema = interviewLineSchema.refine(
  (line) =>
    line.removed !== true ||
    (line.text === "" &&
      line.marks === undefined &&
      line.file === undefined &&
      line.typed === undefined &&
      line.tone === undefined),
  "A removed line holds nothing"
);

/** `line` removed: who said it, and nothing of what (`removed`). */
export const removedLine = (line: InterviewLine): InterviewLine => ({
  from: line.from,
  text: "",
  removed: true,
});

/** One thing Stephen understood, as he reads it back. */
export const interviewFactSchema = z.strictObject({
  id: z.string().regex(/^[a-z]\d{1,4}$/u),
  tag: factTagSchema,
  /** As he reads it back, in their language. */
  text: z.string().trim().min(1).max(interviewLimits.fact),
  /** The same as the record keeps it, in English. */
  record: z.string().max(interviewLimits.fact),
  /** Taken out by the person in the read-back. */
  out: z.literal(true).optional(),
  /** Said in the read-back where it was missing: the part it goes in. */
  pin: z
    .int()
    .min(0)
    .max(interviewLimits.facts - 1)
    .optional(),
  /** Read back and agreed to before. */
  agreed: z.literal(true).optional(),
  /**
   * Where the person chose this line goes (GRA-1987): `team`, shared with
   * their team as how they work; missing, only counted anonymously. Missing
   * is the strict side, so an interview saved before there was a choice
   * reaches no team result. Approving binds it (`factRevision`).
   */
  share: z.literal("team").optional(),
});
export type InterviewFact = z.output<typeof interviewFactSchema>;

/**
 * The tags whose lines start out only counted anonymously: what someone
 * wishes, what they use AI for and think of it, and their own list or
 * unofficial tool, any of which can get someone in trouble. Who does the
 * work names a colleague and is never shared (`neverShared`). Every other
 * tag describes how the work runs and starts out shared with the team.
 * Only where a line starts: the person moves any line before approving.
 */
const anonymousByDefault: ReadonlySet<FactTag> = new Set([
  "wish",
  "ai",
  "workaround",
  "who",
]);

/** The tag whose line is only used to know whom to ask: never shared with the team. */
export const neverShared = "who" satisfies FactTag;

/** Where a line of `tag` starts out, as Stephen writes it down. */
export const shareByDefault = (tag: FactTag): InterviewFact["share"] =>
  anonymousByDefault.has(tag) ? undefined : "team";

/** Whether `fact` is shared with the team as how they work: chosen so, and of a tag that may be. */
export const sharedWithTeam = ({
  tag,
  share,
}: Pick<InterviewFact, "tag" | "share">): boolean =>
  share === "team" && tag !== neverShared;

/**
 * A fact as an interview keeps it: one erased (`erasedFact`) keeps its id
 * and place, so no id is ever given to another, and holds no words.
 */
const keptFactSchema = interviewFactSchema
  .extend({ text: z.string().trim().max(interviewLimits.fact) })
  .refine(
    (fact) =>
      fact.text === ""
        ? fact.out === true &&
          fact.record === "" &&
          fact.pin === undefined &&
          fact.share === undefined
        : true,
    "An erased fact holds nothing"
  )
  .refine(
    (fact) => fact.tag !== neverShared || fact.share === undefined,
    "Who does the work is never shared"
  );

/**
 * `fact`, taken out and then erased for good (GRA-1897): its id, its kind
 * and that it is out, nothing of what it said.
 */
export const erasedFact = (fact: InterviewFact): InterviewFact => ({
  id: fact.id,
  tag: fact.tag,
  text: "",
  record: "",
  out: true,
});

/** What a fact's id holds: `f` and its number. */
const factNumber = /^f(?<number>\d+)$/u;

/**
 * The id the next fact written down in `facts` gets: one past the
 * highest, so no id is given twice, whatever was erased or left out.
 */
export const nextFactId = (facts: readonly InterviewFact[]): string => {
  const highest = Math.max(
    0,
    ...facts.map(({ id }) => Number(factNumber.exec(id)?.groups?.number ?? 0))
  );
  return `f${highest + 1}`;
};

/** Whether `fact` was erased (`erasedFact`): it is read out and counted nowhere. */
export const isErased = (fact: InterviewFact): boolean =>
  fact.out === true && fact.text === "";

/**
 * Where someone's interview is, as their page keeps it and sends it to be
 * kept. Checked item by item: a save with anything else in it, or more of
 * it than an interview holds, is refused whole.
 */
export const interviewProgressSchema = z.strictObject({
  person: z.enum(personStates),
  told: z.boolean(),
  mode: z.enum(["talk", "type"]).nullable(),
  lines: z.array(keptLineSchema).max(interviewLimits.lines),
  facts: z
    .array(keptFactSchema)
    .max(interviewLimits.facts)
    .refine(
      (facts) => new Set(facts.map(({ id }) => id)).size === facts.length,
      "Each fact once"
    ),
  phase: z.enum(interviewPhases),
  wants: z.enum(["answer", "file", "readback", "end"]),
  /** When they started talking, in ms since the epoch. */
  startedAt: z.number().nonnegative().nullable(),
  /**
   * Their last turn, in ms since the epoch, and the time between turns
   * that was time away and is not counted in the minutes Stephen is told
   * (the page's `ticked`). None on an interview kept before there was this
   * clock: it counts from `startedAt`, as it did.
   */
  seenAt: z.number().nonnegative().optional(),
  awayMs: z.number().nonnegative().optional(),
  confirmed: z.int().min(0).max(interviewLimits.facts),
  adding: z.boolean(),
  addedAt: z.number().nonnegative(),
  /** How they found it, from 1 to 5, when they said so. */
  rating: z.int().min(1).max(5).optional(),
  interviewer: interviewerSchema.optional(),
});
export type InterviewProgress = z.output<typeof interviewProgressSchema>;

/**
 * What someone agrees to before anything they say is recorded or read by
 * a model (GRA-329): why the interview is held, who reads what comes of
 * it, and which version of the page saying so they read. The version goes
 * up whenever what the page says about it changes: whoever agreed to an
 * older one is asked again before anything more is recorded.
 */
export const participationNotice = {
  version: 2,
  /** Why: how their team's work is done, for the company's Grasp. */
  purpose: "onboarding.interview",
  /**
   * Who reads it (GRA-1987): their team, the lines they chose to share, as
   * how the team works; the company, what they think, only counted
   * anonymously across it. Never by name.
   */
  audience: "team.work_and_company.views",
} as const;

/** A fact's revision: the SHA-256 (hex) of exactly what was read back and what the record keeps. */
export const interviewRevisionSchema = z.string().regex(/^[0-9a-f]{64}$/u);

/**
 * The revision of a fact as it stands: what approving it binds to. Any
 * change to its kind, to what was read back, to what the record keeps or
 * to where it goes (`share`) makes a new revision, which counts only once
 * it is approved too: a line moved after approval is taken back first.
 * One only counted anonymously has the revision it had before there was
 * a choice, so an approval from then still counts, anonymously.
 */
export const factRevision = async ({
  id,
  tag,
  text,
  record,
  share,
}: Pick<
  InterviewFact,
  "id" | "tag" | "text" | "record" | "share"
>): Promise<string> =>
  await sha256Hex(
    canonicalJson(
      share === undefined
        ? [id, tag, text, record]
        : [id, tag, text, record, share]
    )
  );

/** One fact as read back and approved: which, at which revision. */
export const approvedFactSchema = z.strictObject({
  id: interviewFactSchema.shape.id,
  revision: interviewRevisionSchema,
});
export type ApprovedFact = z.output<typeof approvedFactSchema>;

/** The most one save may carry, as its request's bytes. */
export const interviewRequestMaxBytes = 768 * 1024;

/** What the interview's page sends. */
export const interviewRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("session"),
    secret: interviewSecretSchema,
  }),
  z.strictObject({
    action: z.literal("save"),
    secret: interviewSecretSchema,
    /** The version this copy was saved as, 0 before it ever was. */
    version: z.int().min(0),
    progress: interviewProgressSchema,
    /**
     * The page that sends it, and how many saves it sent with this one:
     * a later save of the page that made the version kept goes on from
     * it, though the version it made never reached the page (its answer
     * lost, or still on its way as the page closed).
     */
    page: z.strictObject({ id: z.uuid(), save: z.int().min(1) }).optional(),
  }),
  z.strictObject({
    action: z.literal("delete"),
    secret: interviewSecretSchema,
  }),
  /** They read what the interview is for and agree to take part (`participationNotice`). */
  z.strictObject({
    action: z.literal("participate"),
    secret: interviewSecretSchema,
    notice: z.int().min(1),
  }),
  /** They approve the facts read back, each at the revision they saw. */
  z.strictObject({
    action: z.literal("approve"),
    secret: interviewSecretSchema,
    facts: z
      .array(approvedFactSchema)
      .min(1)
      .max(interviewLimits.facts)
      .refine(
        (facts) => new Set(facts.map(({ id }) => id)).size === facts.length,
        "Each fact once"
      ),
  }),
  /** They withdraw: nothing of their interview is used from now on. */
  z.strictObject({
    action: z.literal("withdraw"),
    secret: interviewSecretSchema,
  }),
]);
export type InterviewRequest = z.input<typeof interviewRequestSchema>;

/** What a link opens for the account it belongs to. */
export interface InterviewSession {
  state: "open";
  /** Their first name, their team, and their lead's first name. */
  name: string;
  team: string;
  lead: string | null;
  kind: InterviewKind;
  /** The last day the link takes anything, as an ISO day. */
  closes: string;
  /** The interviews are over: what was said can be read and deleted, no more. */
  closed: boolean;
  /**
   * What was said, none before anything was saved. Whether they read what
   * this is (`told`) and which facts they agreed to (`agreed`) are core's,
   * from what they agreed to there, never what the page last said.
   */
  progress: InterviewProgress | null;
  version: number;
  /** They withdrew: what they said is theirs to read and delete, and nothing more is taken. */
  withdrawn: boolean;
  /**
   * What the Brain kept of their interview, or of their team's claims, is
   * still being removed: a withdrawal's or a delete's erasure that hasn't
   * landed yet, which core's clock finishes.
   */
  removing: boolean;
}

/** What saving answers: the version kept, or the newer copy that was. */
export type InterviewSaved =
  | { saved: true; version: number }
  | { saved: false; version: number; progress: InterviewProgress | null };

/** What taking part answers: the notice they agreed to, and when they first did. */
export interface InterviewParticipation {
  notice: number;
  at: string;
}

/**
 * What approving answers: the receipt of exactly these revisions, the same
 * however often it is asked, and when they were first approved; or, when
 * what was read back isn't what is kept any more, the copy kept.
 */
export type InterviewApproval =
  | { approved: true; receipt: string; at: string }
  | { approved: false; version: number; progress: InterviewProgress | null };

/**
 * What withdrawing answers: when they withdrew, the first time they did,
 * and `removing` while what the Brain kept of it is still being removed
 * (the request's erasures didn't all land; core's clock finishes them).
 */
export interface InterviewWithdrawal {
  withdrawn: true;
  at: string;
  removing?: true;
}

/** Why an interview link refused something. */
export const interviewErrors = defineErrorFamily({
  "interview.link_invalid":
    "This link doesn't work. Ask whoever sent it for a new one.",
  "interview.not_yet":
    "Your interview isn't open yet. You'll get an email when it is.",
  "interview.paused":
    "The interviews are paused for now. Try again a little later.",
  "interview.closed": "The interviews are over. Thank you for your time.",
  "interview.sign_in": "Sign in with your work account to open your interview.",
  "interview.deleted":
    "You deleted this interview. Start again to talk with Stephen.",
  "interview.limited": "That was a lot at once. Wait a minute, then go on.",
  "interview.invalid": "That isn't something an interview takes.",
  "interview.not_participating":
    "Read what this interview is for and agree to take part first.",
  "interview.notice_changed":
    "What this interview is for has changed. Read it again before you go on.",
  "interview.withdrawn":
    "You withdrew from this interview. Nothing more is taken from it.",
});
