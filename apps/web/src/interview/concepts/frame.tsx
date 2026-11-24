import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@grasp-os/ui/components/progress";
import { Icon } from "@grasp-os/ui/lib/icons";
import { colors, font, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { AgentAvatar } from "../../agents/agent-avatar.tsx";
import { AppCardGround } from "../../apps/app-card/ground.tsx";
import type { Scene } from "../../apps/app-card/scenes.ts";
import { GraspLogo } from "../../connections/brand-logos.ts";
import { LanguageButton } from "../../frame/language-button.tsx";
import { budgetSeconds, nearEnd, usedSeconds, usedWords } from "./clock.ts";
import { fixture } from "./fixture.ts";

// CONCEPT ONLY: the frame every concept stands in, full screen, outside the
// app, as the sign-in page before it: Grasp's mark at the window's top
// start, the product's own language button at its top end, and the page.
// Before the conversation a dithered scene (the App cards' ground, Ruben's
// backdrop scenes) takes the window's other half, or a band under the
// header on a phone. The countdown stands in one of three places: over
// the question ("title", conversation.tsx), as a thin bar across the window
// under the header ("bar"), or under the answer box ("note").

/** A phone too short for the band and the whole page above the fold. */
const shortPhone = "@media (width < 64rem) and (height < 760px)";

const styles = stylex.create({
  frame: {
    display: "grid",
    gridTemplateColumns: { default: "minmax(0, 1fr)", [media.lg]: "1fr 1fr" },
    gridTemplateRows: { default: "auto auto 1fr", [media.lg]: "auto 1fr" },
    boxSizing: "border-box",
    height: "100svh",
    overflow: "hidden",
  },
  // Without a scene: one column, the header, the bar if any, the page.
  plain: {
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.lg]: "minmax(0, 1fr)",
    },
    gridTemplateRows: { default: "auto auto 1fr", [media.lg]: "auto auto 1fr" },
  },
  header: {
    position: "relative",
    zIndex: 1,
    gridColumn: "1 / -1",
    gridRow: "1",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
    height: { default: "4rem", [media.sm]: "5rem" },
    paddingInline: { default: space["4"], [media.sm]: space["10"] },
  },
  end: { display: "flex", alignItems: "center", gap: space["2"] },
  // The website's mark beside its name, as the sign-in page has it.
  brand: {
    display: "inline-flex",
    alignItems: "center",
    gap: space["2"],
    [iconVars.size]: "21px",
    color: colors.foreground,
    fontFamily: font.sans,
    fontWeight: font.weightMedium,
    fontSize: font.headingSm,
    lineHeight: font.headingSmLine,
  },
  scene: {
    position: "relative",
    isolation: "isolate",
    overflow: "hidden",
    gridColumn: { default: "1", [media.lg]: "2" },
    gridRow: { default: "2", [media.lg]: "1 / 3" },
    height: { default: "24svh", [media.lg]: "auto" },
    // On a short phone (an iPhone SE is 667 high) the band makes way, so the yes is always on the first screen.
    display: { default: "block", [shortPhone]: "none" },
  },
  // Beside the page only: a phone keeps its whole height for the thread.
  wideOnly: { display: { default: "none", [media.lg]: "block" } },
  bar: {
    gridColumn: "1 / -1",
    gridRow: "2",
    paddingInline: { default: space["4"], [media.sm]: space["10"] },
    paddingBlockEnd: space["2"],
  },
  main: {
    display: "flex",
    flexDirection: "column",
    gridColumn: "1",
    gridRow: { default: "3", [media.lg]: "2" },
    minHeight: 0,
  },
  mainPlain: {
    gridColumn: "1 / -1",
    gridRow: { default: "3", [media.lg]: "3" },
  },
});

/** The interviewer's face: the Stephen the product already has, still (the agents' avatar), given, never chosen. */
export const InterviewerAvatar = () => (
  <AgentAvatar face="stephen" size="default" />
);

/** Grasp's mark and name, top start. */
const Brand = () => (
  <span {...stylex.props(styles.brand)}>
    <Icon icon={GraspLogo} />
    Grasp
  </span>
);

/** Where the countdown stands. */
export type ClockPlace = "title" | "bar" | "note";

/** The thin bar across the window, the minutes in words over it ("bar"). */
const TimeBar = ({ left }: { left: number }) => (
  <div {...stylex.props(styles.bar)}>
    <Progress
      getAriaValueText={() => usedWords(left)}
      max={budgetSeconds}
      size="sm"
      value={usedSeconds(left)}
      variant={nearEnd(left) ? "warning" : "default"}
    >
      <ProgressLabel>{fixture.interviewer}</ProgressLabel>
      <ProgressValue>{() => usedWords(left)}</ProgressValue>
    </Progress>
  </div>
);

/**
 * The frame: the header across the window, the countdown's bar when the
 * concept puts it there, a scene beside the page before the conversation,
 * and the page.
 */
export const Frame = ({
  left,
  clock,
  scene,
  sceneOnPhone = true,
  actions,
  children,
}: {
  /** Seconds left, once the conversation runs; null before it. */
  left: number | null;
  clock: ClockPlace;
  /** The scene beside the page, before the conversation. */
  scene?: Scene;
  /** On a phone too, as a band under the header; else beside the page only. */
  sceneOnPhone?: boolean;
  /** More at the header’s end, before the language: the way out for now. */
  actions?: ReactNode;
  children: ReactNode;
}) => (
  <div {...stylex.props(styles.frame, scene === undefined && styles.plain)}>
    <header {...stylex.props(styles.header)}>
      <Brand />
      <div {...stylex.props(styles.end)}>
        {actions}
        <LanguageButton side="bottom" />
      </div>
    </header>
    {scene === undefined ? null : (
      <div {...stylex.props(styles.scene, !sceneOnPhone && styles.wideOnly)}>
        <AppCardGround hue={undefined} scene={scene} />
      </div>
    )}
    {left !== null && clock === "bar" && scene === undefined ? (
      <TimeBar left={left} />
    ) : null}
    <main
      {...stylex.props(styles.main, scene === undefined && styles.mainPlain)}
    >
      {children}
    </main>
  </div>
);
