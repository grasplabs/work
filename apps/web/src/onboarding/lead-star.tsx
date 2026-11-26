import { colors } from "@grasp-os/ui/lib/tokens.stylex";
import { iconVars } from "@grasp-os/ui/lib/vars.stylex";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

// The star on a person's Lead toggle (leads-step.tsx). Marking someone a
// team's lead is a moment: the star ducks, leaps with a turn, fills with
// the brand's colours, amber to sea, from its heart, and throws a ring and a burst of
// sparks in lime, mint, sea and amber. Unmarking is quiet: the colour
// drains and the star settles. Nothing round it moves: the burst floats
// over the row. With reduced motion asked for, the star simply is filled
// or not. It plays only for a change seen here, never as the list opens.

/** The star's outline: Hugeicons' StarIcon, the one Damsko draws. */
const starPath =
  "M12.7972 2.90494C13.2554 3.57043 13.9479 4.70769 14.6514 6.04507C15.1942 7.07701 15.4657 7.59298 15.8551 7.86959C16.2444 8.14621 16.812 8.2313 17.9472 8.40149C19.5204 8.63736 20.6806 8.89214 21.3467 9.05516C21.735 9.15017 21.9976 9.50036 21.9976 9.9001C21.9976 10.1262 21.9127 10.344 21.7606 10.5113C21.0637 11.2777 20.3487 12.0836 19.4701 12.961C18.605 13.8249 18.1724 14.2569 18.0253 14.7261C17.8781 15.1954 17.9834 15.7792 18.1939 16.9469C18.3735 17.9433 18.5569 19.1306 18.6921 20.4219C18.7528 21.0024 18.2921 21.5 17.7085 21.5C17.6522 21.5 17.5967 21.4962 17.542 21.4824C17.0502 21.3578 15.919 20.7845 14.1246 19.7243C13.0722 19.1025 12.5461 18.7917 11.9993 18.7917C11.4526 18.7917 10.9265 19.1026 9.87427 19.7244C8.08025 20.7845 6.94977 21.3578 6.45797 21.4824C6.40334 21.4962 6.34784 21.5 6.29148 21.5C5.70788 21.5 5.24716 21.0024 5.30793 20.4219C5.44314 19.1306 5.6265 17.9433 5.80612 16.9469C6.01661 15.7792 6.12186 15.1954 5.97471 14.7261C5.82756 14.2569 5.395 13.8249 4.52987 12.961C3.65132 12.0836 2.93633 11.2777 2.23944 10.5113C2.08729 10.344 2.00244 10.1262 2.00244 9.9001C2.00244 9.50036 2.265 9.15017 2.65328 9.05516C3.31945 8.89214 4.4796 8.63736 6.05284 8.40149C7.18801 8.2313 7.75559 8.14621 8.14498 7.86958C8.53437 7.59295 8.80577 7.07698 9.34859 6.04505C10.0521 4.70768 10.7445 3.57044 11.2026 2.90495C11.3825 2.64364 11.6827 2.5 11.9999 2.5C12.3171 2.5 12.6173 2.64364 12.7972 2.90494Z";

/** A four-pointed sparkle, in a 10-unit box. */
const sparklePath =
  "M5 0 Q5.6 4.4 10 5 Q5.6 5.6 5 10 Q4.4 5.6 0 5 Q4.4 4.4 5 0Z";

const lime = colors.brandLime;
const mint = colors.brandMint;
const sea = colors.brandSea;
const amber = colors.warning;

/** The sparks: where each flies, how far, how big, its colour, its shape and when it leaves. */
const sparks: readonly {
  angle: number;
  far: boolean;
  big: boolean;
  color: string;
  sparkle: boolean;
  delay: number;
}[] = [
  { angle: 0, far: true, big: true, color: lime, sparkle: true, delay: 60 },
  { angle: 30, far: false, big: false, color: sea, sparkle: false, delay: 90 },
  { angle: 60, far: true, big: false, color: amber, sparkle: false, delay: 70 },
  { angle: 90, far: false, big: true, color: mint, sparkle: true, delay: 100 },
  { angle: 120, far: true, big: false, color: lime, sparkle: false, delay: 60 },
  {
    angle: 150,
    far: false,
    big: false,
    color: amber,
    sparkle: true,
    delay: 110,
  },
  { angle: 180, far: true, big: true, color: sea, sparkle: false, delay: 80 },
  {
    angle: 210,
    far: false,
    big: false,
    color: mint,
    sparkle: false,
    delay: 60,
  },
  {
    angle: 240,
    far: true,
    big: false,
    color: amber,
    sparkle: true,
    delay: 100,
  },
  { angle: 270, far: false, big: true, color: lime, sparkle: false, delay: 70 },
  { angle: 300, far: true, big: false, color: mint, sparkle: true, delay: 90 },
  {
    angle: 330,
    far: false,
    big: false,
    color: sea,
    sparkle: false,
    delay: 110,
  },
];

