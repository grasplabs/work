// What Grasp knows about a piece of work, in its own sentences (GRA-1253):
// the brain's statements about it and what its drawing says, each with
// what it rests on and the ISO week, never a quote, a name, a face or a
// day. Threat model, each held by apps/core/test/work-knowledge.test.ts:
//
// - A statement pointing at one person. Only the brain's own sentences
//   are served, which are claims five or more people made (GRA-1084) and
//   a drawing's parts five or more told; never a source's title, how it
//   was collected, its transcript or its interviewee.
// - A date pointing at the one person who talked that day. A sentence
//   carries its ISO week alone (`2026-W42`), never a day.
// - A role pointing at one person. A role is named only where five or more
//   people of its team hold it, and only once five or more people told
//   about the work; otherwise the team alone, or nothing.
// - Counting the people who talked. The confidence says only whether
//   enough did (`heard`) or not yet (`waiting`), never how many.
// - Keeping what was erased. Nothing is kept per reader or per person:
//   each read derives from the brain as it is, so a claim or a drawing the
//   brain lets go of (an erasure, a purge) is gone from the tab with it.
//   Asking for more voices keeps the piece of work alone, never who asked
//   beyond the audit log.

/** What a sentence rests on: people said it, a document says it, Grasp saw it in use, or a run did it. */
export type RestsOn = "said" | "written" | "seen" | "done";

/** What part of the story a sentence tells. */
export type KnownAbout =
  | "today"
  | "blocker"
  | "timeSink"
  | "handover"
  | "tool"
  | "rule"
  | "wish"
  | "goal";

/** One thing Grasp knows about a piece of work, in its own words. */
export interface KnownSentence {
  id: string;
  about: KnownAbout;
  text: string;
  restsOn: RestsOn;
  /** The ISO week it came in: `2026-W42`. */
  week: string;
  /**
   * Who said it, as the company may read it: their role in their team
   * where five or more of the team hold that role, else the team; null
   * until five or more people told about the work.
   */
  by: { team: string; role: string | null } | null;
}

/** What Grasp knows about one piece of work (`brain.work`). */
export interface WorkKnowledge {
  /** The piece of work: the brain's candidate it is. */
  id: string;
  name: string;
  sentences: KnownSentence[];
  /** Whether enough people told about it, never how many. */
  confidence: "heard" | "waiting";
  /** Whether the reader may ask for it in Stephen's next interviews. */
  canAskMore: boolean;
  /** Whether more voices were asked for already, and not yet heard. */
  moreAsked: boolean;
}

/** The ISO week a day (`YYYY-MM-DD`, or a time) is in, as `2026-W42`. */
export const isoWeekOf = (iso: string): string => {
  const [year = 1970, month = 1, day = 1] = iso
    .slice(0, 10)
    .split("-")
    .map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // The week's Thursday decides the year it counts in.
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const weekYear = date.getUTCFullYear();
  const start = Date.UTC(weekYear, 0, 1);
  const week = Math.ceil(((date.getTime() - start) / 86_400_000 + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
};
