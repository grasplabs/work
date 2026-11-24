import { Button } from "@grasp-os/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { StepperNav } from "@grasp-os/ui/components/stepper";
import { Icon, LogOutIcon } from "@grasp-os/ui/lib/icons";
import { media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { GraspLogo } from "../../connections/brand-logos.ts";
import { signOut } from "../../core-connection.ts";
import { chooseLocale, isLocale, localeNames } from "../../i18n.ts";
import type { Locale } from "../../i18n.ts";
import { useCore } from "../../use-core.ts";
import { useNarrow } from "../use-narrow.ts";

// The frame of the setup's concepts: one bar on top with the mark alone at
// its start, the sound, the language and the way out at its end;
// the step below in one column that scrolls with the page. Leaving signs
// out: the admin can't use Grasp before the setup is done, so a way "home"
// only led back here. Everything done so far is kept, and signing in again
// goes on where they stopped.

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
  stepperBar: {
    width: "100%",
    maxWidth: "48rem",
    marginInline: "auto",
    paddingInline: space[4],
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
  // The step stands in the middle of the room under the bar, its foot right under it.
  column: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    marginBlock: "auto",
  },
  // A conversation fills the window: its transcript scrolls, its answer stays in sight.
  filled: { height: "100svh" },
  fillMain: {
    minHeight: 0,
    paddingBlock: { default: space[4], [media.maxSm]: space[2] },
  },
  fillColumn: { flexGrow: 1, minHeight: 0, marginBlock: 0 },
  narrowColumn: { maxWidth: "34rem" },
  wideColumn: { maxWidth: "48rem" },
  // The welcome's five language cards stand in one row.
  widestColumn: { maxWidth: "80rem" },
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

const languages = Object.entries(localeNames).flatMap(([code, name]) =>
  isLocale(code) ? [{ code, name }] : []
);

/** The language, after the welcome: a Select of the five, each in its own words. */
const Language = () => {
  const { t, i18n } = useLingui();
  const narrow = useNarrow();
  const locale: Locale = isLocale(i18n.locale) ? i18n.locale : "en";
  // Closed, it says the language's own name; on a phone its short code ("NL"). Its list says names.
  return (
    <Select
      items={languages.map(({ code, name }) => ({
        value: code,
        label: narrow ? code.toUpperCase() : name,
      }))}
      onValueChange={(value) => {
        if (isLocale(value)) {
          void chooseLocale(value);
        }
      }}
      value={locale}
    >
      <SelectTrigger aria-label={t`Language`} size="sm" variant="ghost">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {languages.map(({ code, name }) => (
          <SelectItem key={code} label={name} value={code}>
            <span lang={code}>{name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

/**
 * Leaving: nothing is lost, as core keeps every step once it is
 * finished, so it asks nothing. It signs out; signing in again goes on
 * where they stopped. Where signing out didn't work, they stay.
 */
const Leave = () => {
  const { t } = useLingui();
  const core = useCore();
  const narrow = useNarrow();
  const leave = async () => {
    try {
      await signOut(core);
    } catch {
      // Still signed in: the page stays as it was.
    }
  };
  if (narrow) {
    return (
      <Button
        aria-label={t`Leave for now`}
        onClick={() => {
          void leave();
        }}
        size="icon-sm"
        variant="ghost"
      >
        <Icon icon={LogOutIcon} />
      </Button>
    );
  }
  return (
    <Button
      onClick={() => {
        void leave();
      }}
      size="sm"
      variant="ghost"
    >
      {t`Leave for now`}
    </Button>
  );
};

/** How far along, at the top of a later step: the library's StepperNav bar. */
export interface Along {
  /** The step's place in the whole setup, from 0. */
  at: number;
  onBack: () => void;
  /** The way on from the bar (`b`); none while the step still waits on its answer. */
  onNext?: () => void;
  /** Why the bar's Next waits, while it does. */
  waiting?: string;
}

/** How far along, under the bar: the library's StepperNav bar with its count. */
const AlongBar = ({ along }: { along: Along }) => {
  const { onBack, onNext, waiting } = along;
  const total = wholeSetup.length;
  return (
    <div {...stylex.props(styles.stepperBar)}>
      <StepperNav
        disabled={onNext === undefined}
        {...(waiting !== undefined && { disabledReason: waiting })}
        onBack={onBack}
        {...(onNext !== undefined && { onNext })}
        nextType="button"
        showCount
        step={along.at}
        total={total}
        variant="bar"
      />
    </div>
  );
};

export const ConceptFrame = ({
  along,
  language = true,
  tools,
  wide = false,
  fill = false,
  children,
}: {
  /** The language in the bar: not on the step that asks for it. */
  language?: boolean;
  /** More in the bar before the language, such as the sound. */
  tools?: ReactNode;
  /** How wide the step's column is: the narrow default, `true` wider, `"widest"` for a row of five cards. */
  wide?: boolean | "widest";
  /** As high as the window, the step scrolling inside itself. */
  fill?: boolean;
  /** StepperNav's bar under the top bar, for a later step that ends in its own button. */
  along?: Along | undefined;
  children: ReactNode;
}) => (
  <div {...stylex.props(styles.window, fill && styles.filled)}>
    <header {...stylex.props(styles.bar)}>
      <span {...stylex.props(styles.mark)}>
        <Icon icon={GraspLogo} label="Grasp" />
      </span>
      <span />
      <div {...stylex.props(styles.end)}>
        {tools}
        {language ? <Language /> : null}
        <Leave />
      </div>
    </header>
    {along === undefined ? null : <AlongBar along={along} />}
    <main {...stylex.props(styles.main, fill && styles.fillMain)}>
      <div
        {...stylex.props(
          styles.column,
          wide === "widest" && styles.widestColumn,
          wide === true && styles.wideColumn,
          wide === false && styles.narrowColumn,
          fill && styles.fillColumn
        )}
      >
        {children}
      </div>
    </main>
  </div>
);
