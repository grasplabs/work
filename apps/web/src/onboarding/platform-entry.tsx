import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, font, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { lightness, rgb, token } from "../brain/dot-ink.ts";
import type { BrainDots } from "../brain/dot-ink.ts";
import { DotsBuild } from "../brain/dots-build.tsx";
import { seeded } from "../brain/reveal-motion.ts";
import { sampleTargets } from "../brain/reveal-targets.ts";
import { speak } from "../voice/voice.ts";
import { entryOver, entryNow, subscribeEntry } from "./entry-store.ts";
import type { Entry, EntryFact } from "./entry-store.ts";

// The way from the setup into the platform. Over the story's last
// picture, still night, what the admin just set up gathers on the screen,
// a word at a time as Stephen's words came: the company in the middle,
// its teams, their leads, how many people, the documents, the day it
// starts. Then it all turns to dots, the night lifts into the platform's
// own ground, and the dots burst out and land on the platform's first
// page, its sidebar and its question and its box to ask in, as the brain
// builds a note's page (brain/dots-build.tsx); the page dissolves into
// view under them. Drawn over everything, and kept by the root, so it
// lives on while the page under it changes. Only under motion: reduced,
// the page simply changes (entry-store.ts).

/** How long one fact takes to arrive after the one before it. */
const STAGGER_MS = 95;
/** How long the gathered facts stand before they turn to dots. */
const HOLD_MS = 900;
/** How long the night takes to lift as the dots take over. */
const LIFT_MS = 520;
/** How long the build takes, as a share of the brain's own. */
const PACE = 0.85;

const arrive = stylex.keyframes({
  from: { opacity: 0, filter: "blur(10px)", transform: "translateY(0.4em)" },
  to: { opacity: 1, filter: "blur(0)", transform: "none" },
});

const cool = stylex.keyframes({
  from: { color: "var(--damsko-brand-lime)" },
  to: { color: "var(--damsko-foreground)" },
});

const lift = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const styles = stylex.create({
  night: {
    position: "fixed",
    inset: 0,
    zIndex: 2_147_483_000,
    backgroundColor: "transparent",
    pointerEvents: "auto",
    overflow: "hidden",
  },
  // The facts, over the story's picture: its own night shows through, darkened behind them.
  field: {
    position: "absolute",
    inset: 0,
    backgroundImage:
      "radial-gradient(ellipse at center, color-mix(in srgb, var(--damsko-brand-night) 82%, transparent) 0%, color-mix(in srgb, var(--damsko-brand-night) 55%, transparent) 70%)",
  },
  fact: {
    position: "absolute",
    margin: 0,
    whiteSpace: "nowrap",
    transform: "translate(-50%, -50%)",
    color: colors.foreground,
    fontFamily: font.sans,
    fontSize: { default: font.textBase, [media.maxSm]: font.textSm },
    letterSpacing: font.trackingTitle,
  },
  // Each fact rises out of a blur, briefly in lime, as the story's words did.
  word: {
    display: "inline-block",
    opacity: 0,
    animationName: `${arrive}, ${cool}`,
    animationDuration: "520ms, 1400ms",
    animationTimingFunction: "cubic-bezier(0.2, 0.8, 0.2, 1), ease-out",
    animationFillMode: "both, both",
  },
  company: {
    fontFamily: font.serif,
    fontWeight: font.weightNormal,
    fontSize: { default: font.headingXl, [media.maxSm]: font.headingLg },
    lineHeight: font.headingXlLine,
  },
  quiet: { opacity: 0.72 },
  // A small mark before a lead's name: they go first.
  lead: {
    display: "inline-block",
    width: space[2],
    height: space[2],
    marginInlineEnd: space[2],
    backgroundColor: colors.brandMint,
    verticalAlign: "middle",
  },
  delay: (ms: number) => ({
    animationDelay: `${String(ms)}ms, ${String(ms)}ms`,
  }),
  at: (x: number, y: number) => ({
    left: `${String(x)}%`,
    top: `${String(y)}%`,
  }),
  // The build, over the facts: in the platform's own mode and ground, so outside the night's.
  build: {
    position: "fixed",
    inset: 0,
    zIndex: 2_147_483_001,
    width: "100vw",
    height: "100vh",
    pointerEvents: "auto",
    animationName: lift,
    animationDuration: `${String(LIFT_MS)}ms`,
    animationTimingFunction: "ease-out",
    animationFillMode: "both",
  },
});

/**
 * Where each fact stands, as a share of the window: the company in the
 * middle, the rest around it on an ellipse, evenly, each a little off it
 * so it never reads as a clock face.
 */
const placesOf = (facts: readonly EntryFact[]): [number, number][] => {
  const around = facts.filter(({ kind }) => kind !== "company").length;
  const random = seeded(29);
  let index = 0;
  return facts.map(({ kind }) => {
    if (kind === "company") {
      return [50, 47];
    }
    const angle = -Math.PI / 2 + (index / Math.max(around, 1)) * Math.PI * 2;
    index += 1;
    const swing = 0.82 + random() * 0.3;
    return [
      50 + Math.cos(angle) * 34 * swing,
      47 + Math.sin(angle) * 31 * swing,
    ];
  });
};

