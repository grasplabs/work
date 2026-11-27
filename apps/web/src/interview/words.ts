import type { FactTag } from "@grasp-os/shared/interview-turn";
import { useLingui } from "@lingui/react/macro";

import type { Locale } from "../i18n.ts";

// What an interview says by itself, in the language on screen: what
// Stephen says around the read-back and when something fails, the parts of
// an interview, and what he marks (prototype `interview-words.ts` and
// `useReadBackIntro`).

/** What the conversation needs to say and to know by itself. */
export interface LoopWords {
  locale: Locale;
  /** "Is that correct?" on screen, and their "Yes, that's correct." */
  question: string;
  yes: string;
  /**
   * The read-back: its heading on screen, and what he says around it,
   * which is not what the screen shows: how he brings the summary in, and
   * how he asks whether it is right once he told it back.
   */
  summary: string;
  summaryIntro: string;
  summaryAsk: string;
  /** How he asks it once he told back only what was added. */
  addedAsk: string;
  /** What heads and opens the read-back when he reads back only what was added. */
  added: string;
  /** His goodbye once they agreed to it, by their first name when there is one. */
  farewell: (name: string) => string;
  /**
   * His first line of a conversation (the agent's `{{opening}}`): new, for
   * someone about their own work or a lead about their team's, by name;
   * or back after a pause or a reload.
   */
  opening: (name: string, lead: boolean) => string;
  welcomeBack: string;
  /** Told to the agent as it comes back, after the conversation before: where it is, and what not to do. */
  backNote: string;
  /** A plain yes, in their words: then nobody has to think about it. */
  agrees: RegExp;
  /** What they say when they put a line of the read-back right themselves. */
  changed: (was: string, now: string) => string;
  /** What he says, as a line of his own, when he couldn't hear what they said in the read-back. */
  unheard: string;
  /**
   * What the bar at the top says when the conversation can't go on: none
   * could be started; it was cut off; what they said couldn't be written
   * down yet.
   */
  notStarted: string;
  dropped: string;
  notNoted: string;
  /** In the read-back, their listening for today is used up: they type there. */
  voiceSpent: string;
}

/** A plain yes, in each language: said to a part of the read-back, it needs no thinking about. */
const agreesIn: Record<Locale, RegExp> = {
  en: /^(?:yes|yeah|yep|yup|correct|right|sure|ok(?:ay)?)?[\s,.!]*(?:(?:that|it|this)(?:’|')?s|that is|all|looks?|sounds?)?\s*(?:right|correct|good|fine|true)?[\s.!]*$/iu,
  nl: /^(?:ja|jawel|klopt|juist|prima|goed|oké|ok)?[\s,.!]*(?:dat|het|helemaal|alles)?\s*(?:klopt|is goed|is juist|goed|juist)?[\s.!]*$/iu,
  de: /^(?:ja|genau|stimmt|richtig|passt|ok(?:ay)?)?[\s,.!]*(?:das|alles)?\s*(?:stimmt|passt|ist richtig|ist korrekt|richtig|korrekt)?[\s.!]*$/iu,
  fr: /^(?:oui|exact|exactement|d(?:’|')accord|ok)?[\s,.!]*(?:c(?:’|')est|tout est)?\s*(?:ça|correct|exact|juste|bon)?[\s.!]*$/iu,
  es: /^(?:sí|si|correcto|exacto|vale|ok)?[\s,.!]*(?:eso es|así es|está|todo)?\s*(?:correcto|bien|así)?[\s.!]*$/iu,
};

/** The words of the conversation, in `locale`. */
export const useLoopWords = (locale: Locale): LoopWords => {
  const { t } = useLingui();
  return {
    locale,
    question: t`Is that correct?`,
    yes: t`Yes, that’s correct.`,
    summary: t`Summary`,
    summaryIntro: t`Thanks—I’ve put together a quick summary of what we talked about. Take a look.`,
    summaryAsk: t`Does that capture it well, or is there anything you’d like to change or add?`,
    addedAsk: t`Does this new part look right?`,
    added: t`This is what is new.`,
    farewell: (name) =>
      name === ""
        ? t`Thanks so much—it was great talking with you. You can always come back to this link within 7 days if you want to adjust anything. Have a great rest of your week.`
        : t`Thanks so much, ${name}—it was great talking with you. You can always come back to this link within 7 days if you want to adjust anything. Have a great rest of your week.`,
    agrees: agreesIn[locale],
    changed: (was, now) => t`Change “${was}” to “${now}”.`,
    unheard: t`I could not hear that. Say it once more, or type it.`,
    notStarted: t`The interview could not start. Try again.`,
    opening: (name, lead) =>
      lead
        ? t`Hi ${name}, I'm Stephen. Let's start with what your team handles overall, then who takes care of what. In a few words, what does your team do?`
        : t`Hi ${name}, I'm Stephen. Let's start with your work as a whole, then zoom in on one part of it. In a sentence or two, what do you do here?`,
    welcomeBack: t`Welcome back. Ready to continue?`,
    backNote:
      "They paused and just came back. You already asked if they are ready. When they say yes, ask your last open question again in a few words. Do not greet them and do not start over.",
    dropped: t`The conversation with Stephen was cut off. What you said is kept. Try again to go on.`,
    notNoted: t`What you said could not be written down yet. It is kept. Try again in a moment.`,
    voiceSpent: t`You have talked as long as you can today. Type your answers to go on, or come back tomorrow to talk.`,
  };
};

/**
 * The promise about their words (GRA-1286, GRA-1987), as the first screen,
 * the read-back's last part and the thanks say it, and as Stephen says it
 * when asked: the lines they share go to everyone in their company as how
 * their team works, the rest are only counted anonymously (core's onboarding/store.ts
 * `drawInput`, `participationNotice`).
 */
export const usePromise = (): string => {
  const { t } = useLingui();
  return t`How you do the work is shared in your company as how your team works, never as what you said. What you think of it is only counted anonymously: it shows once five or more people across the company say the same, never with your name or your team.`;
};

/** What Stephen marks in a line, in words: each mark's hover names its kind. */
export const useInterviewWords = () => {
  const { t } = useLingui();
  const tag: Record<FactTag, string> = {
    step: t`Step`,
    system: t`Where`,
    handoff: t`Passing it on`,
    wait: t`Waiting`,
    exception: t`When it goes differently`,
    rule: t`Rule`,
    judgment: t`Judgment`,
    workaround: t`Own list or tool`,
    ai: t`AI`,
    wish: t`Wish`,
    number: t`Number`,
    done: t`Done right`,
    stop: t`Stop and ask`,
    case: t`Example`,
    term: t`Word`,
    next: t`Next person`,
    work: t`Work of the team`,
    who: t`Who does it`,
    task: t`Recurring work`,
  };
  return { tag };
};
