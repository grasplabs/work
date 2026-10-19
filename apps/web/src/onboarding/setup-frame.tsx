import { useLingui } from "@lingui/react/macro";
import { useEffect } from "react";
import type { ReactNode } from "react";

import { GraspMark } from "../grasp-mark.tsx";
import { LanguageButton } from "../language-picker.tsx";
import { KnowledgeCorner } from "./knowledge-bar.tsx";
import type { Knowledge } from "./knowledge-bar.tsx";
import { stepIndex, steps, wizardSteps } from "./setup.ts";
import type { SetupStep } from "./setup.ts";

// The frame of every onboarding screen (prototype
// `components/onboarding/onboarding-frame.tsx`), with as little as possible
// around the step: from the third step, what Grasp knows, top centre; one
// centred column; where you are, bottom centre; the language bottom right
// on every step after the first, where it is chosen. The dots go back, and
// forward again as far as you have been; so do the arrow keys; Escape
// leaves. After the wizard, a word says where things stand.

const dotClass = {
  current:
    "bg-foreground block h-1.5 w-5 rounded-full transition-all duration-300",
  done: "bg-foreground block h-1.5 w-1.5 rounded-full transition-all duration-300",
  later: "bg-border block h-1.5 w-1.5 rounded-full transition-all duration-300",
} as const;

const dotOf = (at: number, index: number): string => {
  if (at === index) {
    return dotClass.current;
  }
  return at < index ? dotClass.done : dotClass.later;
};

/** The dots for the wizard's steps, each a way back, and on as far as you have been. */
const StepDots = ({
  index,
  reached,
  onGo,
}: {
  index: number;
  reached: number;
  onGo: (step: SetupStep) => void;
}) => {
  const { t } = useLingui();
  return (
    <span className="animate-in fade-in flex items-center">
      {steps.slice(0, wizardSteps).map((each, at) => {
        const n = at + 1;
        return (
          <button
            aria-current={at === index ? "step" : undefined}
            aria-label={t`Step ${n}`}
            className="focus-visible:ring-ring/50 flex h-6 items-center rounded-full px-0.75 outline-none focus-visible:ring-3 disabled:cursor-default"
            disabled={at > reached}
            key={each}
            onClick={() => {
              onGo(each);
            }}
            type="button"
          >
            <span className={dotOf(at, index)} />
          </button>
        );
      })}
    </span>
  );
};

export const SetupFrame = ({
  step,
  reached,
  knowledge,
  onGo,
  onExit,
  children,
}: {
  step: SetupStep;
  reached: number;
  knowledge: Knowledge;
  onGo: (step: SetupStep) => void;
  onExit: () => void;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const index = stepIndex(step);
  const words: Partial<Record<SetupStep, string>> = {
    listening: t`Talking to your team`,
    review: t`Almost there`,
    open: t`Ready`,
  };
  const word = words[step];

  // With nothing on screen to leave by, Escape does it, unless something open is closing on it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { target } = event;
      const inside =
        target instanceof Element &&
        target.closest('[role="menu"], [role="dialog"], input, textarea') !==
          null;
      if (event.key === "Escape" && !event.defaultPrevented && !inside) {
        onExit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onExit]);

  return (
    <div className="bg-background flex min-h-svh flex-col text-sm">
      {/* Nothing up here but how much Grasp knows, in the middle. */}
      <header className="flex h-18 flex-none items-center justify-center px-4 sm:px-10">
        {index >= stepIndex("company") ? (
          <KnowledgeCorner {...knowledge} />
        ) : null}
      </header>
      <main className="flex flex-1 flex-col items-center px-4 py-2">
        <div className="my-auto flex w-full justify-center">{children}</div>
      </main>
      <footer className="bg-background setup-footer sticky bottom-0 grid h-18 flex-none items-center px-4 sm:px-10">
        {/* The mark bottom left, across from the language. */}
        <GraspMark className="text-foreground size-5" />
        <nav aria-label={t`Onboarding steps`} className="flex items-center">
          {word === undefined ? (
            <StepDots index={index} onGo={onGo} reached={reached} />
          ) : (
            <span
              className="text-muted-foreground animate-in fade-in slide-in-from-bottom-1 duration-200"
              key={word}
            >
              {word}
            </span>
          )}
        </nav>
        {/* The language, once chosen. */}
        <div className="flex items-center justify-end gap-1">
          {step === "welcome" ? null : (
            <span className="animate-in fade-in duration-500">
              <LanguageButton />
            </span>
          )}
        </div>
      </footer>
    </div>
  );
};
