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
  // A scene's room: its ground fills it, behind what stands on it.
  scene: {
    position: "relative",
    isolation: "isolate",
    overflow: "hidden",
  },
  // Beside the page, from a laptop: the window's other half, top to bottom.
  beside: {
    display: { default: "none", [media.lg]: "block" },
    gridColumn: "2",
    gridRow: "1 / 3",
  },
  // On a phone (Ruben: no white bar over the artwork, and quiet): the scene runs up behind the
  // header and a little under it ("low"), or only behind it ("header").
  band: {
    display: { default: "block", [media.lg]: "none" },
    gridColumn: "1 / -1",
    gridRow: "1",
    height: { default: "7rem", [media.sm]: "8rem" },
  },
  bandHeader: { height: { default: "4rem", [media.sm]: "5rem" } },
  // In the conversation: the scene only behind the header, across the window, at every width.
  strip: {
    gridColumn: "1 / -1",
    gridRow: "1",
    height: { default: "4rem", [media.sm]: "5rem" },
  },
  // The header stands at the top of the band's room.
  headerOnScene: { alignSelf: "start" },
  // On the scene the mark is light on dark: on a phone's band, or on the strip at every width.
  brandOnBand: {
    color: { default: colors.brandPaper, [media.lg]: colors.foreground },
  },
  brandOnStrip: { color: colors.brandPaper },
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

/** Grasp's mark and name, top start. */
const Brand = ({ on }: { on: "page" | "band" | "strip" }) => (
  <span
    {...stylex.props(
      styles.brand,
      on === "band" && styles.brandOnBand,
      on === "strip" && styles.brandOnStrip
    )}
  >
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
  band = "low",
  strip = false,
  phoneScene = "aurora",
  actions,
  children,
}: {
  /** Seconds left, once the conversation runs; null before it. */
  left: number | null;
  clock: ClockPlace;
  /** The scene beside the page, before the conversation. */
  scene?: Scene;
  /** On a phone too, as a band behind the header; else beside the page only. */
  sceneOnPhone?: boolean;
  /** The phone's band: low under the header, or only behind it. */
  band?: "header" | "low";
  /** The conversation: the scene only behind the header, at every width. */
  strip?: boolean;
  /** The scene behind the mark on a phone and on the strip: the darkest, so "Grasp" always reads. */
  phoneScene?: Scene;
  /** More at the header’s end, before the language: the way out for now. */
  actions?: ReactNode;
  children: ReactNode;
}) => {
  const onBand = scene !== undefined && sceneOnPhone;
  let brandOn: "page" | "band" | "strip" = "page";
  if (strip) {
    brandOn = "strip";
  } else if (onBand) {
    brandOn = "band";
  }
  return (
    <div {...stylex.props(styles.frame, scene === undefined && styles.plain)}>
      <header {...stylex.props(styles.header, onBand && styles.headerOnScene)}>
        <Brand on={brandOn} />
        <div {...stylex.props(styles.end)}>
          {actions}
          <LanguageButton side="bottom" />
        </div>
      </header>
      {scene === undefined ? null : (
        <div {...stylex.props(styles.scene, styles.beside)}>
          <AppCardGround hue={undefined} scene={scene} />
        </div>
      )}
      {onBand ? (
        <div
          {...stylex.props(
            styles.scene,
            styles.band,
            band === "header" && styles.bandHeader
          )}
        >
          <AppCardGround hue={undefined} scene={phoneScene} />
        </div>
      ) : null}
      {strip ? (
        <div {...stylex.props(styles.scene, styles.strip)}>
          <AppCardGround hue={undefined} scene={phoneScene} />
        </div>
      ) : null}
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
};
