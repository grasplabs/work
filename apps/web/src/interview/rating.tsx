import { interviewerNames } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { focusRing, visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  media,
  radius,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";

import { useInterviewer } from "./kept.ts";

// How it was to talk to Stephen, at the end of the interview: five faces,
// from a frown to a wide smile, that answer the pointer (each lifts and
// tilts a little under it, the chosen one pops and stays lit), and, once
// one is picked, a box to say why in their own words. Both are theirs to
// give or leave, and to change while the link works.

/** Each face's mouth, from a frown to a wide smile, in a 24 by 24 box. */
const mouths = [
  "M8 16.5 Q12 12.5 16 16.5",
  "M8.5 16 Q12 14 15.5 16",
  "M8.5 15.5 L15.5 15.5",
  "M8.5 14.5 Q12 17.5 15.5 14.5",
  "M7.5 13.5 Q12 19.5 16.5 13.5 Z",
] as const;

const pop = stylex.keyframes({
  "0%": { transform: "scale(1)" },
  "45%": { transform: "scale(1.32)" },
  "100%": { transform: "scale(1.15)" },
});

const open = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(-0.25rem)" },
  to: { opacity: 1, transform: "none" },
});

// Which way each face leans when the pointer finds it: the sad ones one
// way, the happy ones the other, the middle one only lifts.
const leans = stylex.create({
  frown: {
    transform: {
      default: "none",
      ":hover": "translateY(-2px) scale(1.15) rotate(-8deg)",
    },
  },
  low: {
    transform: {
      default: "none",
      ":hover": "translateY(-2px) scale(1.15) rotate(-5deg)",
    },
  },
  level: {
    transform: { default: "none", ":hover": "translateY(-2px) scale(1.15)" },
  },
  smile: {
    transform: {
      default: "none",
      ":hover": "translateY(-2px) scale(1.15) rotate(5deg)",
    },
  },
  grin: {
    transform: {
      default: "none",
      ":hover": "translateY(-2px) scale(1.15) rotate(8deg)",
    },
  },
});

const styles = stylex.create({
  rating: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space["3"],
    width: "100%",
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
  faces: { display: "flex", alignItems: "center", gap: space["1"] },
  face: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "3.5rem",
    height: "3.5rem",
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.circle,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.accent,
    },
    color: { default: colors.mutedForeground, ":hover": colors.foreground },
    cursor: "pointer",
    transitionProperty: {
      default: "transform, color, background-color, opacity",
      [media.reducedMotion]: "none",
    },
    transitionDuration: "220ms",
    transitionTimingFunction: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  },
  // Another one is chosen: this one steps back, still there to change to.
  other: { opacity: { default: 0.45, ":hover": 1 } },
  chosen: {
    color: colors.foreground,
    backgroundColor: colors.accentActive,
    transform: "scale(1.15)",
    animationName: { default: pop, [media.reducedMotion]: "none" },
    animationDuration: "380ms",
    animationTimingFunction: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  },
  drawing: { width: "2.25rem", height: "2.25rem", overflow: "visible" },
  // The box for their words, opened under the faces once they pick one.
  why: {
    // Over the room under the faces, so nothing above it moves when it opens.
    position: "absolute",
    insetBlockStart: `calc(100% + ${space["4"]})`,
    insetInline: 0,
    marginInline: "auto",
    display: "flex",
    flexDirection: "column",
    alignItems: "stretch",
    gap: space["2"],
    width: "100%",
    maxWidth: "24rem",
    textAlign: "start",
    animationName: { default: open, [media.reducedMotion]: "none" },
    animationDuration: duration.open,
    animationTimingFunction: duration.ease,
  },
  send: { alignSelf: "flex-end" },
});

/** The five faces, worst first: each one's mouth and its lean. */
const faces = [
  { mouth: mouths[0], lean: leans.frown },
  { mouth: mouths[1], lean: leans.low },
  { mouth: mouths[2], lean: leans.level },
  { mouth: mouths[3], lean: leans.smile },
  { mouth: mouths[4], lean: leans.grin },
] as const;