/** The facts' words as dots, where they stand, with a dithered field of night around them. */
const dotsOf = (field: HTMLElement): BrainDots => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const words = sampleTargets(field, {
    width,
    height,
    skip: document.createElement("i"),
    ground: lightness(rgb(token(field, "--damsko-brand-night"))),
    budget: 2600,
  });
  // The night itself: a soft field of dots, densest in the middle, on a grid, as the dither is.
  const random = seeded(41);
  const sky: [number, number][] = [];
  const step = 11;
  const middleX = width / 2;
  const middleY = height * 0.47;
  const reach = Math.max(width, height) * 0.42;
  for (let y = step / 2; y < height; y += step) {
    for (let x = step / 2; x < width; x += step) {
      const away = Math.hypot(x - middleX, y - middleY) / reach;
      if (random() < 0.5 * Math.exp(-away * away * 1.6)) {
        sky.push([x, y]);
      }
    }
  }
  const kept = sky.slice(0, 2200);
  const count = words.count + kept.length;
  const dots: BrainDots = {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    r: new Float32Array(count),
    alpha: new Float32Array(count),
    heat: new Float32Array(count),
    middle: { x: middleX, y: middleY },
  };
  for (let index = 0; index < words.count; index += 1) {
    dots.x[index] = words.x[index] ?? 0;
    dots.y[index] = words.y[index] ?? 0;
    dots.r[index] = Math.max(words.r[index] ?? 1, 1);
    dots.alpha[index] = 0.6 + 0.4 * (words.tone[index] ?? 0);
    dots.heat[index] = 0.9;
  }
  for (const [offset, [x, y]] of kept.entries()) {
    const index = words.count + offset;
    dots.x[index] = x;
    dots.y[index] = y;
    dots.r[index] = 0.9;
    dots.alpha[index] = 0.35;
    dots.heat[index] = 0.55;
  }
  return dots;
};

/** The platform's first page shows underneath: its question is there. */
const landed = (): boolean => document.querySelector("#new-chat") !== null;

/**
 * What the dots build: the platform's page, its sidebar and its main part;
 * the whole page where the question can't be found.
 */
const pageOf = (): Element => {
  const question = document.querySelector("#new-chat");
  const side = document.querySelector('[data-sidebar="sidebar"]');
  if (question === null || side === null) {
    return question?.closest("main") ?? document.body;
  }
  let around: Element | null = question;
  while (around !== null && !around.contains(side)) {
    around = around.parentElement;
  }
  return around ?? document.body;
};

const Gathering = ({
  entry,
  onBuild,
}: {
  entry: Entry;
  onBuild: (dots: BrainDots) => void;
}) => {
  const { t } = useLingui();
  const field = useRef<HTMLDivElement>(null);
  const places = placesOf(entry.facts);
  const latest = useRef(onBuild);
  useLayoutEffect(() => {
    latest.current = onBuild;
  });
  useEffect(() => {
    speak(t`Here’s your Grasp.`);
    const ms = entry.facts.length * STAGGER_MS + 520 + HOLD_MS;
    const id = window.setTimeout(() => {
      if (field.current !== null) {
        latest.current(dotsOf(field.current));
      }
    }, ms);
    return () => {
      window.clearTimeout(id);
    };
  }, [entry, t]);
  return (
    <section
      aria-label={t`Opening Grasp`}
      data-mode="dark"
      ref={field}
      {...stylex.props(styles.night, styles.field)}
    >
      {entry.facts.map((fact, index) => {
        const [x, y] = places[index] ?? [50, 50];
        return (
          <p
            key={`${fact.kind}-${String(index)}`}
            {...stylex.props(
              styles.fact,
              styles.at(x, y),
              fact.kind === "company" && styles.company
            )}
          >
            <span
              {...stylex.props(
                styles.word,
                styles.delay(index * STAGGER_MS),
                (fact.kind === "people" || fact.kind === "document") &&
                  styles.quiet
              )}
            >
              {fact.kind === "lead" ? (
                <span aria-hidden="true" {...stylex.props(styles.lead)} />
              ) : null}
              {fact.text}
            </span>
          </p>
        );
      })}
      <output {...stylex.props(visuallyHidden)}>{t`Opening Grasp`}</output>
    </section>
  );
};

/** Changes the page under the layer; failing that, the dots build whatever page is there. */
const goQuietly = async (entry: Entry): Promise<void> => {
  try {
    await entry.go();
  } catch {
    // Nothing to show: the page that is there is built.
  }
};

const Playing = ({ entry }: { entry: Entry }) => {
  const { t } = useLingui();
  const [dots, setDots] = useState<BrainDots | null>(null);
  const [gone, setGone] = useState(false);
  return createPortal(
    <>
      {gone ? null : (
        <Gathering
          entry={entry}
          onBuild={(built) => {
            setDots(built);
            // The page changes under the dots: they hold until it is there.
            void goQuietly(entry);
          }}
        />
      )}
      {dots === null ? null : (
        <DotsBuild
          from={dots}
          label={t`Opening Grasp`}
          layer={styles.build}
          onArrive={() => {
            setGone(true);
          }}
          onEnd={entryOver}
          pace={PACE}
          ready={landed}
          root={pageOf}
          sketch
          way="burst"
        />
      )}
    </>,
    document.body
  );
};

/** Kept by the root: plays the way in when the setup asks for it. */
export const PlatformEntry = () => {
  const [entry, setEntry] = useState(entryNow);
  useEffect(
    () =>
      subscribeEntry(() => {
        setEntry(entryNow());
      }),
    []
  );
  return entry === null ? null : <Playing entry={entry} />;
};
