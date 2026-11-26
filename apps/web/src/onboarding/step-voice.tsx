import { useLingui } from "@lingui/react/macro";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from "react";
import type { ReactNode } from "react";

import { prepare } from "../voice/voice.ts";
import { keptKey } from "./kept.ts";

// Stephen's lines on the setup's steps, fetched ahead (routes/setup.tsx):
// what he said as each step arrived is remembered in this browser, by
// account, language and step, so the next time through, the next step's
// lines are fetched while the step before is still open, and he starts the
// moment it does. A line said once is kept by core (speech-cache.ts), so
// fetching it again never asks the voice for it: only lines already said
// are fetched ahead, and they cost nothing. A line nobody has said yet is
// said as its step arrives, fetched from the moment the step opens.
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

/**
 * One step of the setup, with the next step's lines fetched ahead as it
 * opens, and what is said as it arrives remembered for the next time
 * through. Keyed by step, so each arrival remembers anew.
 */
export const StepVoice = ({
  userId,
  step,
  next,
  children,
}: {
  userId: string;
  step: string;
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
  return (
    <RememberLines.Provider value={remember}>{children}</RememberLines.Provider>
  );
};
