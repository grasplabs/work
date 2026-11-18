import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { StyleXStyles } from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "../grasp/button/index.ts";
import { iconVars } from "../grasp/icons/icon.stylex.ts";
import {
  ArrowLeft,
  ArrowRight,
  BrandGrasp,
  Icon,
} from "../grasp/icons/index.ts";
import { Stepper } from "../grasp/stepper/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { LanguageButton } from "../language-picker.tsx";
import { SoundControls } from "../voice/sound-controls.tsx";
import { KnowledgeCorner } from "./knowledge-bar.tsx";
import type { Knowledge } from "./knowledge-bar.tsx";
import { comeIn, motion } from "./motion.ts";
import { stepIndex, waysFrom, wizardOf } from "./setup.ts";
import type { SetupPath, SetupStep } from "./setup.ts";
import { wasHeard } from "./visit.ts";

// The frame of every onboarding screen (prototype
// `components/onboarding/onboarding-frame.tsx`), with as little as possible
// around the step: from the third step, what Grasp knows of the
// organization, top centre, and from the second a way back a step, top
// left, in the same row, with a way on beside it as far as you have been;
// one centred column; where you are, bottom centre;
// bottom right, pause and the sound, with the language before them on
// every step after the first, where it is chosen. The steps go back
// (the library's Stepper); so do the arrow keys and the arrows at the top,
// and those go on as far as you have been (setup.ts `waysFrom`); Escape
// leaves. After the wizard, a word says where things stand. The frame is
// as high as the window and the page never scrolls, so the way on is
// always in sight.

/** The head's and the foot's height. */
const BAR = "4.5rem";

const styles = stylex.create({
  window: {
    display: "flex",
    flexDirection: "column",
    height: "100svh",
    overflow: "hidden",
    backgroundColor: grasp.paper,
    color: grasp.text,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
  // The way back and on at the start, what Grasp knows in the middle, and the end kept as wide as the start.
  bar: {
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    columnGap: grasp.space2,
    flexShrink: 0,
    height: BAR,
    paddingInline: { default: grasp.space10, [media.belowPhone]: grasp.space4 },
    backgroundColor: grasp.paper,
  },
  ways: { display: "flex", alignItems: "center", gap: grasp.space1 },
  main: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    alignItems: "center",
    minHeight: 0,
    overflowY: "auto",
    paddingInline: grasp.space4,
    paddingBlock: grasp.space2,
  },
  column: {
    display: "flex",
    justifyContent: "center",
    width: "100%",
    marginBlock: "auto",
  },
  mark: { display: "flex", [iconVars.size]: grasp.iconMd },
  where: { display: "flex", alignItems: "center", justifyContent: "center" },
  end: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: grasp.space1,
  },
});

const arrivingStyles = stylex.create({ base: { minWidth: 0 } });

/** The steps of the wizard, each named, a way back to those done. */
const StepDots = ({
  index,
  path,
  onGo,
}: {
  index: number;
  /** The screens this company's admin goes through. */
  path: SetupPath;
  onGo: (step: SetupStep) => void;
}) => {
  const { t } = useLingui();
  const names: Record<SetupStep, string> = {
    welcome: t`Welcome`,
    ai: t`AI`,
    about: t`How it works`,
    company: t`Company`,
    sources: t`Sources`,
    documents: t`Documents`,
    pulse: t`Tools`,
    leads: t`Leads`,
    team: t`Team`,
    listening: t`Interviews`,
    review: t`Review`,
    open: t`Open`,
  };
  const wizard = wizardOf(path);
  return (
    <Stepper
      aria-label={t`Onboarding steps`}
      onValueChange={(at) => {
        const step = wizard[at];
        if (step !== undefined) {
          onGo(step);
        }
      }}
      steps={wizard.map((step) => ({ label: names[step] }))}
      value={index}
      variant="light"
    />
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
  layout,
  motion: comesIn = motion.fade,
  children,
}: {
  settled: boolean;
  /** Where it stands. */
  layout?: StyleXStyles;
  /** How it comes in. */
  motion?: StyleXStyles;
  children: ReactNode;
}) => {
  // oxlint-disable-next-line react/hook-use-state -- as it was on arrival, never set
  const [still] = useState(settled);
  return (
    <span {...comeIn(!still, comesIn, arrivingStyles.base, layout)}>
      {children}
    </span>
  );
};

/** The screens before Grasp knows anything of the company, where how much it knows isn't shown. */
const beforeKnowing: ReadonlySet<SetupStep> = new Set([
  "welcome",
  "ai",
  "about",
]);

export const SetupFrame = ({
  step,
  path,
  reached,
  knowledge,
  onGo,
  onExit,
  children,
}: {
  step: SetupStep;
  /** The screens this company's admin goes through, in order. */
  path: SetupPath;
  reached: number;
  knowledge: Knowledge;
  onGo: (step: SetupStep) => void;
  onExit: () => void;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const index = stepIndex(step, path);
  const words: Partial<Record<SetupStep, string>> = {
    listening: t`Talking to your team`,
    review: t`Almost there`,
    open: t`Ready`,
  };
  const word = words[step];
  const { back, on } = waysFrom(index, reached, path);
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
    <div {...stylex.props(styles.window)}>
      {/* The ways back and on a step on the left, and how much Grasp knows of the organization in the middle, in one row. */}
      <header {...stylex.props(styles.bar)}>
        <nav aria-label={t`Back and forward`} {...stylex.props(styles.ways)}>
          {back === undefined ? null : (
            <Arriving settled={settled}>
              <Button
                icon={ArrowLeft}
                onClick={() => {
                  onGo(back);
                }}
                size="sm"
                variant="ghost"
              >
                {t`Back`}
              </Button>
            </Arriving>
          )}
          {/* On only as far as they have been: on the furthest step there is nowhere further to go. */}
          {on === undefined ? null : (
            <Arriving settled={settled}>
              <Button
                iconEnd={ArrowRight}
                onClick={() => {
                  onGo(on);
                }}
                size="sm"
                variant="ghost"
              >
                {t`Forward`}
              </Button>
            </Arriving>
          )}
        </nav>
        {beforeKnowing.has(step) ? (
          <span />
        ) : (
          <Arriving settled={settled}>
            <KnowledgeCorner {...knowledge} />
          </Arriving>
        )}
      </header>
      {/* A step fits between the two rows, a long list scrolling in its own panel; only where a window is too small even for that, on a phone, does the step scroll between them. */}
      <main {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.column)}>{children}</div>
      </main>
      <footer {...stylex.props(styles.bar)}>
        {/* The mark bottom left, across from the language. */}
        <span {...stylex.props(styles.mark)}>
          <Icon icon={BrandGrasp} label="Grasp" />
        </span>
        <div {...stylex.props(styles.where)}>
          {word === undefined ? (
            <StepDots index={index} onGo={onGo} path={path} />
          ) : (
            <span key={word} {...stylex.props(motion.rise)}>
              <Text element="span" size="sm" tone="muted">
                {word}
              </Text>
            </span>
          )}
        </div>
        {/* The language, once chosen, then pause and the sound. */}
        <div {...stylex.props(styles.end)}>
          {step === "welcome" ? null : (
            <span {...stylex.props(motion.fade)}>
              <LanguageButton />
            </span>
          )}
          <SoundControls />
        </div>
      </footer>
    </div>
  );
};
