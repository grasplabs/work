import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { useNewestError } from "../frame/top-error.tsx";
import { prepare, speak } from "../voice/voice.ts";
import { keptKey } from "./kept.ts";

// Stephen on the setup's steps, as one conversation (Ruben: "react on what
// i clicked previously so it feels continuously smooth and interactive").
//
// As a step arrives he first answers how the step before was left, the
// choice made there ("Our own system it is."), then says the step. While
// on a step he answers what just happened on it: files dropped in, someone
// marked as a lead, the message copied, something that went wrong. Each of
// those is one of a few fixed lines, never words of the admin's own, so
// each is made by the voice once and kept by core (speech-cache.ts): it is
// fetched ahead the moment the choice is made, and starts at once. An
// answer waits for a natural break in what he is saying, a newer one
// stands in for one not yet said, and one comes too soon after the last
// is left out, so they never pile up or talk over each other. An error
// itself is only ever told in the bar at the top (top-error.tsx); he says
// no more than that something went wrong and where to look.
//
// What he said as each step arrived is remembered in this browser, by
// account, language and step, so the next time through, the next step's
// lines are fetched while the step before is still open, and he starts the
// moment it does. A line said once is kept by core, so fetching it again
// never asks the voice for it: only lines already said are fetched ahead,
// and they cost nothing. A line nobody has said yet is said as its step
// arrives, fetched from the moment the step opens.
//
// Kept with the rest of the setup in this browser (kept.ts): its words may
// hold the admin's name and the company's numbers, so it is forgotten with
// it, when the session ends, they sign out, or start over.

/** Where this browser keeps the lines said on `userId`'s steps: under the setup's own prefix, so forgotten with it. */
const linesKey = (userId: string): string => keptKey(`lines.${userId}`);

/** The lines said on each step, by language and step. */
type Lines = Record<string, string[]>;

/** Most lines remembered for one step: the plan's story is six. */
const mostLines = 8;

const placeOf = (language: string, step: string): string =>
  `${language}|${step}`;

const read = (userId: string): Lines => {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(linesKey(userId)) ?? "{}"
    );
    if (typeof stored !== "object" || stored === null) {
      return {};
    }
    const lines: Lines = {};
    for (const [place, said] of Object.entries(stored)) {
      if (Array.isArray(said)) {
        lines[place] = said.filter(
          (line): line is string => typeof line === "string"
        );
      }
    }
    return lines;
  } catch {
    return {};
  }
};

const write = (userId: string, lines: Lines): void => {
  try {
    localStorage.setItem(linesKey(userId), JSON.stringify(lines));
  } catch {
    // Storage refused: the lines are fetched as their steps arrive.
  }
};

/** Tells what Stephen said as the step arrived. */
type Remember = (said: readonly string[]) => void;

const RememberLines = createContext<Remember | undefined>(undefined);

/**
 * Where the lines said on a step are remembered: once per arrival, the
 * first said as it arrives, so a line said later on the step (an answer to
 * something done) doesn't stand for it.
 */
export const useRememberLines = (): Remember | undefined =>
  useContext(RememberLines);

/** How a step was left, as its own line for Stephen to say as the next arrives. */
let leftAs: { step: string; line: MessageDescriptor | null } | null = null;

/** When Stephen last answered something done, on the page's clock, and with what. */
let answeredAt = Number.NEGATIVE_INFINITY;
let answered = "";

/** An answer this soon after the last is left out: one at a time, never a pile. */
const answerGapMs = 2500;
/** The same answer twice, this soon, is said once: an error put up again, a click twice. */
const sameAnswerGapMs = 4500;
/** How long after a step opens a choice made on the step before is still worth answering. */
const arrivalMs = 3000;
/** A choice is fetched ahead once it has stood this long: one clicked through isn't asked for. */
const aheadMs = 900;

/**
 * Stephen answers something just done, at the next natural break in what
 * he is saying. Left out when he answered a moment ago, unless `always`
 * (something went wrong): never two answers on top of each other.
 */
const answer = (line: string, always: boolean): void => {
  const now = performance.now();
  if (line === answered && now - answeredAt < sameAnswerGapMs) {
    return;
  }
  if (!always && now - answeredAt < answerGapMs) {
    return;
  }
  answeredAt = now;
  answered = line;
  speak(line, { soon: true });
};

/** Whether Stephen answered something a moment ago: a step arriving then waits for him to finish. */
export const answeredLately = (): boolean =>
  performance.now() - answeredAt < answerGapMs;

/** What Stephen says when the bar at the top tells of something gone wrong: in turn, so twice isn't word for word. */
const wentWrong = [
  msg`Hmm, that didn’t work. What happened is at the top.`,
  msg`Something went wrong there. The bar at the top says what to do.`,
];
let wrongTurn = 0;
/** The newest error he answered, so a step drawn again doesn't answer it twice. */
let heardError = 0;

/** What a step tells Stephen besides its own line. */
interface Talk {
  /** The step, by name. */
  step: string;
  /** What Stephen says first as the step arrives, of how the step before was left; once, and only right as it arrives. */
  arriving: () => string | null;
}

