import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import { Kbd } from "@grasp-os/ui/components/kbd";
import { Text } from "@grasp-os/ui/components/text";
import { isThemeMode, ThemeToggle } from "@grasp-os/ui/components/theme-toggle";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Icon,
  LogOutIcon,
  VolumeIcon,
  VolumeOffIcon,
} from "@grasp-os/ui/lib/icons";
import { fadeIn, visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, media, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useLocation } from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

import { GraspLogo } from "../connections/brand-logos.ts";
import { signOut } from "../core-connection.ts";
import {
  applyTheme,
  chooseTheme,
  onThemeChange,
  readTheme,
} from "../frame/theme.ts";
import { useCore } from "../use-core.ts";
import { allowSound, setVoiceOn, useSay, useVoice } from "../voice/voice.ts";
import type { Pose } from "./field/engine.ts";
import { fromTheTop } from "./field/poses.ts";
import { StephenField } from "./field/stephen-field.tsx";
import { LanguagePicker } from "./language-picker.tsx";
import { StartOver } from "./start-over.tsx";

// The frame of the setup and of the page a member waits on: full screen,
// outside the app. One quiet bar on top, Grasp's mark at its start, the
// language, his voice, light or dark, and the way out at its end; then the step in one
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
  // Back and on, two quiet arrows at the bottom corner, out of the step's way. On a phone there is no
  // room beside the step, so they follow it at the page's end instead of lying over its buttons.
  ways: {
    position: { default: "fixed", [media.maxSm]: "static" },
    insetBlockEnd: space[6],
    insetInlineEnd: space[8],
    alignSelf: "flex-end",
    zIndex: 1,
    display: "flex",
    gap: space[1],
    paddingInline: { default: 0, [media.maxSm]: space[4] },
    paddingBlockEnd: { default: 0, [media.maxSm]: space[6] },
  },
  tools: { display: "flex", alignItems: "center", gap: space[1] },
  // No line in the setup ends on a word or two alone: every paragraph wraps so its last line has company.
  main: {
    textWrap: "pretty",
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
  stepCentred: { justifyItems: "center", textAlign: "center", gap: space[8] },
  // A step's title and its line wrap into even lines (Ruben: "a linebreak with 2 words… should never be possible").
  head: { display: "grid", gap: space[4], textWrap: "balance" },
  // A welcome: its title and line on the column's middle, what it asks below at full width.
  headCentred: { justifyItems: "center", textAlign: "center" },
  // A step's way on stands on the column's middle, under its centred words (Ruben: "just center
  // Continue… the rhythm here doesn't match"): its main button last in the row, a lesser one before it;
  // the step names them main first, so the row runs from the end.
  end: {
    display: "flex",
    flexDirection: "row-reverse",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: space[3],
  },
  // Continue as a "Continue ↵" pair on the column's end edge, right after what the step asks
  // (`?continue=inline`): no slab under the middle, the hint saying Enter does it too.
  endInline: { justifyContent: "flex-start" },
  enter: {
    display: { default: "flex", [media.maxSm]: "none" },
    alignItems: "center",
    gap: space[2],
  },
  // `?continue=bar`: one bar along the page's foot, the way back at its start, how far along in
  // the middle, the step's way on at its end. It stays in sight while the step scrolls under it.
  foot: {
    position: "sticky",
    insetBlockEnd: 0,
    zIndex: 1,
    display: "grid",
    gridTemplateColumns: {
      default: "1fr auto 1fr",
      [media.maxSm]: "auto 1fr",
    },
    alignItems: "center",
    gap: space[3],
    paddingBlock: space[3],
    paddingInline: { default: space[8], [media.maxSm]: space[4] },
    borderBlockStartWidth: "1px",
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
    backgroundColor: `color-mix(in oklab, ${colors.background} 82%, transparent)`,
    backdropFilter: "blur(12px)",
  },
  footStart: { display: "flex", justifySelf: "start" },
  footEnd: {
    display: "flex",
    flexDirection: "row-reverse",
    alignItems: "center",
    justifySelf: "end",
    gap: space[3],
    whiteSpace: "nowrap",
  },
  // How far along: one short line per screen, the ones done and this one filled.
  // On a phone the bar has room for back and on alone.
  dots: { display: { default: "flex", [media.maxSm]: "none" }, gap: space[1] },
  dot: {
    width: space[4],
    height: "3px",
    borderRadius: "2px",
    backgroundColor: colors.border,
    transitionProperty: "background-color",
    transitionDuration: "300ms",
  },
  dotDone: { backgroundColor: colors.foreground },
  // `?continue=corner`: the way on joins the back arrow in the bottom corner, where the eye ends.
  corner: {
    position: { default: "fixed", [media.maxSm]: "sticky" },
    insetBlockEnd: { default: space[6], [media.maxSm]: 0 },
    insetInlineEnd: space[8],
    alignSelf: "flex-end",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    gap: space[2],
    justifyContent: "flex-end",
    paddingInline: { default: 0, [media.maxSm]: space[4] },
    paddingBlock: { default: 0, [media.maxSm]: space[3] },
    // On a phone it lies over the page's end, so it takes the page's ground there.
    backgroundColor: {
      default: null,
      [media.maxSm]: `color-mix(in oklab, ${colors.background} 82%, transparent)`,
    },
    backdropFilter: { default: null, [media.maxSm]: "blur(12px)" },
  },
  slot: {
    display: "flex",
    flexDirection: "row-reverse",
    alignItems: "center",
    gap: space[3],
  },
  // A third way, a link, on its own line under the buttons, never beside them.
  also: { display: "flex", justifyContent: "center" },
});