/** What the box asks, by how it went. */
const askedFor = (
  value: number | undefined,
  ask: { good: string; middling: string; bad: string }
): string => {
  if (value === undefined || value >= 4) {
    return ask.good;
  }
  return value === 3 ? ask.middling : ask.bad;
};

/** One face: a round head, two eyes, and its mouth. */
const Face = ({ mouth }: { mouth: string }) => (
  <svg
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={1.5}
    viewBox="0 0 24 24"
    {...stylex.props(styles.drawing)}
  >
    <circle cx="12" cy="12" r="9.25" />
    <circle cx="9" cy="10" fill="currentColor" r="0.9" stroke="none" />
    <circle cx="15" cy="10" fill="currentColor" r="0.9" stroke="none" />
    <path
      d={mouth}
      fill={mouth.endsWith("Z") ? "currentColor" : "none"}
      fillOpacity={0.15}
    />
  </svg>
);

/**
 * How it was to talk to him: five faces to press, and once one is
 * pressed, a box to say why. A face is kept at once; their words when they
 * send them (Enter, or the button).
 */
export const Rating = ({
  value,
  feedback,
  onRate,
  onFeedback,
}: {
  value: number | undefined;
  feedback: string | undefined;
  onRate: (rating: number) => void;
  onFeedback: (feedback: string) => void;
}) => {
  const { t } = useLingui();
  const who = interviewerNames[useInterviewer()];
  const question = t`How was talking to ${who}?`;
  const names = [t`Bad`, t`Not great`, t`Okay`, t`Good`, t`Great`] as const;
  // Their words while they write them; the box stays open until they send.
  const [draft, setDraft] = useState(feedback ?? "");
  const [writing, setWriting] = useState(false);
  const box = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  // Opened by their own press: their words go straight in.
  useEffect(() => {
    if (writing) {
      field.current?.focus();
    }
  }, [writing]);
  const asks = askedFor(value, {
    good: t`What made it good? Anything that could be better?`,
    middling: t`What would have made it better?`,
    bad: t`What went wrong? Every word helps.`,
  });
  const send = (): void => {
    onFeedback(draft);
    setWriting(false);
  };
  let heading = question;
  if (value !== undefined) {
    heading =
      feedback !== undefined && !writing
        ? t`Thank you for telling me.`
        : t`Thank you. Want to say why?`;
  }
  return (
    <fieldset {...stylex.props(styles.rating)}>
      <legend {...stylex.props(visuallyHidden)}>{question}</legend>
      <Text aria-live="polite" as="span" color="muted">
        {heading}
      </Text>
      <span {...stylex.props(styles.faces)}>
        {faces.map(({ mouth, lean }, at) => {
          const rating = at + 1;
          const chosen = value === rating;
          return (
            <button
              aria-label={names[at]}
              aria-pressed={chosen}
              key={mouth}
              onClick={() => {
                onRate(rating);
                setWriting(true);
              }}
              type="button"
              {...stylex.props(
                styles.face,
                lean,
                focusRing,
                value !== undefined && !chosen && styles.other,
                chosen && styles.chosen
              )}
            >
              <Face mouth={mouth} />
            </button>
          );
        })}
      </span>
      {value !== undefined && writing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
          {...stylex.props(styles.why)}
        >
          <label htmlFor={box} {...stylex.props(visuallyHidden)}>
            {asks}
          </label>
          <Textarea
            id={box}
            onValueChange={(next) => {
              setDraft(next);
            }}
            placeholder={asks}
            ref={field}
            rows={3}
            submitShortcut="enter"
            value={draft}
          />
          <Button size="sm" style={styles.send} type="submit">
            {t`Send`}
          </Button>
        </form>
      ) : null}
    </fieldset>
  );
};