const StepTalk = createContext<Talk | null>(null);

/** What CalmStep needs to say a step's line in turn. */
export const useStepTalk = (): Talk | null => useContext(StepTalk);

/**
 * How this step is left, for Stephen to say first as the next step
 * arrives: one of the step's fixed lines, by what was chosen on it; none
 * where there is nothing to answer. Fetched ahead once it has stood a
 * moment, so it starts at once.
 */
export const useLeaving = (line: MessageDescriptor | null): void => {
  const { i18n } = useLingui();
  const talk = useStepTalk();
  const step = talk?.step;
  useEffect(() => {
    if (step !== undefined) {
      leftAs = { step, line };
    }
    const id =
      step === undefined || line === null
        ? undefined
        : window.setTimeout(() => {
            prepare(i18n._(line));
          }, aheadMs);
    return () => {
      window.clearTimeout(id);
    };
  }, [step, line, i18n]);
};

/**
 * How a step has Stephen answer what was just done on it: `answer(line)`
 * says one of its fixed lines at his next natural break; `always` for
 * something that went wrong, said even right after another answer.
 * `ahead` are the lines the step may answer with, fetched once the step's
 * own line is on its way, so an answer starts at once.
 */
export const useAnswer = (
  ahead: readonly MessageDescriptor[] = []
): ((line: MessageDescriptor, always?: boolean) => void) => {
  const { i18n } = useLingui();
  // The lines in the page's language, one per row: fetched again only when those change.
  const texts = ahead.map((line) => i18n._(line)).join("\n");
  useEffect(() => {
    const id = window.setTimeout(() => {
      for (const text of texts.split("\n")) {
        prepare(text);
      }
    }, aheadMs * 2);
    return () => {
      window.clearTimeout(id);
    };
  }, [texts]);
  return useCallback(
    (line: MessageDescriptor, always = false) => {
      answer(i18n._(line), always);
    },
    [i18n]
  );
};

/**
 * One step of the setup, with the next step's lines fetched ahead as it
 * opens, and what is said as it arrives remembered for the next time
 * through. Keyed by step, so each arrival remembers anew. Stephen answers
 * the choice made on `previous` as it arrives, when the admin came on from
 * there, and anything that goes wrong on the step, as the bar shows it.
 */
export const StepVoice = ({
  userId,
  step,
  previous,
  next,
  children,
}: {
  userId: string;
  step: string;
  /** The step before it, whose choice is answered as it arrives; none before the first. */
  previous: string | undefined;
  /** The step after it, whose lines are fetched ahead; none after the last. */
  next: string | undefined;
  children: ReactNode;
}) => {
  const { i18n } = useLingui();
  const language = i18n.locale;
  const remembered = useRef(false);
  useEffect(() => {
    if (next === undefined) {
      return;
    }
    for (const line of read(userId)[placeOf(language, next)] ?? []) {
      prepare(line);
    }
  }, [userId, language, next]);
  // One function for the step's whole stay, as the context's value (the lint asks for it).
  const remember = useCallback<Remember>(
    (said) => {
      if (remembered.current || said.length === 0) {
        return;
      }
      remembered.current = true;
      const lines = read(userId);
      lines[placeOf(language, step)] = said.slice(0, mostLines);
      write(userId, lines);
    },
    [userId, language, step]
  );
  // How the step before was left, read as this one opens (before the step's own sets it anew):
  // only when the admin came on from it. Given once, it's gone.
  const [cameFrom, setCameFrom] = useState(() =>
    leftAs !== null && previous !== undefined && leftAs.step === previous
      ? leftAs.line
      : null
  );
  const openedAt = useRef(Number.POSITIVE_INFINITY);
  useEffect(() => {
    openedAt.current = performance.now();
  }, []);
  const talk = useMemo<Talk>(
    () => ({
      step,
      arriving: () => {
        if (
          cameFrom === null ||
          performance.now() - openedAt.current > arrivalMs
        ) {
          return null;
        }
        setCameFrom(null);
        return i18n._(cameFrom);
      },
    }),
    [step, cameFrom, i18n]
  );
  // What he says when something goes wrong, fetched ahead once this step's own lines are on their way.
  const wrongTexts = wentWrong.map((line) => i18n._(line)).join("\n");
  useEffect(() => {
    const id = window.setTimeout(() => {
      for (const text of wrongTexts.split("\n")) {
        prepare(text);
      }
    }, aheadMs * 3);
    return () => {
      window.clearTimeout(id);
    };
  }, [wrongTexts]);
  // Something went wrong, as the bar at the top shows it: he says so, and where to look.
  const newestError = useNewestError();
  useEffect(() => {
    if (newestError <= heardError) {
      return;
    }
    heardError = newestError;
    const line = wentWrong[wrongTurn % wentWrong.length];
    wrongTurn += 1;
    if (line !== undefined) {
      answer(i18n._(line), true);
    }
  }, [newestError, i18n]);
  return (
    <StepTalk.Provider value={talk}>
      <RememberLines.Provider value={remember}>
        {children}
      </RememberLines.Provider>
    </StepTalk.Provider>
  );
};
