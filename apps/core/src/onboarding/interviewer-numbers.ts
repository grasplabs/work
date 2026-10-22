import type { InterviewPhase } from "@grasp-os/shared/interview-turn";
import {
  firstInterviewer,
  interviewers,
  interviewKinds,
  interviewLocales,
} from "@grasp-os/shared/onboarding";
import type { Interviewer } from "@grasp-os/shared/onboarding";
import type {
  StaffAnswerDay,
  StaffInterviewer,
  StaffInterviewers,
  StaffInterviewerText,
  StaffRating,
} from "@grasp-os/shared/onboarding-staff";

import { talkingMs } from "./rules.ts";
import type { AdminInterviewFacts } from "./store.ts";

// How Stephen and Claire are doing in this onboarding, for Grasp's staff
// (GRA-324), as the prototype's "How he is doing" counts it
// (grasplabs/prototype, packages/grasp: `stephenOf` in
// src/lib/onboarding-admin-record.ts), each apart, with the text each
// interview ran on; and how long people wait for his voice, by day
// (`tally` in src/lib/interview-telemetry.ts). From numbers the store
// keeps of each interview, never anything that was said, and nothing
// here names anyone. Pure, so tested on its own.

/** The steps interviews' lengths are counted in, in minutes: up to each, then everything longer. */
const lengthSteps = [10, 15, 20, 30];

const minuteMs = 60_000;

/** One interview, with who held it and the text it ran on. */
interface Held extends AdminInterviewFacts {
  by: Interviewer;
  text: { mark: string; locale: string } | null;
}

/** What `of` comes to on average over `over`; null over nothing. */
const averageOf = <T>(over: T[], of: (each: T) => number): number | null =>
  over.length === 0
    ? null
    : over.reduce((sum, each) => sum + of(each), 0) / over.length;

const ratingOf = (finished: Held[]): StaffRating => {
  const given = finished.flatMap(({ rating }) =>
    rating === null ? [] : [rating]
  );
  return {
    count: given.length,
    average: averageOf(given, (rating) => rating),
    by: [1, 2, 3, 4, 5].map(
      (rating) => given.filter((each) => each === rating).length
    ),
  };
};

/** How long a finished interview took, in minutes. */
const minutesOf = ({ startedAt, completedAt }: Held): number =>
  startedAt === null || completedAt === null
    ? 0
    : Math.max(0, (Date.parse(completedAt) - Date.parse(startedAt)) / minuteMs);

const isFinished = (one: Held): boolean => one.completedAt !== null;

/**
 * The interviews that ran on each text, the most first, and those from
 * before marks were kept last.
 */
const textsOf = (started: Held[]): StaffInterviewerText[] => {
  const by = new Map<string | null, Held[]>();
  for (const one of started) {
    const mark = one.text?.mark ?? null;
    by.set(mark, [...(by.get(mark) ?? []), one]);
  }
  return [...by]
    .map(([mark, theirs]): StaffInterviewerText => {
      const [first] = theirs;
      const finished = theirs.filter(isFinished);
      return {
        mark,
        kind: interviewKinds.find((kind) => kind === first?.kind) ?? null,
        locale:
          interviewLocales.find((locale) => locale === first?.text?.locale) ??
          null,
        started: theirs.length,
        finished: finished.length,
        rating: ratingOf(finished),
      };
    })
    .toSorted(
      (a, b) =>
        b.started - a.started ||
        Number(a.mark === null) - Number(b.mark === null)
    );
};

/** Where the interviews that stopped halfway stopped, by part. */
const stopsOf = (stopped: Held[]): Record<InterviewPhase, number> => {
  const stops: Record<InterviewPhase, number> = {
    open: 0,
    you: 0,
    anchor: 0,
    story: 0,
    steps: 0,
    exceptions: 0,
    numbers: 0,
    result: 0,
    readback: 0,
  };
  for (const { phase } of stopped) {
    if (phase !== null) {
      stops[phase] += 1;
    }
  }
  return stops;
};

