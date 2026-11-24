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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import { Text } from "@grasp-os/ui/components/text";
import { GlobeIcon, Icon, LogOutIcon } from "@grasp-os/ui/lib/icons";
import { media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { GraspLogo } from "../../connections/brand-logos.ts";
import { signOut } from "../../core-connection.ts";
import { LanguageButton } from "../../frame/language-button.tsx";
import { chooseLocale, isLocale, localeNames } from "../../i18n.ts";
import type { Locale } from "../../i18n.ts";
import { useCore } from "../../use-core.ts";
import { useNarrow } from "../use-narrow.ts";

// The frame of the setup's concepts: one bar on top with the mark, where
// the admin is in words (one of three chapters, and about how many
// minutes are left), the language and the way out;
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
  where: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    justifyContent: { default: "center", [media.maxSm]: "flex-start" },
    columnGap: space[2],
    margin: 0,
  },
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
  wideColumn: { maxWidth: "48rem" },
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

/** About how many minutes each step takes, to say how long is left. */
const minutes: Record<WholeStep, number> = {
  welcome: 0.5,
  ai: 1,
  about: 1,
  company: 1.5,
  sources: 1,
  documents: 1.5,
  leads: 1,
  team: 1,
  review: 0.5,
};

/** The three chapters the setup reads as: the start, the company, the team. */
const chapterOf = (step: WholeStep): 0 | 1 | 2 => {
  if (step === "welcome" || step === "ai" || step === "about") {
    return 0;
  }
  return step === "team" || step === "review" ? 2 : 1;
};

/**
 * Where the admin is, in words: the chapter, and about how many minutes
 * are left of the whole setup. No row of steps: nine names read as a
 * long road, and the step's own foot already goes back and on.
 */
const Whereabouts = ({ step }: { step: WholeStep }) => {
  const { t } = useLingui();
  const chapters = [t`Getting started`, t`Your company`, t`Your team`];
  const left = Math.max(
    1,
    Math.ceil(
      wholeSetup
        .slice(wholeSetup.indexOf(step))
        .reduce((sum, each) => sum + minutes[each], 0)
    )
  );
  const chapter = chapters[chapterOf(step)] ?? "";
  return (
    <p {...stylex.props(styles.where)}>
      <Text as="span" color="default" size="sm" weight="medium">
        {chapter}
      </Text>
      <Text as="span" color="muted" size="sm">
        {plural(left, {
          one: "About # minute left",
          other: "About # minutes left",
        })}
      </Text>
    </p>
  );
};

const languages = Object.entries(localeNames).flatMap(([code, name]) =>
  isLocale(code) ? [{ code, name }] : []
);

/** The language: today's button, and on a phone its globe alone, so the bar keeps one line. */
const Language = () => {
  const { t, i18n } = useLingui();
  const narrow = useNarrow();
  const locale: Locale = isLocale(i18n.locale) ? i18n.locale : "en";
  const name = localeNames[locale];
  if (!narrow) {
    return <LanguageButton side="bottom" />;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={t`Language: ${name}`}
          size="icon-sm"
          variant="ghost"
        >
          <Icon icon={GlobeIcon} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom">
        <DropdownMenuRadioGroup
          onValueChange={(value: unknown) => {
            if (isLocale(value)) {
              void chooseLocale(value);
            }
          }}
          value={locale}
        >
          {languages.map((each) => (
            <DropdownMenuRadioItem
              closeOnSelect
              key={each.code}
              label={each.name}
              value={each.code}
            >
              <span lang={each.code}>{each.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
  language = true,
  tools,
  wide = false,
  fill = false,
  children,
}: {
  step: WholeStep;
  /** The language in the bar: not on the step that asks for it. */
  language?: boolean;
  /** More in the bar before the language, such as the sound. */
  tools?: ReactNode;
  wide?: boolean;
  /** As high as the window, the step scrolling inside itself. */
  fill?: boolean;
  children: ReactNode;
}) => (
  <div {...stylex.props(styles.window, fill && styles.filled)}>
    <header {...stylex.props(styles.bar)}>
      <span {...stylex.props(styles.mark)}>
        <Icon icon={GraspLogo} label="Grasp" />
      </span>
      <Whereabouts step={step} />
      <div {...stylex.props(styles.end)}>
        {tools}
        {language ? <Language /> : null}
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
