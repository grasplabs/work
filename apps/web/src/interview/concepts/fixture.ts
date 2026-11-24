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
      day: "Later today",
      time: "4:00 PM",
      when: "later today at 4:00 PM",
    },
    {
      id: "tomorrow",
      day: "Tomorrow morning",
      time: "9:00 AM",
      when: "tomorrow morning at 9:00 AM",
    },
    {
      id: "monday",
      day: "Monday morning",
      time: "9:00 AM",
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
    /** The title on exactly two lines (Ruben, 24 November), `{name}` still to fill. */
    titleLines: ["Hi {name}, got a few minutes", "to talk about your work?"],
    /** The one short paragraph (Ruben: "it just feels too long"). */
    whoShort: filled(
      "{sponsorFirst} asked everyone at {company} to have a short chat with Stephen, our AI interviewer. It takes {minutes} minutes at most."
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
    /** Split as the hello: "Got it." as the title, the rest under it. */
    doneHead: "Got it.",
    doneRest: (when: string) => `We’ll remind you ${when}.`,
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
    /** One line, the banner's most compact honest form on a phone. */
    blocked: "Your browser blocked the microphone.",
    transcript: "Transcript",
    stop: "Pause",
  },
  clock: {
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
  readback: {
    title: "Here’s what I took away",
    line: "Have a quick read to make sure this sounds right. You can edit or remove anything before it’s shared.",
    confirm: "Looks good, share it",
    done: filled(
      "Thanks, {name}. You’re all done. You can still edit or delete this until {close}."
    ),
  },
} as const;

/** What Stephen says first in the conversation, after the yes, to hear them. */
export const { hello } = copy.talk;

/** What the fixture "hears" for the first words, in place of a transcription. */
export const helloHeard = "Coffee and a sandwich on the way in, as always.";

/** What Stephen says once he heard them. */
export const heardYou = copy.talk.heard;

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