/**
 * The size of every tool in the frame, all Damsko's `sm` (32): the
 * language, light or dark, the way out and the arrows. Every tool takes its
 * size from here, never its own, so they can't drift apart.
 */
const tool = {
  button: "icon-sm",
  select: "sm",
  toggle: "sm",
} as const;

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
      size={tool.toggle}
      // Named on a pause, as the bar's other tools are.
      tooltip={t`Light or dark`}
      variant="icon"
    />
  );
};

/** Where the arrows lead: back a step, and on as far as they went before. */
export interface Ways {
  onBack?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}

/** Back and on, two quiet arrows; one that leads nowhere is not there. */
const WayArrows = ({ ways }: { ways: Ways }) => {
  const { t } = useLingui();
  const { onBack, onNext } = ways;
  if (onBack === undefined && onNext === undefined) {
    return null;
  }
  return (
    <nav aria-label={t`Steps`} {...stylex.props(styles.ways)}>
      {onBack === undefined ? null : (
        <Button
          aria-label={t`Back`}
          onClick={onBack}
          size={tool.button}
          tooltip={t`Back`}
          variant="ghost"
        >
          <Icon icon={ArrowLeftIcon} />
        </Button>
      )}
      {onNext === undefined ? null : (
        <Button
          aria-label={t`Next`}
          onClick={onNext}
          size={tool.button}
          tooltip={t`Next`}
          variant="ghost"
        >
          <Icon icon={ArrowRightIcon} />
        </Button>
      )}
    </nav>
  );
};

/**
 * Stephen's voice, on or off, remembered in this browser. While the browser
 * still holds sound back (until the page is first pressed), a press lets
 * him be heard and says the line he is on again.
 */
const Sound = () => {
  const { t } = useLingui();
  const { on, blocked } = useVoice();
  const heard = on && !blocked;
  const name = heard ? t`Turn my voice off` : t`Turn my voice on`;
  return (
    <Button
      // Its name says on or off; marked as pressed, Damsko would fill it like a chosen tool.
      aria-label={name}
      onClick={() => {
        if (on && blocked) {
          void allowSound();
          return;
        }
        setVoiceOn(!on);
      }}
      size={tool.button}
      tooltip={name}
      variant="ghost"
    >
      <Icon icon={heard ? VolumeIcon : VolumeOffIcon} />
    </Button>
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
      size={tool.button}
      tooltip={t`Leave for now`}
      variant="ghost"
    >
      <Icon icon={LogOutIcon} />
    </Button>
  );
};

/**
 * Where a step's way on stands, tried out in development only with
 * `?continue=`: `bar` (a bar along the page's foot, back, how far, on),
 * `corner` (in the bottom corner beside the back arrow), `inline` (right
 * after what the step asks, on the column’s end edge, "Enter" beside it); without
 * it, centred under the step as before. The three new ones go on with Enter.
 */
