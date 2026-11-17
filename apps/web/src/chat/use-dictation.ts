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
import { isLocale } from "../i18n.ts";
import { sourceFor } from "./dictation.ts";
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

/** What the dictation says, in the page's language. */
const useWords = (telling: boolean): Partial<ComposerVoiceWords> => {
  const { t } = useLingui();
  return {
    asking: telling
      ? t`Your browser's maker writes down what you say.`
      : t`Asking for the microphone`,
    listening: t`Listening`,
    thinking: t`Writing it down`,
    silent: t`Paused`,
    muted: t`Muted`,
    done: t`Done`,
    cancel: t`Cancel`,
    mute: t`Mute`,
    unmute: t`Unmute`,
    retry: t`Try again`,
    level: t`Level`,
    problems: {
      blocked: t`The microphone is blocked for this site.`,
      missing: t`No microphone was found.`,
      unsupported: t`This browser can't dictate.`,
      unheard: t`A part couldn't be made out. What came before is kept.`,
      failed: t`The words couldn't be written down. What you typed is kept.`,
      limited: t`That's as long as one dictation can be.`,
    },
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
  const microphone = useComposerMicrophone();
  const [run, setRun] = useState<Run>();
  const [now, setNow] = useState(0);
  const source = useRef<DictationSource | null>(null);
  const words = useWords(run?.telling ?? false);
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
    const at = Date.now();
    setNow(at);
    if (chosen === undefined) {
      setRun({
        phase: "problem",
        problem: "unsupported",
        settled: "",
        interim: "",
        startedAt: at,
        muted: false,
        telling: false,
      });
      return;
    }
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
    const begin = (): void => {
      if (telling) {
        keepTold(identity.userId);
      }
      void microphone.start();
      chosen.start({
        ready: () => {
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
          setRun((was) =>
            was === undefined ? was : { ...was, settled, interim }
          );
        },
        problem: (problem) => {
          setRun((was) => {
            if (was === undefined) {
              return was;
            }
            return problem === "unheard"
              ? { ...was, problem }
              : { ...was, phase: "problem", problem };
          });
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
  if (identity === undefined) {
    return {};
  }
  return {
    dictateLabel: t`Dictate`,
    onDictate: listen,
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
