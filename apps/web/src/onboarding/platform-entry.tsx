import { colors, font, media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { speak } from "../voice/voice.ts";
import { entryNow, entryOver, subscribeEntry } from "./entry-store.ts";
import type { Entry, EntryFact } from "./entry-store.ts";

// The way from the setup into the platform. On the story's night, what
// the admin just set up arrives as small chips around the company's name:
// its teams, their leads, how many people, the documents, the day it
// starts. Under the night, already, the platform's first page opens and
// settles, hidden. Then the night lifts, and each chip flies to the part
// of the page it becomes (the company and its teams to the sidebar, the
// documents into the box to ask in, the day to the question), and that
// part rises into view as it lands. Only transforms and opacity move, on
// a dozen or so elements, so the browser's compositor carries it all; the
// page is built and painted before anything moves over it. Kept by the
// root, so it lives on while the page under it changes. Under reduced
// motion the page simply changes (entry-store.ts).

/** How long one chip takes to arrive after the one before it. */
const STAGGER_MS = 70;
/** How long the night takes to fall over the story, before the first chip comes. */
const FALL_MS = 450;
/** How long a chip takes to arrive. */
const ARRIVE_MS = 520;
/** How long the gathered chips stand, at least, before they go. */
const HOLD_MS = 650;
/** How long the night takes to lift. */
const LIFT_MS = 700;
/** How long a chip flies to its place, and how much later each next one leaves. */
const FLY_MS = 950;
const FLY_STAGGER_MS = 35;
/** How long a part of the page takes to rise into view once its chips landed. */
const RISE_MS = 620;
/** How long the platform's page is given to be there and settle before the night lifts anyway. */
const PATIENCE_MS = 4000;

const ease = "cubic-bezier(0.65, 0, 0.35, 1)";
const easeOut = "cubic-bezier(0.16, 1, 0.3, 1)";

const styles = stylex.create({
  layer: {
    position: "fixed",
    inset: 0,
    zIndex: 2_147_483_000,
    pointerEvents: "auto",
    overflow: "hidden",
    contain: "strict",
  },
  // The night, its own layer, so lifting it is one change of opacity.
  night: {
    position: "absolute",
    inset: 0,
    backgroundColor: colors.brandNight,
    backgroundImage:
      "radial-gradient(ellipse at 50% 47%, color-mix(in srgb, var(--damsko-brand-pine) 55%, transparent) 0%, transparent 65%)",
    willChange: "opacity",
  },
  // His words under the company's name, on the night, and gone with it.
  caption: {
    position: "absolute",
    insetInline: 0,
    insetBlockStart: {
      default: "calc(46% + 3rem)",
      [media.maxSm]: "calc(46% + 2.25rem)",
    },
    display: "block",
    textAlign: "center",
    color: colors.brandMint,
    fontFamily: font.sans,
    fontSize: font.textBase,
    opacity: 0,
    willChange: "opacity",
  },
  chip: {
    position: "absolute",
    insetInlineStart: 0,
    insetBlockStart: 0,
    display: "inline-flex",
    alignItems: "center",
    gap: space[2],
    whiteSpace: "nowrap",
    paddingBlock: space[1],
    paddingInline: space[3],
    borderRadius: "999px",
    backgroundColor: colors.brandMint,
    color: colors.brandNight,
    fontFamily: font.sans,
    fontSize: { default: font.textSm, [media.maxSm]: font.textXs },
    opacity: 0,
    willChange: "transform, opacity",
  },
  quiet: {
    backgroundColor:
      "color-mix(in srgb, var(--damsko-brand-mint) 30%, transparent)",
    color: colors.brandPaper,
  },
  company: {
    paddingBlock: 0,
    paddingInline: 0,
    backgroundColor: "transparent",
    color: colors.brandPaper,
    fontFamily: font.serif,
    fontWeight: font.weightNormal,
    fontSize: { default: font.headingXl, [media.maxSm]: font.headingLg },
    lineHeight: font.headingXlLine,
  },
  // A small mark before a lead's name: they go first.
  lead: {
    display: "inline-block",
    width: "6px",
    height: "6px",
    backgroundColor: colors.brandNight,
  },
});

/**
 * Where each chip stands, as a share of the window: the company in the
 * middle, the rest around it on an ellipse, evenly, each a little in or
 * out so it never reads as a clock face.
 */
const placesOf = (facts: readonly EntryFact[]): [number, number][] => {
  const around = facts.filter(({ kind }) => kind !== "company").length;
  let index = 0;
  return facts.map(({ kind }) => {
    if (kind === "company") {
      return [0.5, 0.46];
    }
    const angle = -Math.PI / 2 + (index / Math.max(around, 1)) * Math.PI * 2;
    const swing = index % 2 === 0 ? 1 : 0.82;
    index += 1;
    return [
      0.5 + Math.cos(angle) * 0.34 * swing,
      0.46 + Math.sin(angle) * 0.3 * swing,
    ];
  });
};

/** The parts of the platform's page the chips become; any missing is left out. */
interface Parts {
  side: Element | null;
  question: Element | null;
  ask: Element | null;
}

/** A part on the screen; none where it is hidden or off it, as the side is on a phone. */
const onScreen = (part: Element | null): Element | null => {
  if (part === null) {
    return null;
  }
  const box = part.getBoundingClientRect();
  return box.width > 0 &&
    box.height > 0 &&
    box.right > 0 &&
    box.left < window.innerWidth
    ? part
    : null;
};

const partsOf = (): Parts => {
  const question = onScreen(document.querySelector("#new-chat"));
  return {
    // No side on the screen: what would go there goes to the question.
    side:
      onScreen(document.querySelector('[data-sidebar="sidebar"]')) ?? question,
    question,
    ask: onScreen(question?.nextElementSibling ?? null),
  };
};

/** The page is there: its question is on it. */
const landed = (): boolean => document.querySelector("#new-chat") !== null;

const wait = async (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  window.setTimeout(() => {
    resolve(true);
  }, ms);
  await promise;
};

const frame = async (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<number>();
  requestAnimationFrame(resolve);
  await promise;
};

/**
 * Until the platform's page is there and the browser has room to spare:
 * it is built, laid out and painted under the night, before anything
 * moves over it. Not longer than PATIENCE_MS.
 */
const settled = async (since: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const look = () => {
    if (landed() || performance.now() - since >= PATIENCE_MS) {
      resolve(true);
      return;
    }
    window.setTimeout(look, 50);
  };
  look();
  await promise;
  const idle = Promise.withResolvers<boolean>();
  requestIdleCallback(
    () => {
      idle.resolve(true);
    },
    { timeout: Math.max(PATIENCE_MS - (performance.now() - since), 200) }
  );
  await idle.promise;
  await frame();
  await frame();
};

/** Where a chip of `kind` lands: the part it becomes, and a point on it. */
const targetOf = (
  kind: EntryFact["kind"],
  order: number,
  parts: Parts
): { part: Element | null; x: number; y: number } => {
  const middle = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const pick = (part: Element | null, row: number, rows: number) => {
    if (part === null) {
      return { part, ...middle };
    }
    const box = part.getBoundingClientRect();
    return {
      part,
      x: box.left + box.width / 2,
      y: box.top + (box.height * (row + 0.5)) / rows,
    };
  };
  if (kind === "company") {
    return pick(parts.side, 0, 12);
  }
  if (kind === "team" || kind === "lead") {
    return pick(parts.side, 2 + (order % 6), 12);
  }
  // The documents go into the box to ask in; how many people and the day, to the question.
  return kind === "document"
    ? pick(parts.ask, 0, 1)
    : pick(parts.question, 0, 1);
};

/** Readies the platform's page; failing that, `go` fetches what it needs itself. */
const readyQuietly = async (entry: Entry): Promise<void> => {
  try {
    await entry.ready?.();
  } catch {
    // Fetched again as the page opens.
  }
};

/** Changes the page under the night, once it is ready; failing that, whatever page is there is shown. */
const goQuietly = async (
  entry: Entry,
  readying: Promise<void>
): Promise<void> => {
  await readying;
  try {
    await entry.go();
  } catch {
    // Nothing else to show.
  }
};

/** Plays it: the chips arrive, the page settles under the night, the night lifts, the chips fly home. */
const play = async (
  layer: HTMLElement,
  entry: Entry,
  onDone: () => void
): Promise<void> => {
  const night = layer.querySelector<HTMLElement>("[data-night]");
  const chips = [...layer.querySelectorAll<HTMLElement>("[data-chip]")];
  const places = placesOf(entry.facts);
  const width = window.innerWidth;
  const height = window.innerHeight;
  // While the night falls and the chips gather, the page's data and code are fetched.
  const readying = readyQuietly(entry);
  // The night falls over the story first: no cut.
  night?.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: FALL_MS,
    easing: ease,
    fill: "backwards",
  });
  // Each chip arrives where it stands, rising a little.
  const arrivals = chips.map((chip, index) => {
    const [px, py] = places[index] ?? [0.5, 0.5];
    const x = px * width - chip.offsetWidth / 2;
    const y = py * height - chip.offsetHeight / 2;
    chip.dataset.x = String(x);
    chip.dataset.y = String(y);
    return chip.animate(
      [
        { transform: `translate(${x}px, ${y + 14}px) scale(0.96)`, opacity: 0 },
        { transform: `translate(${x}px, ${y}px) scale(1)`, opacity: 1 },
      ],
      {
        duration: ARRIVE_MS,
        delay: FALL_MS * 0.6 + index * STAGGER_MS,
        easing: easeOut,
        fill: "both",
      }
    );
  });
  layer
    .querySelector("[data-caption]")
    ?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: ARRIVE_MS,
      delay: FALL_MS * 0.6 + chips.length * STAGGER_MS,
      easing: easeOut,
      fill: "both",
    });
  await Promise.all(arrivals.map(async ({ finished }) => await finished));
  // Only once every chip stands does the page change under the night: building it is the
  // heaviest moment, and nothing moves while it happens.
  const since = performance.now();
  await Promise.all([goQuietly(entry, readying), wait(HOLD_MS)]);
  await settled(since);

  const parts = partsOf();
  // Each part once, as the side is the question where there is no side on the screen.
  const shown = [...new Set([parts.side, parts.question, parts.ask])].filter(
    (part): part is Element => part !== null
  );
  // The page's parts wait, unseen, for their chips.
  const hidden = shown.map((part) =>
    part.animate([{ opacity: 0 }, { opacity: 0 }], { fill: "both" })
  );
  night?.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: LIFT_MS,
    easing: ease,
    fill: "forwards",
  });
  // Each part rises in as the last of its chips lands; one nothing flies to, as the night lifts.
  const lands = new Map<Element, number>();
  let teams = 0;
  const flights = chips.map((chip, index) => {
    const fact = entry.facts[index];
    const sided = fact?.kind === "team" || fact?.kind === "lead";
    const order = sided ? teams : 0;
    teams += sided ? 1 : 0;
    const target = targetOf(fact?.kind ?? "start", order, parts);
    const delay = LIFT_MS * 0.35 + index * FLY_STAGGER_MS;
    if (target.part !== null) {
      lands.set(
        target.part,
        Math.max(lands.get(target.part) ?? 0, delay + FLY_MS * 0.7)
      );
    }
    const x = Number(chip.dataset.x);
    const y = Number(chip.dataset.y);
    const toX = target.x - chip.offsetWidth / 2;
    const toY = target.y - chip.offsetHeight / 2;
    return chip.animate(
      [
        { transform: `translate(${x}px, ${y}px) scale(1)`, opacity: 1 },
        {
          transform: `translate(${(x + toX) / 2}px, ${Math.min(y, toY) - 24}px) scale(0.9)`,
          opacity: 1,
          offset: 0.55,
        },
        { transform: `translate(${toX}px, ${toY}px) scale(0.35)`, opacity: 0 },
      ],
      { duration: FLY_MS, delay, easing: ease, fill: "both" }
    );
  });
  const rises = shown.map((part, index) => {
    hidden[index]?.cancel();
    return part.animate(
      [
        { opacity: 0, transform: "translateY(10px)" },
        { opacity: 1, transform: "none" },
      ],
      {
        duration: RISE_MS,
        delay: lands.get(part) ?? LIFT_MS * 0.5,
        easing: easeOut,
        fill: "backwards",
      }
    );
  });
  await Promise.all(
    [...flights, ...rises].map(async ({ finished }) => {
      try {
        await finished;
      } catch {
        // Cancelled: over all the same.
      }
    })
  );
  onDone();
};