export type ContinuePlace = "centre" | "bar" | "corner" | "inline";

const isNewPlace = (written: string | null): written is ContinuePlace =>
  written === "bar" || written === "corner" || written === "inline";

const useContinuePlace = (): ContinuePlace => {
  const written = useLocation({ select: (location) => location.searchStr });
  const asked = new URLSearchParams(written).get("continue");
  return import.meta.env.DEV && isNewPlace(asked) ? asked : "centre";
};

/** Where the frame keeps a step's way on, when it keeps it outside the step. */
const EndPlace = createContext<{
  place: ContinuePlace;
  slot: HTMLElement | null;
}>({ place: "centre", slot: null });

/** A key typed into a field, or pressed on a control, is that control's own. */
const ownsEnter = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest("input, textarea, select, button, a, [role=textbox]") !==
      null);

/**
 * Enter goes on: it presses the step's main button (the first it names),
 * unless a field or a control has the key, or a dialog is open over the step.
 */
const useEnterGoesOn = (on: boolean): RefObject<HTMLDivElement | null> => {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const press = (event: KeyboardEvent) => {
      if (
        !on ||
        event.key !== "Enter" ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        ownsEnter(event.target) ||
        document.querySelector("[role=dialog], [role=alertdialog]") !== null
      ) {
        return;
      }
      const main = ref.current?.querySelector("button");
      if (main === null || main === undefined || main.disabled) {
        return;
      }
      event.preventDefault();
      main.click();
    };
    document.addEventListener("keydown", press);
    return () => {
      document.removeEventListener("keydown", press);
    };
  }, [on]);
  return ref;
};

/** How far along: a short line per screen, those done and this one filled. */
const Progress = ({ at, of }: { at: number; of: number }) => {
  const { t } = useLingui();
  const step = at + 1;
  const total = of;
  return (
    <div {...stylex.props(styles.dots)}>
      <span
        {...stylex.props(visuallyHidden)}
      >{t`Step ${step} of ${total}`}</span>
      {Array.from({ length: of }, (_, index) => (
        <span
          aria-hidden="true"
          key={index}
          {...stylex.props(styles.dot, index <= at && styles.dotDone)}
        />
      ))}
    </div>
  );
};

/** The back arrow alone, as the bar and the corner keep it. */
const BackArrow = ({ onBack }: { onBack: (() => void) | undefined }) => {
  const { t } = useLingui();
  if (onBack === undefined) {
    return null;
  }
  return (
    <Button
      aria-label={t`Back`}
      onClick={onBack}
      size={tool.button}
      tooltip={t`Back`}
      variant="ghost"
    >
      <Icon icon={ArrowLeftIcon} />
    </Button>
  );
};

export const CalmFrame = ({
  userId,
  ways,
  progress,
  language = true,
  pose = fromTheTop,
  centred = false,
  children,
}: {
  /** Whose light or dark the bar's icon keeps. */
  userId: string;
  /** Back and on, as two arrows at the bottom corner; none on a page that has no steps. */
  ways?: Ways;
  /** Which screen of how many, where the frame shows how far along. */
  progress?: { at: number; of: number };
  /** Little on it: the column in the middle of the room, not at its top. */
  centred?: boolean;
  /** The language in the bar: not on the step that asks for it. */
  language?: boolean;
  /** Where Stephen's light rests on this screen and how it moves there. */
  pose?: Pose;
  children: ReactNode;
}) => {
  const asked = useContinuePlace();
  // A page without steps (the waiting page) keeps its buttons where they are.
  const place = ways === undefined && progress === undefined ? "centre" : asked;
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const outside = place === "bar" || place === "corner";
  const kept = useMemo(
    () => ({ place, slot: outside ? slot : null }),
    [place, slot, outside]
  );
  let foot: ReactNode = null;
  if (place === "bar") {
    foot = (
      <footer {...stylex.props(styles.foot)}>
        <span {...stylex.props(styles.footStart)}>
          <BackArrow onBack={ways?.onBack} />
        </span>
        {progress === undefined ? <span /> : <Progress {...progress} />}
        <div ref={setSlot} {...stylex.props(styles.footEnd)} />
      </footer>
    );
  } else if (place === "corner") {
    foot = (
      <nav {...stylex.props(styles.corner)}>
        <BackArrow onBack={ways?.onBack} />
        <div ref={setSlot} {...stylex.props(styles.slot)} />
      </nav>
    );
  } else if (ways !== undefined) {
    foot = <WayArrows ways={ways} />;
  }
  return (
    <EndPlace.Provider value={kept}>
      <div {...stylex.props(styles.window)}>
        <StephenField pose={pose}>
          <header {...stylex.props(styles.bar)}>
            <span {...stylex.props(styles.mark)}>
              <Icon icon={GraspLogo} label="Grasp" />
            </span>
            <div {...stylex.props(styles.tools)}>
              {language ? <LanguagePicker /> : null}
              <Sound />
              <Appearance userId={userId} />
              <StartOver size={tool.button} />
              <Leave />
            </div>
          </header>
          <main {...stylex.props(styles.main)}>
            <div {...stylex.props(styles.column, centred && styles.centred)}>
              {children}
            </div>
          </main>
          {foot}
        </StephenField>
      </div>
    </EndPlace.Provider>
  );
};