const REDUCED = "@media (prefers-reduced-motion: reduce)";
/** A spring's overshoot, for the leap and the fill. */
const springy = "cubic-bezier(0.34, 1.56, 0.64, 1)";
/** Fast away, slow to a stop: the sparks. */
const flung = "cubic-bezier(0.15, 0.75, 0.3, 1)";

const leap = stylex.keyframes({
  "0%": { transform: "scale(1) rotate(0deg)" },
  "14%": { transform: "scale(0.66) rotate(-14deg)" },
  "42%": { transform: "scale(1.6) rotate(20deg)" },
  "62%": { transform: "scale(0.9) rotate(-8deg)" },
  "80%": { transform: "scale(1.1) rotate(3deg)" },
  "100%": { transform: "scale(1) rotate(0deg)" },
});

const fillIn = stylex.keyframes({
  "0%": { transform: "scale(0)", filter: "brightness(1.8) saturate(1.4)" },
  "24%": { transform: "scale(0)", filter: "brightness(1.8) saturate(1.4)" },
  "58%": { transform: "scale(1.12)", filter: "brightness(1.4) saturate(1.3)" },
  "100%": { transform: "scale(1)", filter: "brightness(1) saturate(1)" },
});

const settle = stylex.keyframes({
  "0%": { transform: "scale(1)" },
  "40%": { transform: "scale(0.82)" },
  "100%": { transform: "scale(1)" },
});

const fillOut = stylex.keyframes({
  "0%": { transform: "scale(1)", opacity: 1 },
  "100%": { transform: "scale(0.2)", opacity: 0 },
});

const ringOut = stylex.keyframes({
  "0%": { transform: "scale(0.3)", opacity: 1, borderWidth: "3px" },
  "100%": { transform: "scale(2.5)", opacity: 0, borderWidth: "0.5px" },
});

const glowOut = stylex.keyframes({
  "0%": { transform: "scale(0.2)", opacity: 0.9 },
  "100%": { transform: "scale(2.3)", opacity: 0 },
});

const flyNear = stylex.keyframes({
  "0%": { transform: "translateY(-4px) scale(0.4) rotate(0deg)", opacity: 0 },
  "15%": { opacity: 1 },
  "60%": { transform: "translateY(-17px) scale(1) rotate(90deg)", opacity: 1 },
  "100%": {
    transform: "translateY(-20px) scale(0) rotate(180deg)",
    opacity: 0,
  },
});

const flyFar = stylex.keyframes({
  "0%": { transform: "translateY(-5px) scale(0.4) rotate(0deg)", opacity: 0 },
  "15%": { opacity: 1 },
  "60%": { transform: "translateY(-24px) scale(1) rotate(120deg)", opacity: 1 },
  "100%": {
    transform: "translateY(-28px) scale(0) rotate(220deg)",
    opacity: 0,
  },
});

