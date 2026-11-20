import { isAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { useMatch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { useComposerMicrophone } from "../grasp/composer/index.ts";
import type {
  ComposerProps,
  ComposerVoicePhase,
  ComposerVoiceProblem,
  ComposerVoiceWords,
} from "../grasp/composer/index.ts";
import { useComposerWords } from "../grasp/composer/words.ts";
import { isLocale } from "../i18n.ts";
import { sourceFor, useCanDictate } from "./dictation.ts";
import type { DictationSource } from "./dictation.ts";

// Dictation in the chat's box (chat-composer.tsx), as Grasp UI's Composer
// draws it: the microphone in its footer starts it, and while it runs the
// box shows what is heard, settled and still being heard, until Done puts
// it after what was typed. Its words come from `sourceFor` (dictation.ts).
// The browser's recognition sends the sound to the browser's maker: the
// first time a person dictates with it, the box says so while it asks for
// the microphone, before anything is heard.

/** Where a dictation stands, as the Composer draws it. */
interface Run {
  phase: ComposerVoicePhase;
  settled: string;
  interim: string;
  startedAt: number;
  muted: boolean;
  problem?: ComposerVoiceProblem;
  /** Says, while it asks, that the sound goes to the browser's maker. */
  telling: boolean;
  /** This deployment has no live transcription: said in place of a failure. */
  unavailable?: boolean;
}

/** How long the first-time sentence stands before listening starts, in ms. */
const tellingMs = 3500;

const toldKey = (userId: string): string => `grasp-dictation-told:${userId}`;

/** Whether `userId` was told, in this browser, where the browser's recognition sends the sound. */
const told = (userId: string): boolean => {
  try {
    return localStorage.getItem(toldKey(userId)) !== null;
  } catch {
    return false;
  }
};

const keepTold = (userId: string): void => {
  try {
    localStorage.setItem(toldKey(userId), "1");
  } catch {
    // Storage blocked: they are told again next time.
  }
};

/**
 * What this dictation says beyond the parts' catalogue (frame/part-words.tsx),
 * which has the rest: who writes it down, the first time, and that this
 * deployment has no transcription, in place of a browser that can't.
 */
const useWords = (
  telling: boolean,
  unavailable: boolean
): Partial<ComposerVoiceWords> => {
  const { t } = useLingui();
  const { problems } = useComposerWords("voice");
  return {
    ...(telling
      ? { asking: t`Your browser's maker writes down what you say.` }
      : {}),
    ...(unavailable
      ? {
          problems: {
            ...problems,
            unsupported: t`Dictation isn't set up here yet. What you typed is kept.`,
          },
        }
      : {}),
  };
};

/**
 * Dictation for the chat's box: the Composer's `onDictate` and, while one
 * runs, its `dictation`. `text` is what is typed; `onText` takes it back
 * with the dictated words after it.
 */
export const useDictation = (
  text: string,
  onText: (text: string) => void
): Pick<ComposerProps, "onDictate" | "dictation" | "dictateLabel"> => {
  const { t, i18n } = useLingui();
  // A guest's chat is outside the shell: nobody to dictate for.
  const identity = useMatch({ from: "/_shell", shouldThrow: false })?.context
    .identity;
  // No microphone where dictation can't work: a browser without
  // recognition, or core's transcription not set up.
  const possible = useCanDictate(
    identity !== undefined && isAdmin(identity.role)
  );
  const microphone = useComposerMicrophone();
  const [run, setRun] = useState<Run>();
  const [now, setNow] = useState(0);
  const source = useRef<DictationSource | null>(null);
  // A box that goes away mid-dictation lets its source go: no microphone,
  // line or recognition carries on with nothing on screen.
  useEffect(
    () => () => {
      source.current?.cancel();
      source.current = null;
    },
    []
  );
  const words = useWords(run?.telling ?? false, run?.unavailable === true);
  // The time it has listened, a second at a time.
  const running = run !== undefined && run.phase === "listening";
  useEffect(() => {
    if (!running) {
      return () => {
        // Not listening.
      };
    }
    const ticking = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(ticking);
    };
  }, [running]);
  const locale = isLocale(i18n.locale) ? i18n.locale : "en";
  const listen = (): void => {
    if (identity === undefined) {
      return;
    }
    const chosen = sourceFor(isAdmin(identity.role), locale);
    if (chosen === undefined) {
      return;
    }
    const at = Date.now();
    setNow(at);
    source.current = chosen;
    const telling = chosen.outside && !told(identity.userId);
    setRun({
      phase: "asking",
      settled: "",
      interim: "",
      startedAt: at,
      muted: false,
      telling,
    });
    // What a source says once it is no longer the box's (cancelled, or
    // another dictation begun) is not heard, and it never starts late.
    const current = (): boolean => source.current === chosen;
    // A problem stopped it while it still stands in its band.
    let stopped = false;
    // What it has heard so far, settled or not.
    let heardSoFar = "";
    const begin = (): void => {
      if (!current()) {
        return;
      }
      if (telling) {
        keepTold(identity.userId);
        // Told: now it asks for the microphone, as it says.
        setRun((was) => (was === undefined ? was : { ...was, telling: false }));
      }
      void (async () => {
        await microphone.start();
        // Put away, or stopped by a problem, while the browser still asked:
        // the microphone it gave goes at once. A newer dictation keeps its own.
        if (source.current === null || (current() && stopped)) {
          microphone.stop();
        }
      })();
      chosen.start({
        ready: () => {
          if (!current()) {
            return;
          }
          setRun((was) =>
            was === undefined
              ? was
              : {
                  ...was,
                  phase: "listening",
                  telling: false,
                  startedAt: Date.now(),
                }
          );
        },
        heard: ({ settled, interim }) => {
          if (!current()) {
            return;
          }
          heardSoFar = [settled, interim]
            .filter((part) => part !== "")
            .join(" ");
          setRun((was) =>
            was === undefined ? was : { ...was, settled, interim }
          );
        },
        problem: (problem, unavailable = false) => {
          if (!current()) {
            return;
          }
          if (problem === "unheard") {
            setRun((was) => (was === undefined ? was : { ...was, problem }));
            return;
          }
          // A problem that stops it lets the microphone go at once: the
          // band stands over a box that takes text again, and the browser
          // would otherwise go on showing it recording.
          stopped = true;
          chosen.cancel();
          microphone.stop();
          // What it heard before it stopped goes in after what was typed,
          // as Done would put it.
          if (heardSoFar !== "") {
            onText(
              [text.trimEnd(), heardSoFar]
                .filter((part) => part !== "")
                .join(" ")
            );
          }
          setRun((was) =>
            was === undefined
              ? was
              : {
                  ...was,
                  phase: "problem",
                  // Not set up here: no use trying again, as the band says
                  // for a browser that can't dictate.
                  problem: unavailable ? "unsupported" : problem,
                  unavailable,
                }
          );
        },
      });
    };
    if (telling) {
      window.setTimeout(begin, tellingMs);
    } else {
      begin();
    }
  };
  const stop = (): void => {
    microphone.stop();
    source.current = null;
    setRun(undefined);
  };
  // One that ran into it still says why, until it is put away.
  if (identity === undefined || (!possible && run === undefined)) {
    return {};
  }
  return {
    // No microphone beside a band saying dictation can't work here.
    ...(possible ? { dictateLabel: t`Dictate`, onDictate: listen } : {}),
    ...(run === undefined
      ? {}
      : {
          dictation: {
            phase: run.phase,
            settled: run.settled,
            interim: run.interim,
            elapsedMs: Math.max(0, now - run.startedAt),
            muted: run.muted,
            ...(run.problem === undefined ? {} : { problem: run.problem }),
            sample: microphone.sample,
            words,
            onDone: () => {
              const chosen = source.current;
              setRun((was) =>
                was === undefined ? was : { ...was, phase: "thinking" }
              );
              void (async () => {
                const said = (await chosen?.finish()) ?? "";
                // Cancelled while it was written down: nothing goes in.
                if (chosen === null || source.current !== chosen) {
                  return;
                }
                stop();
                if (said !== "") {
                  onText(
                    [text.trimEnd(), said]
                      .filter((part) => part !== "")
                      .join(" ")
                  );
                }
              })();
            },
            onCancel: () => {
              source.current?.cancel();
              stop();
            },
            onMute: () => {
              const muted = !run.muted;
              source.current?.mute(muted);
              setRun({ ...run, muted });
            },
            onRetry: () => {
              source.current?.cancel();
              stop();
              listen();
            },
          },
        }),
  };
};