/** A step's way on, where the frame keeps it; it fades in as it arrives. */
const StepEnd = ({ end }: { end: ReactNode }) => {
  const { t } = useLingui();
  const { place, slot } = useContext(EndPlace);
  const ref = useEnterGoesOn(place !== "centre");
  if (place === "bar" || place === "corner") {
    if (slot === null) {
      return null;
    }
    return createPortal(
      <div ref={ref} {...stylex.props(styles.slot, fadeIn)}>
        {end}
      </div>,
      slot
    );
  }
  if (place === "inline") {
    return (
      <div {...stylex.props(styles.end, styles.endInline, fadeIn)}>
        <div ref={ref} {...stylex.props(styles.slot)}>
          {end}
        </div>
        <span aria-hidden="true" {...stylex.props(styles.enter)}>
          <Text as="span" color="muted" size="sm">
            {t`or press`}
          </Text>
          <Kbd>Enter ↵</Kbd>
        </span>
      </div>
    );
  }
  return <div {...stylex.props(styles.end)}>{end}</div>;
};

/** A sentence ends before the next is said: a title without its own stop gets one. */
const endsSentence = /[.!?…]$/u;

/** What Stephen says on a step: its title, and its line when the line is words alone. */
const spokenStep = (title: string, body: ReactNode): string => {
  if (typeof body !== "string") {
    return title;
  }
  return `${endsSentence.test(title.trim()) ? title : `${title.trim()}.`} ${body}`;
};

/**
 * One step: the serif title in Stephen's voice (he says it, and its line,
 * as the step arrives), one line under it, what
 * the step asks, and its end: its one `default` Button, an `outline` for a
 * lesser way, a `link` for a third.
 */
export const CalmStep = ({
  title,
  body,
  figure,
  centred = true,
  children,
  end,
  also,
  silent = false,
}: {
  /** Not said as it arrives: Stephen has just told it another way (the plan's story). */
  silent?: boolean;
  /** A third way (a `link`), on its own line under the buttons. */
  also?: ReactNode;
  /** The title and its line on the column's middle (every step's, Ruben: "every step"); what the step asks stays full width. */
  centred?: boolean;
  /** Stephen over the title, on a page with little else; then it all stands centred. */
  figure?: ReactNode;
  title: string;
  body: ReactNode;
  children?: ReactNode;
  end?: ReactNode;
}) => {
  // Stephen says the step as it arrives: its title, and its line when it is words alone.
  useSay(spokenStep(title, body), { delay: 250, when: !silent });
  return (
    <section
      {...stylex.props(styles.step, figure !== undefined && styles.stepCentred)}
    >
      {figure}
      <div {...stylex.props(styles.head, centred && styles.headCentred)}>
        <Heading level={1} size="xl">
          {title}
        </Heading>
        {/* The body's own size, a step below the large one: Ruben found the line too big. */}
        {typeof body === "string" ? <Text>{body}</Text> : body}
      </div>
      {children}
      {end === undefined || end === null ? null : <StepEnd end={end} />}
      {also === undefined || also === null ? null : (
        <div {...stylex.props(styles.also)}>{also}</div>
      )}
    </section>
  );
};