const styles = stylex.create({
  // As large as the icon it stands in for, and the stage the burst floats over.
  box: {
    position: "relative",
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    width: iconVars.size,
    height: iconVars.size,
  },
  star: {
    position: "relative",
    display: "grid",
    width: "100%",
    height: "100%",
    // A spark may stand over the sticky team row above.
    zIndex: 2,
  },
  leaping: {
    animationName: { default: leap, [REDUCED]: "none" },
    animationDuration: "720ms",
    animationTimingFunction: "ease-out",
  },
  settling: {
    animationName: { default: settle, [REDUCED]: "none" },
    animationDuration: "260ms",
    animationTimingFunction: "ease-out",
  },
  svg: { width: "100%", height: "100%", overflow: "visible" },
  fill: {
    transformBox: "fill-box",
    transformOrigin: "center",
    transform: "scale(0)",
    opacity: 0,
  },
  filled: { transform: "scale(1)", opacity: 1 },
  filling: {
    animationName: { default: fillIn, [REDUCED]: "none" },
    animationDuration: "720ms",
    animationTimingFunction: springy,
    animationFillMode: "both",
  },
  draining: {
    animationName: { default: fillOut, [REDUCED]: "none" },
    animationDuration: "220ms",
    animationTimingFunction: "ease-in",
    animationFillMode: "both",
  },
  line: {
    stroke: "currentColor",
    strokeWidth: iconVars.stroke,
    transitionProperty: "stroke",
    transitionDuration: "200ms",
  },
  lineOn: { stroke: colors.pine },
  stopAmber: { stopColor: amber },
  stopLime: { stopColor: lime },
  stopMint: { stopColor: mint },
  stopSea: { stopColor: sea },
  // The burst: over everything near, catching no press, gone under reduced motion.
  burst: {
    position: "absolute",
    inset: 0,
    zIndex: 2,
    pointerEvents: "none",
    display: { default: "block", [REDUCED]: "none" },
  },
  glow: {
    position: "absolute",
    inset: 0,
    borderRadius: "50%",
    backgroundImage: `radial-gradient(closest-side, ${lime}, color-mix(in oklch, ${mint} 60%, transparent) 55%, transparent)`,
    opacity: 0,
    animationName: glowOut,
    animationDuration: "620ms",
    animationTimingFunction: "ease-out",
    animationFillMode: "both",
    animationDelay: "120ms",
  },
  ring: {
    position: "absolute",
    inset: 0,
    borderRadius: "50%",
    borderStyle: "solid",
    borderColor: mint,
    opacity: 0,
    animationName: ringOut,
    animationDuration: "560ms",
    animationTimingFunction: flung,
    animationFillMode: "both",
    animationDelay: "200ms",
  },
  // One spark's line out from the heart of the star, turned to its angle.
  ray: (angle: number) => ({
    position: "absolute",
    insetBlockStart: "50%",
    insetInlineStart: "50%",
    width: 0,
    height: 0,
    transform: `rotate(${angle}deg)`,
  }),
  spark: (color: string, delay: number) => ({
    position: "absolute",
    color,
    opacity: 0,
    animationDuration: "680ms",
    animationTimingFunction: flung,
    animationFillMode: "both",
    animationDelay: `${120 + delay}ms`,
  }),
  near: { animationName: flyNear },
  far: { animationName: flyFar },
  dot: {
    insetBlockStart: "-2px",
    insetInlineStart: "-2px",
    width: "4px",
    height: "4px",
    borderRadius: "50%",
    backgroundColor: "currentColor",
  },
  bigDot: {
    insetBlockStart: "-2.5px",
    insetInlineStart: "-2.5px",
    width: "5px",
    height: "5px",
  },
  sparkle: {
    insetBlockStart: "-3.5px",
    insetInlineStart: "-3.5px",
    width: "7px",
    height: "7px",
  },
  bigSparkle: {
    insetBlockStart: "-4.5px",
    insetInlineStart: "-4.5px",
    width: "9px",
    height: "9px",
  },
});

/** The burst a lead's marking throws: a glow, a ring, and the sparks. */
const Burst = () => (
  <span aria-hidden {...stylex.props(styles.burst)}>
    <span {...stylex.props(styles.glow)} />
    <span {...stylex.props(styles.ring)} />
    {sparks.map((each) => (
      <span key={each.angle} {...stylex.props(styles.ray(each.angle))}>
        {each.sparkle ? (
          <svg
            viewBox="0 0 10 10"
            {...stylex.props(
              styles.spark(each.color, each.delay),
              each.far ? styles.far : styles.near,
              styles.sparkle,
              each.big && styles.bigSparkle
            )}
          >
            <path d={sparklePath} fill="currentColor" />
          </svg>
        ) : (
          <span
            {...stylex.props(
              styles.spark(each.color, each.delay),
              each.far ? styles.far : styles.near,
              styles.dot,
              each.big && styles.bigDot
            )}
          />
        )}
      </span>
    ))}
  </span>
);

/** The Lead toggle's star: an outline, filled with colour, with a burst as it is marked. */
export const LeadStar = ({ on }: { on: boolean }) => {
  const gradient = `lead${useId().replaceAll(/[^\w-]/gu, "")}`;
  // Each change seen here plays once; the list opening with a lead in it plays nothing. A change
  // swaps the leap for the settle (or back), which starts that animation afresh.
  const [seen, setSeen] = useState(on);
  const [moved, setMoved] = useState(false);
  if (seen !== on) {
    setSeen(on);
    setMoved(true);
  }
  return (
    <span aria-hidden {...stylex.props(styles.box)}>
      <span
        {...stylex.props(
          styles.star,
          moved && on && styles.leaping,
          moved && !on && styles.settling
        )}
      >
        <svg
          fill="none"
          focusable="false"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
          {...stylex.props(styles.svg)}
        >
          <defs>
            <linearGradient id={gradient} x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" {...stylex.props(styles.stopAmber)} />
              <stop offset="35%" {...stylex.props(styles.stopLime)} />
              <stop offset="65%" {...stylex.props(styles.stopMint)} />
              <stop offset="100%" {...stylex.props(styles.stopSea)} />
            </linearGradient>
          </defs>
          <path
            d={starPath}
            fill={`url(#${gradient})`}
            {...stylex.props(
              styles.fill,
              on && styles.filled,
              moved && on && styles.filling,
              moved && !on && styles.draining
            )}
          />
          <path
            d={starPath}
            strokeLinecap="round"
            strokeLinejoin="round"
            {...stylex.props(styles.line, on && styles.lineOn)}
          />
        </svg>
      </span>
      {moved && on ? <Burst /> : null}
    </span>
  );
};
