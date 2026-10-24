import type { ReadBackGroup } from "@grasp-os/shared/interview-story";
import type { FactTag, InterviewPhase } from "@grasp-os/shared/interview-turn";
import { useLingui } from "@lingui/react/macro";

import type { Locale } from "../i18n.ts";

// What an interview says by itself, in the language on screen: what
// Stephen says around the read-back and when something fails, the parts of
// an interview, and what he marks (prototype `interview-words.ts` and
// `useReadBackIntro`).

/** What the conversation needs to say and to know by itself. */
export interface LoopWords {
  locale: Locale;
  /** "Is that correct?", and their "Yes, that's correct." */
  question: string;
  yes: string;
  /** What he says first in a part of the read-back; and when he reads back only what was added. */
  intro: (group: ReadBackGroup, first: boolean) => string;
  added: string;
  /** A plain yes, in their words: then nobody has to think about it. */
  agrees: RegExp;
  /** What they say when they put a line of the read-back right themselves. */
  changed: (was: string, now: string) => string;
  /**
   * What he says when something fails, each a line of his own: nothing
   * came back, so most likely their connection; core or the model said
   * no, so it is on our side; it still doesn't work after all his tries;
   * he couldn't hear what they said; he can't listen here.
   */
  offline: string;
  trouble: string;
  stillTrouble: string;
  unheard: string;
  noMicrophone: string;
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
  const intros: Record<ReadBackGroup, [string, string]> = {
    you: [
      t`Before the work: what you told me about AI.`,
      t`More of what you told me about AI.`,
    ],
    steps: [t`First, the steps.`, t`More of the steps.`],
    differently: [
      t`Then, when it goes differently.`,
      t`More of when it goes differently.`,
    ],
    result: [t`Last, the numbers and the result.`, t`And the rest.`],
    together: [t`This is what I wrote down.`, t`And the rest.`],
  };
  return {
    locale,
    question: t`Is that correct?`,
    yes: t`Yes, that’s correct.`,
    intro: (group, first) => intros[group][first ? 0 : 1],
    added: t`This is what is new.`,
    agrees: agreesIn[locale],
    changed: (was, now) => t`Change “${was}” to “${now}”.`,
    offline: t`I lost the connection. Please check your internet. I have kept what you said, and I keep trying.`,
    trouble: t`We have a technical problem on our side. It is not you. I have kept what you said, and I keep trying.`,
    stillTrouble: t`It still does not work. You can stop for now and come back later. Your place is kept.`,
    unheard: t`I could not hear that. Say it once more, or type it.`,
    noMicrophone: t`The microphone is not available here. Type your answer.`,
  };
};

/** The parts of an interview, and what Stephen marks, in words. */
export const useInterviewWords = () => {
  const { t } = useLingui();
  const phase: Record<InterviewPhase, string> = {
    open: t`Hello`,
    you: t`You and AI`,
    anchor: t`One real case`,
    story: t`Your story`,
    steps: t`Step by step`,
    exceptions: t`When it goes differently`,
    numbers: t`The numbers`,
    result: t`Done right`,
    readback: t`Reading it back`,
  };
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
  };
  return { phase, tag };
};
