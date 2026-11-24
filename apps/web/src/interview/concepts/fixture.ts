// CONCEPT ONLY (never merged): what the concepts for the interview’s start
// and read-back show, where core gives nothing yet. One person, one
// company, one sponsor, the campaign’s dates, Stephen’s first questions and
// the answers the fixture "hears", and the lines of a read-back. What core
// would have to provide for real is listed in the pull request ("needs
// from core").

export const fixture = {
  person: "Sanne",
  company: "Acme Logistics",
  sponsor: { name: "Marieke de Vries", role: "COO" },
  interviewer: "Stephen",
  /** The interview’s one budget, said the same everywhere. */
  minutes: 20,
  /** When the interviewer starts to wrap up. */
  wrapUpMinutes: 5,
  /** The campaign’s close date, as the admin set it. */
  closes: "Tuesday 1 December",
  /** The link still opens after the close, to change or delete. */
  linkUntil: "Tuesday 8 December",
  /** The times "Not now" offers to remind them. */
  remindAt: [
    { id: "today", label: "Later today", when: "today at 16:00" },
    { id: "tomorrow", label: "Tomorrow morning", when: "tomorrow at 9:00" },
    { id: "monday", label: "Monday morning", when: "Monday at 9:00" },
  ],
} as const;

/** The languages the interview speaks, each in its own words. */
export const languages = [
  { id: "en", name: "English" },
  { id: "de", name: "Deutsch" },
  { id: "nl", name: "Nederlands" },
  { id: "es", name: "Español" },
  { id: "fr", name: "Français" },
] as const;

export type LanguageId = (typeof languages)[number]["id"];

/** What Stephen says first in the conversation, after the yes, to hear them. */
export const hello = `Hi ${fixture.person}. Say a few words, so I know I can hear you.`;

/** What the fixture "hears" for the first words, in place of a transcription. */
export const helloHeard = "Coffee and a sandwich on the way in, as always.";

/** What Stephen says once he heard them. */
export const heardYou = "I can hear you clearly.";

/** The sound check of concept B: one sentence that is also the first answer. */
export const checkAsk = "Say your name and what you do.";
export const checkHeard =
  "I’m Sanne, and I plan the delivery routes for the north region.";

/** Stephen’s questions, in order, and what the fixture hears as each answer. */
export const script = [
  {
    ask: "What does a normal Monday morning look like for you?",
    answer:
      "I start by checking which orders came in over the weekend, then I build the routes for the drivers in a spreadsheet.",
  },
  {
    ask: "Walk me through that spreadsheet. Where do the orders come from?",
    answer:
      "They come from the order system as an export. I copy them into my sheet, sort them by postcode and check the big customers by hand.",
  },
  {
    ask: "Why check the big customers by hand?",
    answer:
      "Their time windows are in an email, not in the system. If I miss one, a driver shows up when the dock is closed.",
  },
  {
    ask: "Who else touches the routes before the drivers leave?",
    answer: "Tom in the warehouse checks the loading order, around ten.",
  },
] as const;

/** What Stephen says as five minutes are left. */
export const wrapUp = "Five minutes left, so this is my last question.";

/** What Stephen says as the time is up. */
export const timeUp = `That’s our ${fixture.minutes} minutes. Thank you, ${fixture.person}: nothing you said is lost.`;

/** For a callback the fixture has nothing to do with. */
export const ignore = (): void => {
  // Nothing: the fixture keeps no state for it.
};
