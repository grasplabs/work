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
  /** The times "Not now" offers to remind them. */
  remindAt: [
    {
      id: "today",
      label: "Later today, at 4:00 PM",
      when: "later today at 4:00 PM",
    },
    {
      id: "tomorrow",
      label: "Tomorrow morning, at 9:00 AM",
      when: "tomorrow morning at 9:00 AM",
    },
    {
      id: "monday",
      label: "Monday morning, at 9:00 AM",
      when: "on Monday morning at 9:00 AM",
    },
  ],
} as const;

/** The sponsor's first name: the company is on first-name terms (Ruben's copy). */
const sponsorFirst = "Marieke";

/** Reads `{minutes}` and `{close}` into a line. */
const filled = (line: string): string =>
  line
    .replaceAll("{minutes}", String(fixture.minutes))
    .replaceAll("{close}", fixture.closes)
    .replaceAll("{name}", fixture.person)
    .replaceAll("{sponsorFirst}", sponsorFirst)
    .replaceAll("{company}", fixture.company);

/**
 * Ruben's copy (24 November, "Grasp Interview Copy & Writing Guide", on the
 * pull request), every string by his ID. Translated like every other word
 * in the real build; core records the consent notice's VERSION with the
 * yes, raised whenever the consent's words change. No em-dashes. One
 * meaning and one tense everywhere until Ruben says otherwise (orchestrator,
 * 24 November): "until {close}" and "Nothing was recorded."
 */
export const copy = {
  start: {
    title: filled("Hi {name}, got a few minutes to talk about your work?"),
    titleAlt: "Tell us how your work really goes",
    who: filled(
      "{sponsorFirst} asked everyone at {company} to have a short chat with Stephen, our AI interviewer. We want to understand how your work actually goes and where things get stuck. It takes {minutes} minutes at most."
    ),
    promises: [
      "Your voice isn’t saved, only your words.",
      "Nothing is shared until you review and approve it.",
      filled("You can change or delete it any time until {close}."),
    ],
    more: "How your answers are handled",
    agree: "I agree, let’s start",
    later: "Not right now",
    decline: "I’d rather skip this",
  },
  later: {
    title: "When works better for you?",
    line: filled(
      "We’ll send a reminder with this same link. It stays open until {close}."
    ),
    back: "Back",
    doneTitle: (when: string) => `Got it. We’ll remind you ${when}.`,
    doneLine: "Nothing was recorded.",
    doneStart: "Actually, let’s start now",
  },
  decline: {
    title: "Skip the interview?",
    line: filled(
      "That’s completely fine. {sponsorFirst} will see that you opted out, but never why. Nothing was recorded."
    ),
    yes: "Yes, skip it",
    back: "Back",
    doneTitle: "Thanks for letting us know",
    doneLine: filled(
      "If you change your mind, this link stays open until {close}."
    ),
    undo: "I changed my mind",
  },
  check: {
    title: "Say your name and what you do",
    line: "That’s your first answer, and a quick check that I can hear you.",
    heard: "Loud and clear. Nice to meet you.",
    start: "Let’s get started",
    type: "I’d rather type",
    blocked: "Your browser blocked the microphone.",
    retry: "Try again",
    typeMain: "Type instead",
    placeholder: "Your name and what you do",
  },
  talk: {
    hello: filled(
      "Hi {name}, I’m Stephen. Talking to an AI can feel a bit odd at first, so just talk to me like you would a colleague. Say a quick hello so I know I can hear you."
    ),
    heard: "Loud and clear. Thanks.",
    wrapUp: "We have about 5 minutes left, so one last question.",
    timeUp: filled(
      "That’s our {minutes} minutes. Thanks, {name}. Everything you shared is saved."
    ),
    readBack: "Review what I wrote down",
    placeholder: "Type your answer...",
    talk: "Talk",
    talkTooltip: "Switch back to voice",
    blocked:
      "Your browser blocked the microphone. You can type your answers instead.",
    retry: "Try again",
    transcript: "Transcript",
    stop: "Pause",
  },
  clock: {
    used: (used: number) => `${used} / ${fixture.minutes} min`,
    label: "Stephen",
    mark5: "5 minutes left",
    mark1: "1 minute left",
    mark0: "Time’s up",
  },
  paused: {
    line: (left: number) =>
      filled(
        `Your answers are saved and the clock is stopped. You have ${left} minutes left, and you can pick up where you left off any time until {close}.`
      ),
    title: "Paused",
    carryOn: "Continue",
  },
  c: {
    languageTitle: "Which language do you prefer?",
    consent: filled(
      "Hi {name}, I’m Stephen, an AI interviewer from Grasp. {sponsorFirst} asked everyone at {company} to chat with me about how work actually goes and where things get stuck. It takes {minutes} minutes at most, and I’ll keep an eye on the time."
    ),
    ask: "Ready to start?",
    yes: "I agree, let’s start",
    later: "Not right now",
    decline: "I’d rather skip this",
    micOff: "Your microphone stays off until you agree.",
    agreed: "You agreed.",
    remindAsk: "No problem. When should I remind you?",
    remindTitle: "Remind me",
    remindDone: (when: string) =>
      filled(
        `Got it. I’ll remind you ${when}. Nothing was recorded, and this link stays open until {close}.`
      ),
    declined: filled(
      "That’s completely fine, {name}. {sponsorFirst} will see that you opted out, but never why. Nothing was recorded, and I won’t send any reminders. If you change your mind, this link works until {close}."
    ),
    undo: "I changed my mind",
  },
  readback: {
    title: "Here’s what I took away",
    line: "Have a quick read to make sure this sounds right. You can edit or remove anything before it’s shared.",
    confirm: "Looks good, share it",
    done: filled(
      "Thanks, {name}. You’re all done. You can still edit or delete this until {close}."
    ),
  },
} as const;

/** The consent notice's version: core records it with the yes; raised as its words change. */
export const consentVersion = 3;

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
export const { hello } = copy.talk;

/** What the fixture "hears" for the first words, in place of a transcription. */
export const helloHeard = "Coffee and a sandwich on the way in, as always.";

/** What Stephen says once he heard them. */
export const heardYou = copy.talk.heard;

/** The sound check of concept B: one sentence that is also the first answer. */
export const checkAsk = copy.check.title;
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
export const { wrapUp } = copy.talk;

/** What Stephen says as the time is up. */
export const { timeUp } = copy.talk;

/** For a callback the fixture has nothing to do with. */
export const ignore = (): void => {
  // Nothing: the fixture keeps no state for it.
};
