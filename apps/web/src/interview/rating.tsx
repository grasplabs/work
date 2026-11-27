import { interviewerNames } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { focusRing, visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size as sizes,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";

import { useInterviewer } from "./kept.ts";
import { FACE_CELLS, ditherFaces } from "./rating-faces.ts";
import type { FaceMood } from "./rating-faces.ts";

// How it was to talk to Stephen, at the end of the interview: five faces in
// the system's own dither (rating-faces.ts), from a dim worried one to a
// laughing one that glows. They answer the pointer: under it a face lifts
// and its light comes up, the dots filling in a sixteenth at a time in
// the dither's order. The chosen one pops, shimmers once and stays lit; the
// rest dim and step back. Once one is picked, a card under it, pointing up
// at it, asks why. Both are theirs to give or leave, and to change while the
// link works.

/** How big a face is (3px cells), and how far apart they stand. */
const faceSize = "3.75rem";
const faceGap = "0.625rem";
/** A spring that overshoots a little, for faces that answer the pointer. */
const springy = "cubic-bezier(0.34, 1.56, 0.64, 1)";

const pop = stylex.keyframes({
  "0%": { transform: "scale(1)" },
  "45%": { transform: "scale(1.28)" },
  "100%": { transform: "scale(1.15)" },
});

const open = stylex.keyframes({
  from: { opacity: 0, transform: "translateY(-0.375rem) scale(0.98)" },
  to: { opacity: 1, transform: "none" },
});

/** A pass of the glint, flashing over the chosen face and gone. */
const glint = stylex.keyframes({
  "0%": { opacity: 0 },
  "35%": { opacity: 1 },
  "100%": { opacity: 0 },
});

// A face under the pointer lifts and grows a little. Never turned: a turned
// grid of cells smears.
const lifts = stylex.create({
  lift: {
    transform: { default: "none", ":hover": "translateY(-3px) scale(1.08)" },
  },
});

const styles = stylex.create({
  // The rating's room on the page: whole until their words are sent and
  // thanked for, then it folds shut (and takes the page's gap above it with
  // it), so nothing jumps when it goes.
  fold: {
    display: "grid",
    gridTemplateRows: "1fr",
    width: "100%",
    transitionProperty: {
      default: "grid-template-rows, margin-block-start, opacity, transform",
      [media.reducedMotion]: "none",
    },
    transitionDuration: "480ms",
    transitionTimingFunction: duration.ease,
  },
  folded: {
    gridTemplateRows: "0fr",
    marginBlockStart: `calc(-1 * ${space["8"]})`,
    opacity: 0,
    transform: "scale(0.96)",
  },
  folding: { minHeight: 0, overflow: "hidden" },
  open: { minHeight: 0 },
  // The face they chose, at the top of the thanks.
  thanksFace: {
    display: "block",
    width: "5rem",
    height: "5rem",
    marginBlockEnd: space["2"],
  },
  rating: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    width: "100%",
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
  faces: {
    display: "flex",
    alignItems: "center",
    gap: faceGap,
    marginBlockStart: space["4"],
  },
  face: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: faceSize,
    height: faceSize,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.circle,
    backgroundColor: "transparent",
    cursor: "pointer",
    transitionProperty: {
      default: "transform, opacity",
      [media.reducedMotion]: "none",
    },
    transitionDuration: "240ms",
    transitionTimingFunction: springy,
  },
  // Another one is chosen: this one steps back, dimmer and a little
  // smaller, still there to change to.
  other: {
    transform: {
      default: "scale(0.88)",
      ":hover": "translateY(-3px) scale(1.02)",
    },
  },
  chosen: {
    transform: "scale(1.15)",
    animationName: { default: pop, [media.reducedMotion]: "none" },
    animationDuration: "420ms",
    animationTimingFunction: springy,
  },
  drawing: { display: "block", width: "100%", height: "100%" },
  // A pass of a light that comes and goes: hidden until its face asks for
  // it, then in, a sixteenth at a time in the dither's order.
  pass: {
    opacity: 0,
    transitionProperty: { default: "opacity", [media.reducedMotion]: "none" },
    transitionDuration: "40ms",
    transitionTimingFunction: "steps(1, end)",
  },
  shown: { opacity: 1 },
  // A cell of a face that gives way to the page.
  fade: { fill: colors.background },
  // The glint's passes: each flashes once, in the dither's order.
  glinting: {
    opacity: 0,
    animationName: { default: glint, [media.reducedMotion]: "none" },
    animationDuration: "360ms",
    animationTimingFunction: "ease-out",
    animationFillMode: "both",
  },
  // The name of the face under the pointer, or of the chosen one.
  name: {
    minHeight: font.textSmLine,
    marginBlockStart: space["3"],
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  // The box for their words, opened under the faces once they pick one,
  // over the room below them, so nothing above it moves when it opens.
  card: {
    position: "absolute",
    insetBlockStart: `calc(100% + ${space["3"]})`,
    insetInline: 0,
    marginInline: "auto",
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    width: "100%",
    maxWidth: "24rem",
    textAlign: "start",
    animationName: { default: open, [media.reducedMotion]: "none" },
    animationDuration: duration.open,
    animationTimingFunction: duration.ease,
  },
  // Its point, up at the face they chose: the field's own fill and edge, over
  // the field's top edge, so the two read as one shape.
  point: {
    position: "absolute",
    zIndex: 1,
    insetBlockStart: "-0.4375rem",
    width: "0.875rem",
    height: "0.875rem",
    marginInlineStart: "-0.4375rem",
    // The field's fill over the page, so the field's edge under it is
    // covered even where the fill lets the page through; only its upper
    // half, the part over the field's edge.
    backgroundColor: colors.background,
    backgroundImage: `linear-gradient(${colors.inputBg}, ${colors.inputBg})`,
    boxShadow: `inset 1px 1px 0 0 ${colors.input}`,
    clipPath: "polygon(0 0, 100% 0, 0 100%)",
    transform: "rotate(45deg)",
  },
  send: { alignSelf: "flex-end" },
  // The page under the field, so Stephen's dots never show through it.
  backing: {
    display: "block",
    borderRadius: `min(${radius.xl}, calc(${sizes.controlDefault} / 2))`,
    cornerShape: radius.shape,
    backgroundColor: colors.background,
  },
});

// The seven stops of the light, darkest first.
const stops = stylex.create({
  s0: { fill: colors.brandNight },
  s1: { fill: colors.brandInk },
  s2: { fill: colors.brandPine },
  s3: { fill: colors.brandMint },
  s4: { fill: colors.brandSea },
  s5: { fill: colors.brandLime },
  s6: { fill: colors.brandPaper },
});
const stopStyles = [
  stops.s0,
  stops.s1,
  stops.s2,
  stops.s3,
  stops.s4,
  stops.s5,
  stops.s6,
] as const;

/** When each pass of the dither comes in: a light in 240ms, the glint in 600ms. */
const passAt = stylex.create({
  0: { transitionDelay: "0ms", animationDelay: "0ms" },
  1: { transitionDelay: "15ms", animationDelay: "40ms" },
  2: { transitionDelay: "30ms", animationDelay: "80ms" },
  3: { transitionDelay: "45ms", animationDelay: "120ms" },
  4: { transitionDelay: "60ms", animationDelay: "160ms" },
  5: { transitionDelay: "75ms", animationDelay: "200ms" },
  6: { transitionDelay: "90ms", animationDelay: "240ms" },
  7: { transitionDelay: "105ms", animationDelay: "280ms" },
  8: { transitionDelay: "120ms", animationDelay: "320ms" },
  9: { transitionDelay: "135ms", animationDelay: "360ms" },
  10: { transitionDelay: "150ms", animationDelay: "400ms" },
  11: { transitionDelay: "165ms", animationDelay: "440ms" },
  12: { transitionDelay: "180ms", animationDelay: "480ms" },
  13: { transitionDelay: "195ms", animationDelay: "520ms" },
  14: { transitionDelay: "210ms", animationDelay: "560ms" },
  15: { transitionDelay: "225ms", animationDelay: "600ms" },
});
/** The same, in the dither's order: integer keys keep it. */
const passDelays = Object.values(passAt);

/** Where the card's point stands: over the chosen face, from the middle. */
const pointAt = stylex.create({
  1: { insetInlineStart: `calc(50% - 2 * (${faceSize} + ${faceGap}))` },
  2: { insetInlineStart: `calc(50% - (${faceSize} + ${faceGap}))` },
  3: { insetInlineStart: "50%" },
  4: { insetInlineStart: `calc(50% + (${faceSize} + ${faceGap}))` },
  5: { insetInlineStart: `calc(50% + 2 * (${faceSize} + ${faceGap}))` },
});

/** The face's name stands under the face, wherever it is in the row. */
const nameAt = stylex.create({
  1: { transform: `translateX(calc(-2 * (${faceSize} + ${faceGap})))` },
  2: { transform: `translateX(calc(-1 * (${faceSize} + ${faceGap})))` },
  3: { transform: "none" },
  4: { transform: `translateX(calc(${faceSize} + ${faceGap}))` },
  5: { transform: `translateX(calc(2 * (${faceSize} + ${faceGap})))` },
});

/** The five faces, worst first: what each one draws, where its name stands and where the card points. */
const faces = [
  { mood: "worried", point: pointAt[1], name: nameAt[1] },
  { mood: "unsure", point: pointAt[2], name: nameAt[2] },
  { mood: "level", point: pointAt[3], name: nameAt[3] },
  { mood: "pleased", point: pointAt[4], name: nameAt[4] },
  { mood: "laughing", point: pointAt[5], name: nameAt[5] },
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

/** A light's passes, each in its stops; `shown` brings them in, `glinting` flashes them once. */
const Passes = ({
  passes,
  shown,
  glinting,
}: {
  passes: string[][];
  shown?: boolean;
  glinting?: boolean;
}) =>
  passes.map((inStops, pass) => (
    <g
      key={pass}
      {...stylex.props(
        glinting === true ? styles.glinting : styles.pass,
        shown === true && styles.shown,
        passDelays[pass]
      )}
    >
      {inStops.map((d, stop) =>
        d === "" ? null : (
          <path d={d} key={stop} {...stylex.props(stopStyles[stop])} />
        )
      )}
    </g>
  ));

/** How many passes of a face give way to the page when another is chosen. */
const FADED = 5;

/** The head at rest: every pass at once, so in each stop one path. */
const atRest = (passes: string[][]): string[] =>
  stopStyles.map((_, stop) => passes.map((inStops) => inStops[stop]).join(""));

/** One face: its head at rest, the lights that come and go over it, and its features on top. */
const Face = ({
  mood,
  lit,
  dim,
  chosen,
}: {
  mood: FaceMood;
  lit: boolean;
  dim: boolean;
  chosen: boolean;
}) => {
  const { heads, fade, rim, ink, glow, tongue } = ditherFaces[mood];
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${FACE_CELLS} ${FACE_CELLS}`}
      {...stylex.props(styles.drawing)}
    >
      {atRest(heads.rest).map((d, stop) =>
        d === "" ? null : (
          <path d={d} key={stop} {...stylex.props(stopStyles[stop])} />
        )
      )}
      <Passes passes={heads.lit} shown={lit} />
      {chosen ? <Passes glinting passes={heads.glint} /> : null}
      {fade.slice(0, FADED).map((d, pass) => (
        <path
          d={d}
          key={pass}
          {...stylex.props(
            styles.pass,
            styles.fade,
            dim && styles.shown,
            passDelays[pass]
          )}
        />
      ))}
      <path d={rim} {...stylex.props(stops.s2)} />
      <path d={ink} {...stylex.props(stops.s0)} />
      <path d={glow} {...stylex.props(stops.s5)} />
      <path d={tongue} {...stylex.props(stops.s3)} />
    </svg>
  );
};

/**
 * How it was to talk to him: five faces to press, and once one is
 * pressed, a card under it to say why. A face is kept at once; their words
 * when they send them (Enter, or the button).
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
  // Their words while they write them; the card stays open until they send.
  const [draft, setDraft] = useState(feedback ?? "");
  const [writing, setWriting] = useState(false);
  // The face under the pointer, to name it.
  const [over, setOver] = useState<number | null>(null);
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
  // Their words sent: thanks in a dialog, then the faces fold away. Sent
  // before this screen came, there is nothing left to ask.
  const [stage, setStage] = useState<"asking" | "thanked" | "leaving" | "gone">(
    feedback === undefined ? "asking" : "gone"
  );
  const leaving = stage === "leaving";
  const send = (): void => {
    onFeedback(draft);
    setWriting(false);
    if (draft.trim() !== "") {
      setStage("thanked");
    }
  };
  const fold = (): void => {
    // With reduced motion nothing moves, so nothing ends: gone at once.
    setStage(
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "gone"
        : "leaving"
    );
  };
  let heading = question;
  if (value !== undefined) {
    heading =
      feedback !== undefined && !writing
        ? t`Thank you for telling me.`
        : t`Thank you. Want to say why?`;
  }
  const named = over ?? value;
  const chosenFace = value === undefined ? undefined : faces[value - 1];
  const namedFace =
    named === undefined || named === null ? undefined : faces[named - 1];
  const thanks = (
    <Dialog
      onOpenChange={(opened) => {
        if (!opened) {
          fold();
        }
      }}
      open={stage === "thanked"}
    >
      <DialogContent>
        <DialogHeader>
          {chosenFace === undefined ? null : (
            <span {...stylex.props(styles.thanksFace)}>
              <Face chosen dim={false} lit mood={chosenFace.mood} />
            </span>
          )}
          <DialogTitle>{t`Thank you for telling me.`}</DialogTitle>
          <DialogDescription>
            {t`Every word helps ${who} get better at this.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose variant="default">{t`Continue`}</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  if (stage === "gone") {
    return null;
  }
  return (
    <div
      onTransitionEnd={(event) => {
        if (leaving && event.target === event.currentTarget) {
          setStage("gone");
        }
      }}
      {...stylex.props(styles.fold, leaving && styles.folded)}
    >
      {thanks}
      <div {...stylex.props(leaving ? styles.folding : styles.open)}>
        <fieldset {...stylex.props(styles.rating)}>
          <legend {...stylex.props(visuallyHidden)}>{question}</legend>
          <Text aria-live="polite" as="span" color="muted">
            {heading}
          </Text>
          <span {...stylex.props(styles.faces)}>
            {faces.map(({ mood }, at) => {
              const rating = at + 1;
              const chosen = value === rating;
              const under = over === rating;
              return (
                <button
                  aria-label={names[at]}
                  aria-pressed={chosen}
                  key={mood}
                  onBlur={() => {
                    setOver(null);
                  }}
                  onClick={() => {
                    onRate(rating);
                    setWriting(true);
                  }}
                  onFocus={() => {
                    setOver(rating);
                  }}
                  onPointerEnter={() => {
                    setOver(rating);
                  }}
                  onPointerLeave={() => {
                    setOver(null);
                  }}
                  type="button"
                  {...stylex.props(
                    styles.face,
                    lifts.lift,
                    focusRing,
                    value !== undefined && !chosen && styles.other,
                    chosen && styles.chosen
                  )}
                >
                  <Face
                    chosen={chosen}
                    dim={value !== undefined && !chosen && !under}
                    lit={chosen || under}
                    mood={mood}
                  />
                </button>
              );
            })}
          </span>
          <span
            aria-hidden="true"
            {...stylex.props(styles.name, namedFace?.name)}
          >
            {named === undefined || named === null ? "" : names[named - 1]}
          </span>
          {chosenFace !== undefined && writing ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
              {...stylex.props(styles.card)}
            >
              <span
                aria-hidden="true"
                {...stylex.props(styles.point, chosenFace.point)}
              />
              <label htmlFor={box} {...stylex.props(visuallyHidden)}>
                {asks}
              </label>
              <span {...stylex.props(styles.backing)}>
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
              </span>
              <Button size="sm" style={styles.send} type="submit">
                {t`Send`}
              </Button>
            </form>
          ) : null}
        </fieldset>
      </div>
    </div>
  );
};