/** How many finished interviews took how long, in `lengthSteps`. */
const lengthsOf = (finished: Held[]): StaffInterviewer["lengths"] =>
  [...lengthSteps, null].map((upTo, index) => {
    const from = index === 0 ? 0 : (lengthSteps[index - 1] ?? 0);
    return {
      upTo,
      count: finished.filter((one) => {
        const minutes = minutesOf(one);
        return (
          (index === 0 || minutes > from) && (upTo === null || minutes <= upTo)
        );
      }).length,
    };
  });

const interviewerOf = (
  by: Interviewer,
  all: Held[],
  now: number
): StaffInterviewer => {
  const started = all.filter((one) => one.by === by && one.startedAt !== null);
  const finished = started.filter(isFinished);
  // Someone talking now has stopped nowhere yet.
  const stopped = started.filter(
    (one) => !isFinished(one) && now - Date.parse(one.updatedAt) >= talkingMs
  );
  const own = finished.filter((one) => one.kind === "own");
  const written = own.reduce((sum, one) => sum + one.facts + one.out, 0);
  const kept = own.reduce((sum, one) => sum + one.facts, 0);
  return {
    interviewer: by,
    started: started.length,
    finished: finished.length,
    stopped: stopped.length,
    stops: stopsOf(stopped),
    rating: ratingOf(finished),
    minutes: {
      lead: averageOf(
        finished.filter((one) => one.kind === "lead"),
        minutesOf
      ),
      own: averageOf(own, minutesOf),
    },
    lengths: lengthsOf(finished),
    leftIn: written === 0 ? null : kept / written,
    byVoice: averageOf(finished, (one) => (one.typed ? 0 : 1)),
    texts: textsOf(started),
  };
};

/** Where answers come to a share of the way through, fastest first: 0.5 is the middle one. */
const atShare = (
  steps: { upTo: number; answers: number }[],
  total: number,
  share: number
): number => {
  const wanted = Math.max(1, Math.ceil(share * total));
  let seen = 0;
  for (const step of steps) {
    seen += step.answers;
    if (seen >= wanted) {
      return step.upTo;
    }
  }
  return steps.at(-1)?.upTo ?? 0;
};

/** How long people waited for his voice, day by day. */
const answerDays = (
  waits: { day: string; upTo: number; answers: number }[]
): StaffAnswerDay[] => {
  const days = new Map<string, { upTo: number; answers: number }[]>();
  for (const { day, upTo, answers } of waits) {
    days.set(day, [...(days.get(day) ?? []), { upTo, answers }]);
  }
  return [...days]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([day, steps]) => {
      const sorted = steps.toSorted((a, b) => a.upTo - b.upTo);
      const answers = sorted.reduce((sum, step) => sum + step.answers, 0);
      return {
        day,
        answers,
        middle: atShare(sorted, answers, 0.5),
        slow: atShare(sorted, answers, 0.9),
      };
    });
};

/** How Stephen and Claire are doing at `now`, from what the store keeps. */
export const interviewerNumbers = (
  facts: {
    interviews: AdminInterviewFacts[];
    texts: {
      person: string;
      mark: string;
      interviewer: string;
      locale: string;
    }[];
    waits: { day: string; upTo: number; answers: number }[];
  },
  now: string
): StaffInterviewers => {
  const texts = new Map(facts.texts.map((text) => [text.person, text]));
  const held = facts.interviews.map((one): Held => {
    const text = texts.get(one.person);
    // Who they chose, as their page said; else whose the text was.
    const by =
      one.interviewer ??
      interviewers.find((each) => each === text?.interviewer) ??
      firstInterviewer;
    return {
      ...one,
      by,
      text:
        text === undefined ? null : { mark: text.mark, locale: text.locale },
    };
  });
  const at = Date.parse(now);
  return {
    interviewers: interviewers.map((by) => interviewerOf(by, held, at)),
    answers: answerDays(facts.waits),
  };
};
