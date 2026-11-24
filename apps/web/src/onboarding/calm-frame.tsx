import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { StepperNav } from "@grasp-os/ui/components/stepper";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, LogOutIcon } from "@grasp-os/ui/lib/icons";
import { colors, media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars, pixel } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { GraspLogo } from "../connections/brand-logos.ts";
import { signOut } from "../core-connection.ts";
import { chooseLocale, isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import { useCore } from "../use-core.ts";
import { useNarrow } from "./use-narrow.ts";

// The frame of the setup and of the page a member waits on: full screen,
// outside the app. One quiet bar on top, Grasp's mark at its start, the
// language and the way out at its end; under it, on a later step, the
// library's StepperNav bar with how far along; then the step in one
// centred column, its words on the start edge, the page scrolling. Behind
// the top, Damsko's calm dither of light, as the page header's banner and
// the interview's header draw it. Leaving signs out: the admin can't use
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
  // Mint light falling from the top, seen through the system's one pixel at the banner's faint
  // strength. Decoration: hidden from assistive tech, never moves, not drawn in forced colours.
  light: {
    position: "absolute",
    insetInline: 0,
    insetBlockStart: 0,
    zIndex: -1,
    height: { default: "22rem", [media.maxSm]: "14rem" },
    pointerEvents: "none",
    opacity: size.pageHeaderDitherStrength,
    backgroundImage: `linear-gradient(to bottom, ${colors.mint}, transparent 95%)`,
    maskImage: pixel.mask,
    maskSize: "3px 3px",
    display: { default: "block", [media.forcedColors]: "none" },
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
  along: {
    width: "100%",
    maxWidth: "44rem",
    marginInline: "auto",
    paddingInline: space[4],
  },
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

/** How far along, under the bar on a later step. */
export interface Along {
  /** The step's place among the counted steps, from 0. */
  at: number;
  total: number;
  onBack: () => void;
  /** Forward as far as they went before; none past that. */
  onNext?: (() => void) | undefined;
}

const AlongBar = ({ along }: { along: Along }) => {
  const { t } = useLingui();
  const { at, total, onBack, onNext } = along;
  return (
    <div {...stylex.props(styles.along)}>
      <StepperNav
        disabled={onNext === undefined}
        {...(onNext === undefined
          ? { disabledReason: t`Finish this step first` }
          : { onNext })}
        nextType="button"
        onBack={onBack}
        showCount
        step={at}
        total={total}
        variant="bar"
      />
    </div>
  );
};

export const CalmFrame = ({
  along,
  language = true,
  light = true,
  centred = false,
  children,
}: {
  /** Little on it: the column in the middle of the room, not at its top. */
  centred?: boolean;
  /** StepperNav's bar under the top bar, on a step after the welcome. */
  along?: Along | undefined;
  /** The language in the bar: not on the step that asks for it. */
  language?: boolean;
  /** The dither of light behind the top: not where the screen has a picture of its own. */
  light?: boolean;
  children: ReactNode;
}) => (
  <div {...stylex.props(styles.window)}>
    {light ? <span aria-hidden="true" {...stylex.props(styles.light)} /> : null}
    <header {...stylex.props(styles.bar)}>
      <span {...stylex.props(styles.mark)}>
        <Icon icon={GraspLogo} label="Grasp" />
      </span>
      <div {...stylex.props(styles.tools)}>
        {language ? <Language /> : null}
        <Leave />
      </div>
    </header>
    {along === undefined ? null : <AlongBar along={along} />}
    <main {...stylex.props(styles.main)}>
      <div {...stylex.props(styles.column, centred && styles.centred)}>
        {children}
      </div>
    </main>
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
  children,
  end,
}: {
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
    <div {...stylex.props(styles.head)}>
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
