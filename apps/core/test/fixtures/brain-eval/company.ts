/**
 * The Brain evaluation's company (GRA-1726): Groenhaven, a wholesaler of
 * garden and outdoor products that doesn't exist, with its head office and
 * warehouse in Utrecht and Nieuwegein, a warehouse in Duisburg, a sales
 * office in Lyon and a distribution centre in Valencia. Its group
 * language, for finance and IT, is English.
 *
 * Its sources are what a company's Brain holds: handbook pages, emails,
 * tickets and meeting notes, each with who may read it. Its questions ask
 * for one source each, in the five languages and across them, plus
 * questions whose answer is nowhere and questions whose answer is only in
 * a source the asker may not read.
 *
 * How it was made: written once for this evaluation, in November 2026,
 * drafted with a language model directly in each language, never
 * translated from another: the Dutch sources and the Dutch questions over
 * them were written in Dutch. Every person, company, customer, number and
 * event is made up; none comes from a client or a real person.
 *
 * Licence: no third-party text. It is part of this repository and under
 * its licence (AGPL-3.0-only), so it may be used, changed and published
 * with it.
 *
 * Pinned: any change to a source or a question is a new
 * {@link brainEvalSetVersion}. A run records the set's digest, and a
 * comparison between runs pairs only questions whose own digest (the
 * question and the source it asks for) is unchanged.
 */

/** Bumped with any change to the company, its sources or its questions. */
export const brainEvalSetVersion = "2026-11-11.2";

export const brainEvalLanguages = ["en", "nl", "de", "fr", "es"] as const;
export type BrainEvalLanguage = (typeof brainEvalLanguages)[number];

/** The company's people, each a member of core's organization in a run. */
export const brainEvalPeople = [
  "eva",
  "anna",
  "daan",
  "sophie",
  "lukas",
  "camille",
  "javier",
] as const;
export type BrainEvalPerson = (typeof brainEvalPeople)[number];

export const brainEvalTeamNames = [
  "everyone",
  "hr",
  "finance",
  "planning",
  "sales",
] as const;
export type BrainEvalTeam = (typeof brainEvalTeamNames)[number];

/**
 * Who is in each team: Eva, the operations director, is in all of them;
 * Anna is HR, Sophie finance, Camille sales, and Daan, Lukas and Javier
 * plan the three warehouses.
 */
export const brainEvalTeams: Record<BrainEvalTeam, readonly BrainEvalPerson[]> =
  {
    everyone: brainEvalPeople,
    hr: ["eva", "anna"],
    finance: ["eva", "sophie"],
    planning: ["eva", "daan", "lukas", "javier"],
    sales: ["eva", "camille"],
  };

/**
 * Who may read a source, as core says it: a team, one person (their own
 * mail), or nobody, when who may read it isn't known.
 */
export type BrainEvalReaders =
  | { team: BrainEvalTeam }
  | { owner: BrainEvalPerson }
  | "nobody";

export interface BrainEvalSource {
  /** Unique in the set: how questions name the source. */
  key: string;
  language: BrainEvalLanguage;
  readers: BrainEvalReaders;
  text: string;
}

/**
 * How a question finds its source, so each way recall gains can be
 * measured as it lands: with the source's own words (`words`), with other
 * forms of them, inflected or compounded (`forms`: stemming), by an ID,
 * code or name (`exact`), or with other words altogether (`paraphrase`:
 * vectors).
 */
export const brainEvalWays = ["words", "forms", "exact", "paraphrase"] as const;
export type BrainEvalWay = (typeof brainEvalWays)[number];

/**
 * What a question expects: the source that answers it, and the passage in
 * it that does (`quote`, unique in the set: a later recall that returns
 * passages instead of whole sources is scored on it); no answer, since
 * none is in the set (`absent`); or nothing that reveals the answer, which
 * is only in a source the asker may not read (`hidden`: none of `secrets`
 * may reach them).
 */
export type BrainEvalExpects =
  | { kind: "answer"; way: BrainEvalWay; source: string; quote: string }
  | { kind: "absent" }
  | { kind: "hidden"; source: string; secrets: readonly string[] };

export interface BrainEvalQuestion {
  /** Unique in the set and kept across versions while the question is. */
  id: string;
  language: BrainEvalLanguage;
  question: string;
  /** Who asks: Eva, who is in every team, unless the question says. */
  asker?: BrainEvalPerson;
  expects: BrainEvalExpects;
}

/** The default asker, in every team. */
export const brainEvalDefaultAsker: BrainEvalPerson = "eva";

/** Expects `source` to answer, at `quote`, found the `way` given. */
export const answer = (
  way: BrainEvalWay,
  source: string,
  quote: string
): BrainEvalExpects => ({ kind: "answer", way, source, quote });

/** Expects no answer: none is in the set. */
export const absent: BrainEvalExpects = { kind: "absent" };

/** Expects none of `secrets`, only in `source`, to reach the asker. */
export const hidden = (
  source: string,
  ...secrets: readonly string[]
): BrainEvalExpects => ({ kind: "hidden", source, secrets });
