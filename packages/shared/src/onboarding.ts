import { z } from "zod";

// The onboarding's interviews: Stephen, or Claire if the person prefers,
// talks with every team lead and then with everyone else, in the language
// they choose. Shared by core, which holds the interviews, and the web
// app, which shows them.

/** The languages an interview is held in: the ones the frontend speaks. */
export const interviewLocales = ["en", "nl", "de", "fr", "es"] as const;
export const interviewLocaleSchema = z.enum(interviewLocales);
export type InterviewLocale = z.infer<typeof interviewLocaleSchema>;

/**
 * Who holds an interview. It is one interview either way: the same
 * questions in the same order under the same rules, so what two people
 * told two interviewers can be laid side by side. What differs is the
 * person: the voice, the face, and how they react.
 */
export const interviewers = ["stephen", "claire"] as const;
export const interviewerSchema = z.enum(interviewers);
export type Interviewer = z.infer<typeof interviewerSchema>;

/** Who holds an interview when nobody chose. */
export const firstInterviewer: Interviewer = "stephen";

/** What each is called: a name, the same in every language. */
export const interviewerNames: Record<Interviewer, string> = {
  stephen: "Stephen",
  claire: "Claire",
};

/**
 * What an interview is about: someone's own piece of work, or, with a team
 * lead, the work of their whole team.
 */
export const interviewKinds = ["own", "lead"] as const;
export const interviewKindSchema = z.enum(interviewKinds);
export type InterviewKind = z.infer<typeof interviewKindSchema>;

/** The mark of the text that spoke: its SHA-256, in hex. */
export const interviewerTextMarkSchema = z.string().regex(/^[0-9a-f]{64}$/u);