const Playing = ({ entry }: { entry: Entry }) => {
  const { t } = useLingui();
  const layer = useRef<HTMLDivElement>(null);
  const latest = useRef(entry);
  useLayoutEffect(() => {
    latest.current = entry;
  });
  useEffect(() => {
    speak(t`Let’s start exploring Grasp.`);
    if (layer.current !== null) {
      void play(layer.current, latest.current, entryOver);
    }
  }, [t]);
  return createPortal(
    <div data-mode="dark" ref={layer} {...stylex.props(styles.layer)}>
      <div data-night="" {...stylex.props(styles.night)}>
        <output data-caption="" {...stylex.props(styles.caption)}>
          {t`Let’s start exploring Grasp.`}
        </output>
      </div>
      {entry.facts.map((fact, index) => (
        <span
          data-chip=""
          key={`${fact.kind}-${String(index)}`}
          {...stylex.props(
            styles.chip,
            (fact.kind === "people" || fact.kind === "document") &&
              styles.quiet,
            fact.kind === "company" && styles.company
          )}
        >
          {fact.kind === "lead" ? (
            <span aria-hidden="true" {...stylex.props(styles.lead)} />
          ) : null}
          {fact.text}
        </span>
      ))}
    </div>,
    document.body
  );
};

/** Kept by the root: plays the way in when the setup asks for it. */
export const PlatformEntry = () => {
  const entry = useSyncExternalStore(subscribeEntry, entryNow, () => null);
  return entry === null ? null : <Playing entry={entry} />;
};
