import { Button } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { GraspMark } from "../grasp-mark.tsx";
import { LanguageButton } from "../language-picker.tsx";
import { SoundControls } from "../voice/sound-controls.tsx";
import { KnowledgeCorner } from "./knowledge-bar.tsx";
import type { Knowledge } from "./knowledge-bar.tsx";
import { stepIndex, steps, waysFrom, wizardSteps } from "./setup.ts";
import type { SetupStep } from "./setup.ts";
import { wasHeard } from "./visit.ts";

// The frame of every onboarding screen (prototype
// `components/onboarding/onboarding-frame.tsx`), with as little as possible
// around the step: from the third step, what Grasp knows of the
// organization, top centre, and from the second a way back a step, top
// left, in the same row, with a way on beside it as far as you have been;
// one centred column; where you are, bottom centre;
// bottom right, pause and the sound, with the language before them on
// every step after the first, where it is chosen. The dots go back, and
// forward again as far as you have been; so do the arrow keys and the
// arrows at the top (setup.ts `waysFrom`); Escape
// leaves. After the wizard, a word says where things stand. The frame is
// as high as the window and the page never scrolls, so the way on is
// always in sight.

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
  open,
  onGo,
}: {
  index: number;
  /** Whether the step at a place can be gone to. */
  open: (at: number) => boolean;
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
            disabled={!open(at)}
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

/**
 * Something around a step that turns up with it, such as the way back or
 * the brain: it comes in (`motion`), unless it turns up on a step finished
 * before (`settled`), as it was then. Decided as it turns up, so it never
 * comes in again while it stays.
 */
export const Arriving = ({
  settled,
  className = "min-w-0",
  motion = "animate-in fade-in duration-500",
  children,
}: {
  settled: boolean;
  className?: string;
  /** How it comes in. */
  motion?: string;
  children: ReactNode;
}) => {
  // oxlint-disable-next-line react/hook-use-state -- as it was on arrival, never set
  const [still] = useState(settled);
  return <span className={cn(className, !still && motion)}>{children}</span>;
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
  const { back, on, open } = waysFrom(index, reached);
  // Back on a step finished before, what turns up around it is there at once, too.
  const settled = wasHeard(step);

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
    <div className="bg-background flex h-svh flex-col overflow-hidden text-sm">
      {/* The ways back and on a step on the left, and how much Grasp knows of the organization in the middle, in one row. */}
      <header className="setup-header grid h-18 flex-none items-center px-4 sm:px-10">
        <nav
          aria-label={t`Back and forward`}
          className="flex items-center gap-1"
        >
          {back === undefined ? null : (
            <Arriving settled={settled}>
              <Button
                onClick={() => {
                  onGo(back);
                }}
                size="sm"
                variant="ghost"
              >
                <ArrowLeftIcon data-icon="inline-start" />
                {t`Back`}
              </Button>
            </Arriving>
          )}
          {/* On only as far as they have been: on the furthest step there is nowhere further to go. */}
          {on === undefined ? null : (
            <Arriving settled={settled}>
              <Button
                onClick={() => {
                  onGo(on);
                }}
                size="sm"
                variant="ghost"
              >
                {t`Forward`}
                <ArrowRightIcon data-icon="inline-end" />
              </Button>
            </Arriving>
          )}
        </nav>
        {index >= stepIndex("company") ? (
          <Arriving settled={settled}>
            <KnowledgeCorner {...knowledge} />
          </Arriving>
        ) : (
          <span />
        )}
      </header>
      {/* A step fits between the two rows, a long list scrolling in its own panel; only where a window is too small even for that, on a phone, does the step scroll between them. */}
      <main className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 py-2">
        <div className="my-auto flex w-full justify-center">{children}</div>
      </main>
      <footer className="bg-background setup-footer grid h-18 flex-none items-center px-4 sm:px-10">
        {/* The mark bottom left, across from the language. */}
        <GraspMark className="text-foreground size-5" />
        <nav aria-label={t`Onboarding steps`} className="flex items-center">
          {word === undefined ? (
            <StepDots index={index} onGo={onGo} open={open} />
          ) : (
            <span
              className="text-muted-foreground animate-in fade-in slide-in-from-bottom-1 duration-200"
              key={word}
            >
              {word}
            </span>
          )}
        </nav>
        {/* The language, once chosen, then pause and the sound. */}
        <div className="flex items-center justify-end gap-1">
          {step === "welcome" ? null : (
            <span className="animate-in fade-in duration-500">
              <LanguageButton />
            </span>
          )}
          <SoundControls />
        </div>
      </footer>
    </div>
  );
};
