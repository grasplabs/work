/**
 * Who holds an interview. Whoever is asked to talk chooses, on the way in, between two people:
 * Stephen and Claire. It is one interview either way: the same questions in the same order under
 * the same rules, so what two people told two interviewers can be laid side by side. What differs
 * is the person: the voice, the face, and how they react.
 */
export const INTERVIEWERS = ["stephen", "claire"] as const;
export type Interviewer = (typeof INTERVIEWERS)[number];

/** Stephen holds every interview that was started before there was a choice, and any that does not say. */
export const FIRST_INTERVIEWER: Interviewer = "stephen";

export const isInterviewer = (value: unknown): value is Interviewer =>
  INTERVIEWERS.some((each) => each === value);

/** The interviewer a value names; Stephen when it names none. */
export const interviewerOf = (value: unknown): Interviewer =>
  isInterviewer(value) ? value : FIRST_INTERVIEWER;
