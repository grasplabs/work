import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@grasp-os/ui/components/alert-dialog";
import { Button } from "@grasp-os/ui/components/button";
import { Stepper } from "@grasp-os/ui/components/stepper";
import { Icon, LogOutIcon } from "@grasp-os/ui/lib/icons";
import { media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { GraspLogo } from "../../connections/brand-logos.ts";
import { signOut } from "../../core-connection.ts";
import { LanguageButton } from "../../frame/language-button.tsx";
import { useCore } from "../../use-core.ts";
import { useNarrow } from "../use-narrow.ts";

// The frame of the setup's concepts: one bar on top with the mark, where
// the admin is in the whole setup and how much is left (the library's
// Stepper, "Step 2 of 9 · AI" on a phone), the language and the way out;
// the step below in one column that scrolls with the page. Leaving asks
// first and signs out: the admin can't use Grasp before the setup is done,
// so a way "home" only led back here. Everything done so far is kept, and
// signing in again goes on where they stopped.

const styles = stylex.create({
  window: {
    display: "flex",
    flexDirection: "column",
    minHeight: "100svh",
  },
  bar: {
    display: "grid",
    gridTemplateColumns: {
      default:
        "minmax(max-content, 1fr) minmax(0, 54rem) minmax(max-content, 1fr)",
      [media.maxSm]: "auto minmax(0, 1fr) auto",
    },
    alignItems: "center",
    columnGap: { default: space[6], [media.maxSm]: space[3] },
    paddingBlock: space[4],
    paddingInline: { default: space[8], [media.maxSm]: space[4] },
  },
  mark: { display: "flex", [iconVars.size]: size.iconDefault },
  end: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: space[1],
  },
  main: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flexGrow: 1,
    paddingInline: space[4],
    paddingBlock: { default: space[12], [media.maxSm]: space[6] },
  },
  column: { display: "flex", flexDirection: "column", width: "100%" },
  // A conversation fills the window: its transcript scrolls, its answer stays in sight.
  filled: { height: "100svh" },
  fillMain: {
    minHeight: 0,
    paddingBlock: { default: space[4], [media.maxSm]: space[2] },
  },
  fillColumn: { flexGrow: 1, minHeight: 0 },
  narrowColumn: { maxWidth: "34rem" },
  wideColumn: { maxWidth: "40rem" },
});

/** A step of the whole setup, by the screen's name. */
export type WholeStep =
  | "welcome"
  | "ai"
  | "about"
  | "company"
  | "sources"
  | "documents"
  | "leads"
  | "team"
  | "review";

/** The setup as it would be with Pulse gone: every step, to say how much is left. */
export const wholeSetup: readonly WholeStep[] = [
  "welcome",
  "ai",
  "about",
  "company",
  "sources",
  "documents",
  "leads",
  "team",
  "review",
];

const useStepNames = (): Record<WholeStep, string> => {
  const { t } = useLingui();
  return {
    welcome: t`Welcome`,
    ai: t`AI`,
    about: t`Plan`,
    company: t`People`,
    sources: t`Sources`,
    documents: t`Documents`,
    leads: t`Leads`,
    team: t`Message`,
    review: t`Review`,
  };
};

/** Leaving: asked first, then signed out, everything kept. */
const Leave = () => {
  const { t } = useLingui();
  const core = useCore();
  const narrow = useNarrow();
  const [asking, setAsking] = useState(false);
  // Signed out, the app takes them to sign in again; where it didn't work, they stay.
  const leave = async () => {
    try {
      await signOut(core);
    } catch {
      setAsking(false);
    }
  };
  return (
    <>
      {narrow ? (
        <Button
          aria-label={t`Leave setup`}
          onClick={() => {
            setAsking(true);
          }}
          size="icon-sm"
          variant="ghost"
        >
          <Icon icon={LogOutIcon} />
        </Button>
      ) : (
        <Button
          onClick={() => {
            setAsking(true);
          }}
          size="sm"
          variant="ghost"
        >
          <Icon icon={LogOutIcon} />
          {t`Leave`}
        </Button>
      )}
      <AlertDialog onOpenChange={setAsking} open={asking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Leave the setup for now?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {t`Everything you did is saved. Sign in again and you go on where you stopped.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t`Stay`}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void leave();
              }}
              variant="outline"
            >
              {t`Sign out`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export const ConceptFrame = ({
  step,
  onGo,
  reached,
  language = true,
  tools,
  wide = false,
  fill = false,
  children,
}: {
  step: WholeStep;
  /** Goes back to a step done; on as far as `reached`. */
  onGo: (step: WholeStep) => void;
  reached: number;
  /** The language in the bar: not on the step that asks for it. */
  language?: boolean;
  /** More in the bar before the language, such as the sound. */
  tools?: ReactNode;
  wide?: boolean;
  /** As high as the window, the step scrolling inside itself. */
  fill?: boolean;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  const names = useStepNames();
  const index = wholeSetup.indexOf(step);
  return (
    <div {...stylex.props(styles.window, fill && styles.filled)}>
      <header {...stylex.props(styles.bar)}>
        <span {...stylex.props(styles.mark)}>
          <Icon icon={GraspLogo} label="Grasp" />
        </span>
        <Stepper
          aria-label={t`Setup`}
          onValueChange={(at) => {
            const next = wholeSetup[at];
            if (next !== undefined) {
              onGo(next);
            }
          }}
          reached={reached}
          steps={wholeSetup.map((each) => ({ label: names[each] }))}
          value={index}
        />
        <div {...stylex.props(styles.end)}>
          {tools}
          {language ? <LanguageButton side="bottom" /> : null}
          <Leave />
        </div>
      </header>
      <main {...stylex.props(styles.main, fill && styles.fillMain)}>
        <div
          {...stylex.props(
            styles.column,
            wide ? styles.wideColumn : styles.narrowColumn,
            fill && styles.fillColumn
          )}
        >
          {children}
        </div>
      </main>
    </div>
  );
};
