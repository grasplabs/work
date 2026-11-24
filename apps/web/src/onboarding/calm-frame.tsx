import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Text } from "@grasp-os/ui/components/text";
import { isThemeMode, ThemeToggle } from "@grasp-os/ui/components/theme-toggle";
import { Icon, LogOutIcon } from "@grasp-os/ui/lib/icons";
import { media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import { GraspLogo } from "../connections/brand-logos.ts";
import { signOut } from "../core-connection.ts";
import {
  applyTheme,
  chooseTheme,
  onThemeChange,
  readTheme,
} from "../frame/theme.ts";
import { chooseLocale, isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import { useCore } from "../use-core.ts";
import type { Pose } from "./field/engine.ts";
import { fromTheTop } from "./field/poses.ts";
import { StephenField } from "./field/stephen-field.tsx";
import { useNarrow } from "./use-narrow.ts";

// The frame of the setup and of the page a member waits on: full screen,
// outside the app. One quiet bar on top, Grasp's mark at its start, the
// language, light or dark, and the way out at its end; then the step in one
// centred column, its words on the start edge, the page scrolling. Behind
// it all, Stephen: the light of the page, alive, in another place on every
// screen (field/stephen-field.tsx). Leaving signs out: the admin can't use
// Grasp before the setup is done, so a way "home" would only lead back
// here; everything finished is kept, and signing in again goes on there.

const styles = stylex.create({
  window: {
    position: "relative",
    isolation: "isolate",
    display: "flex",
    flexDirection: "column",
    minHeight: "100svh",
  },
  bar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space[3],
    paddingBlock: space[4],
    paddingInline: { default: space[8], [media.maxSm]: space[4] },
  },
  mark: { display: "flex", [iconVars.size]: size.iconDefault },
  tools: { display: "flex", alignItems: "center", gap: space[1] },
  main: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    flexGrow: 1,
    paddingInline: space[4],
    paddingBlockStart: { default: space[16], [media.maxSm]: space[8] },
    paddingBlockEnd: { default: space[20], [media.maxSm]: space[12] },
  },
  // One column for every step, the welcome too: centred on the page, its words on the start edge.
  column: { width: "100%", maxWidth: "40rem" },
  // A screen with little on it stands in the middle of the room under the bar, a little above centre.
  centred: {
    marginBlockStart: "auto",
    marginBlockEnd: "auto",
    paddingBlockEnd: space[16],
  },
  step: { display: "grid", gap: space[10] },
  // A page with little on it: Stephen over the title, all of it on the column's middle.
  endCentred: { justifyContent: "center" },
  stepCentred: { justifyItems: "center", textAlign: "center", gap: space[8] },
  head: { display: "grid", gap: space[4] },
  // A welcome: its title and line on the column's middle, what it asks below at full width.
  headCentred: { justifyItems: "center", textAlign: "center" },
  end: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[3],
  },
});

const languages = Object.entries(localeNames).flatMap(([code, name]) =>
  isLocale(code) ? [{ code, name }] : []
);

/** The language in the bar: a quiet Select of the five, each in its own words; on a phone its short code. */
const Language = () => {
  const { t, i18n } = useLingui();
  const narrow = useNarrow();
  const locale: Locale = isLocale(i18n.locale) ? i18n.locale : "en";
  const language = localeNames[locale];
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
      <SelectTrigger
        aria-label={t`Language: ${language}`}
        size="sm"
        variant="ghost"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {languages.map(({ code, name }) => (
          <SelectItem
            key={code}
            label={narrow ? code.toUpperCase() : name}
            value={code}
          >
            <span lang={code}>{name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

/**
 * Light, dark or the system's, as one quiet icon that steps through them:
 * the person's own choice, the one their menu in the platform makes too.
 */
const Appearance = ({ userId }: { userId: string }) => {
  const { t } = useLingui();
  // Read where it is kept, so a choice made in another tab shows here too.
  const mode = useSyncExternalStore(onThemeChange, () => readTheme(userId));
  // What theme.js painted first was whoever was here last; this is theirs.
  useEffect(() => {
    applyTheme(readTheme(userId));
  }, [userId]);
  return (
    <ThemeToggle
      aria-label={t`Appearance`}
      mode={mode}
      onModeChange={(next) => {
        if (isThemeMode(next)) {
          chooseTheme(userId, next);
        }
      }}
      size="sm"
      variant="icon"
    />
  );
};

/** Leaving signs out; nothing is lost. Where signing out didn't work, they stay. */
const Leave = () => {
  const { t } = useLingui();
  const core = useCore();
  return (
    <Button
      aria-label={t`Leave for now`}
      onClick={() => {
        void (async () => {
          try {
            await signOut(core);
          } catch {
            // Still signed in: the page stays as it was.
          }
        })();
      }}
      size="icon-sm"
      tooltip={t`Leave for now`}
      variant="ghost"
    >
      <Icon icon={LogOutIcon} />
    </Button>
  );
};

export const CalmFrame = ({
  userId,
  language = true,
  pose = fromTheTop,
  centred = false,
  children,
}: {
  /** Whose light or dark the bar's icon keeps. */
  userId: string;
  /** Little on it: the column in the middle of the room, not at its top. */
  centred?: boolean;
  /** The language in the bar: not on the step that asks for it. */
  language?: boolean;
  /** Where Stephen's light rests on this screen and how it moves there. */
  pose?: Pose;
  children: ReactNode;
}) => (
  <div {...stylex.props(styles.window)}>
    <StephenField pose={pose}>
      <header {...stylex.props(styles.bar)}>
        <span {...stylex.props(styles.mark)}>
          <Icon icon={GraspLogo} label="Grasp" />
        </span>
        <div {...stylex.props(styles.tools)}>
          {language ? <Language /> : null}
          <Appearance userId={userId} />
          <Leave />
        </div>
      </header>
      <main {...stylex.props(styles.main)}>
        <div {...stylex.props(styles.column, centred && styles.centred)}>
          {children}
        </div>
      </main>
    </StephenField>
  </div>
);

/**
 * One step: the serif title in Stephen's voice, one line under it, what
 * the step asks, and its end: its one `default` Button, an `outline` for a
 * lesser way, a `link` for a third.
 */
export const CalmStep = ({
  title,
  body,
  figure,
  centred = false,
  children,
  end,
}: {
  /** The title and its line on the column's middle; what the step asks stays full width. */
  centred?: boolean;
  /** Stephen over the title, on a page with little else; then it all stands centred. */
  figure?: ReactNode;
  title: string;
  body: ReactNode;
  children?: ReactNode;
  end?: ReactNode;
}) => (
  <section
    {...stylex.props(styles.step, figure !== undefined && styles.stepCentred)}
  >
    {figure}
    <div {...stylex.props(styles.head, centred && styles.headCentred)}>
      <Heading level={1} size="xl">
        {title}
      </Heading>
      {typeof body === "string" ? <Text size="lg">{body}</Text> : body}
    </div>
    {children}
    {end === undefined || end === null ? null : (
      <div
        {...stylex.props(styles.end, figure !== undefined && styles.endCentred)}
      >
        {end}
      </div>
    )}
  </section>
);
