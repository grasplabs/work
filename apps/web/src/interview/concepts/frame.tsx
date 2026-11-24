import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@grasp-os/ui/components/progress";
import { Icon } from "@grasp-os/ui/lib/icons";
import {
  colors,
  font,
  media,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars, pixel } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

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
  // The header's controls: one quiet family, one gap.
  end: { display: "flex", alignItems: "center", gap: space["1"] },
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
  // The texture's room: the page's own ground, the texture over it.
  field: {
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
  // On a phone: the texture behind the header and a little under it, so the top is one surface.
  band: {
    display: { default: "block", [media.lg]: "none" },
    gridColumn: "1 / -1",
    gridRow: "1",
    height: { default: "7rem", [media.sm]: "8rem" },
  },
  bandHeader: { height: { default: "4rem", [media.sm]: "5rem" } },
  // In the conversation: the texture behind the header, across the window, at every width.
  strip: {
    gridColumn: "1 / -1",
    gridRow: "1",
    height: { default: "6rem", [media.sm]: "8rem" },
  },
  // The header stands at the top of the band's room.
  headerOnField: { alignSelf: "start" },
  // Damsko's calm dither, as the page header's banner draws it: mint light from a corner, seen
  // through the system's one pixel (a 2px square in every 3px), at the banner's faint strength, on
  // the page's own ground. Decoration: hidden from assistive tech, never moves, not drawn in forced
  // colours.
  texture: {
    position: "absolute",
    inset: 0,
    zIndex: -1,
    pointerEvents: "none",
    opacity: size.pageHeaderDitherStrength,
    maskImage: pixel.mask,
    maskSize: "3px 3px",
    display: { default: "block", [media.forcedColors]: "none" },
  },
  // Beside the page: the light from the top end corner, falling across the half.
  lightBeside: {
    backgroundImage: `radial-gradient(140% 100% at 100% 0%, ${colors.mint}, transparent 75%)`,
  },
  // Over a header: the light from the top, fading down before the page begins.
  lightTop: {
    backgroundImage: `linear-gradient(to bottom, ${colors.mint}, transparent 95%)`,
  },
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

/** Grasp's mark alone, top start (Ruben: "the logo is enough"); "Grasp" is its name. */
const Brand = () => (
  <span {...stylex.props(styles.brand)}>
    <Icon icon={GraspLogo} label="Grasp" />
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
/** Damsko's calm dither in a room of its own: beside the page, or falling from the top. */
const Field = ({
  room,
  light,
}: {
  room: readonly stylex.StyleXStyles[];
  light: "beside" | "top";
}) => (
  <div aria-hidden="true" {...stylex.props(styles.field, ...room)}>
    <span
      {...stylex.props(
        styles.texture,
        light === "beside" ? styles.lightBeside : styles.lightTop
      )}
    />
  </div>
);

export const Frame = ({
  left,
  clock,
  beside = false,
  besideOnPhone = true,
  band = "low",
  strip = false,
  actions,
  children,
}: {
  /** Seconds left, once the conversation runs; null before it. */
  left: number | null;
  clock: ClockPlace;
  /** The texture beside the page, before the conversation. */
  beside?: boolean;
  /** On a phone too, as a band behind the header; else beside the page only. */
  besideOnPhone?: boolean;
  /** The phone's band: low under the header, or only behind it. */
  band?: "header" | "low";
  /** The conversation: the texture behind the header, at every width. */
  strip?: boolean;
  /** More at the header’s end, before the language: the way out for now. */
  actions?: ReactNode;
  children: ReactNode;
}) => {
  const onBand = beside && besideOnPhone;
  return (
    <div {...stylex.props(styles.frame, !beside && styles.plain)}>
      <header {...stylex.props(styles.header, onBand && styles.headerOnField)}>
        <Brand />
        <div {...stylex.props(styles.end)}>
          {actions}
          <LanguageButton quiet side="bottom" />
        </div>
      </header>
      {beside ? <Field light="beside" room={[styles.beside]} /> : null}
      {onBand ? (
        <Field
          light="top"
          room={[styles.band, band === "header" && styles.bandHeader]}
        />
      ) : null}
      {strip ? <Field light="top" room={[styles.strip]} /> : null}
      {left !== null && clock === "bar" && !beside ? (
        <TimeBar left={left} />
      ) : null}
      <main {...stylex.props(styles.main, !beside && styles.mainPlain)}>
        {children}
      </main>
    </div>
  );
};
