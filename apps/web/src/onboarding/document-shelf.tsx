import { Button } from "@grasp-os/ui/components/button";
import { Icon, XIcon } from "@grasp-os/ui/lib/icons";
import { colors, font, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { kindOfName } from "./document-pages.tsx";
import { keysOf, useStill } from "./pixel-cursor.tsx";
import { PixelPage } from "./pixel-page.tsx";

// What was shared on the documents step, over its drop zone from its start
// edge, one chip after the other: its own pixel page (pixel-page.tsx) and
// its name. A file on its way says so under its name, "Uploading…", its
// page pale and filling in cell by cell as it is sent and read; once in,
// the line goes, its name darkens and a small green pixel tick lands on its
// page: it is in. Then Remove, a plain cross that greys on hover and focus.
// One that could not be read says why, with Try again. A chip arrives with
// a small pixel step, as the pages do; under reduced motion it is just there.

const arrive = stylex.keyframes({
  "0%": { opacity: 0, transform: "scale(0.7)" },
  "100%": { opacity: 1, transform: "scale(1)" },
});

const land = stylex.keyframes({
  "0%": { opacity: 0, transform: "translateY(-4px) scale(0.4)" },
  "100%": { opacity: 1, transform: "translateY(0) scale(1)" },
});

const stepIn = {
  animationDuration: "240ms",
  animationTimingFunction: "steps(4, end)",
} as const;

const styles = stylex.create({
  shelf: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-start",
    gap: space[2],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: space[2],
    minWidth: 0,
    maxWidth: "100%",
    minHeight: 44,
    paddingBlock: 6,
    paddingInlineStart: 10,
    paddingInlineEnd: 6,
    borderRadius: radius.lg,
    backgroundColor: colors.muted,
    animationName: {
      default: arrive,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    ...stepIn,
  },
  // A document already in comes without a step: only a file arriving makes one.
  settled: { animationName: "none" },
  // A chip without an action at its end keeps the same room there.
  bare: { paddingInlineEnd: 14 },
  page: { position: "relative", display: "flex", flexShrink: 0 },
  // The tick, on the page's foot corner, a little over its edge.
  tick: {
    position: "absolute",
    insetBlockEnd: -4,
    insetInlineEnd: -6,
    display: "block",
    fill: colors.success,
    animationName: {
      default: land,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    ...stepIn,
  },
  tickSettled: { animationName: "none" },
  words: { display: "grid", minWidth: 0 },
  name: {
    overflow: "hidden",
    maxWidth: "16rem",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    color: colors.foreground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    transitionProperty: "color",
    transitionDuration: "240ms",
  },
  coming: { color: colors.mutedForeground },
  line: {
    color: colors.mutedForeground,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
  },
  problem: { color: colors.destructive },
  // Remove: a plain cross, greyed under the pointer and on focus; no ring of its own, the grey says it.
  remove: {
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    width: 28,
    height: 28,
    padding: 0,
    border: "none",
    borderRadius: radius.md,
    color: colors.mutedForeground,
    backgroundColor: {
      default: "transparent",
      ":hover": colors.accentActive,
      ":focus-visible": colors.accentActive,
    },
    outline: "none",
    cursor: "pointer",
    transitionProperty: "background-color, color",
    transitionDuration: "120ms",
    ":hover": { color: colors.foreground },
    ":disabled": { cursor: "default", opacity: 0.5 },
  },
});

/** The tick, a character a cell: its green (x); its white rim is drawn round it. */
const tickCells = [".....x", "....xx", "x..xx.", "xxxx..", ".xx..."];
const tickCell = 2;

/** The tick's cells and the white ones round them, so it reads on any page. */
const tickRects = (() => {
  const on = new Set<string>();
  for (const [y, row] of tickCells.entries()) {
    for (const [x, mark] of keysOf(row).entries()) {
      if (mark === "x") {
        on.add(`${String(x + 1)},${String(y + 1)}`);
      }
    }
  }
  const rim = new Set<string>();
  for (const spot of on) {
    const [x = 0, y = 0] = spot.split(",").map(Number);
    for (const dx of [-1, 0, 1]) {
      for (const dy of [-1, 0, 1]) {
        const near = `${String(x + dx)},${String(y + dy)}`;
        if (!on.has(near)) {
          rim.add(near);
        }
      }
    }
  }
  return { on: [...on], rim: [...rim] };
})();

/** A small green pixel tick: this one is in. */
const Tick = ({ settled }: { settled: boolean }) => {
  const toRect = (spot: string, white: boolean) => {
    const [x = 0, y = 0] = spot.split(",").map(Number);
    return (
      <rect
        fill={white ? "white" : undefined}
        height={tickCell}
        key={`${white ? "r" : "t"}${spot}`}
        width={tickCell}
        x={x * tickCell}
        y={y * tickCell}
      />
    );
  };
  return (
    <svg
      aria-hidden="true"
      height={(tickCells.length + 2) * tickCell}
      shapeRendering="crispEdges"
      width={8 * tickCell}
      {...stylex.props(styles.tick, settled && styles.tickSettled)}
    >
      {tickRects.rim.map((spot) => toRect(spot, true))}
      {tickRects.on.map((spot) => toRect(spot, false))}
    </svg>
  );
};

/** Remove, as a plain cross. */
const Remove = ({
  name,
  disabled = false,
  onClick,
}: {
  name: string;
  disabled?: boolean;
  onClick: () => void;
}) => {
  const { t } = useLingui();
  return (
    <button
      aria-label={t`Remove ${name}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
      {...stylex.props(styles.remove)}
    >
      <Icon icon={XIcon} />
    </button>
  );
};

/** A file on its way: sent and read, or refused with why. */
export interface Sending {
  file: File;
  /** In: the page fills to the end before the chip becomes the document's own. */
  done: boolean;
  problem: string | null;
}

/** How far a file's page has filled: on toward most of the way while it is sent, all of it once in. */
const useFilled = (done: boolean, failed: boolean): number => {
  const still = useStill();
  const [filled, setFilled] = useState(0);
  useEffect(() => {
    if (still || failed) {
      return () => {
        // Nothing moves.
      };
    }
    const start = performance.now();
    let shown = 0;
    let frame = 0;
    const tick = (now: number) => {
      // Never quite there until it is: most of the way in the first seconds, then slower and slower.
      const target = done ? 1 : 0.88 * (1 - Math.exp(-(now - start) / 1600));
      shown += (target - shown) * (done ? 0.25 : 0.12);
      // A step at a time, as the cells come: no more drawing than that.
      const stepped = Math.round(shown * 32) / 32;
      setFilled(stepped);
      if (!(done && stepped >= 1)) {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [done, failed, still]);
  if (failed) {
    return 0;
  }
  if (still) {
    return done ? 1 : 0.5;
  }
  return filled;
};

const ComingChip = ({
  sending,
  onRetry,
  onDismiss,
}: {
  sending: Sending;
  onRetry: () => void;
  onDismiss: () => void;
}) => {
  const { t } = useLingui();
  const { file, done, problem } = sending;
  const filled = useFilled(done, problem !== null);
  const { name } = file;
  let line = null;
  if (problem !== null) {
    line = (
      <span {...stylex.props(styles.line, styles.problem)}>{problem}</span>
    );
  } else if (!done) {
    line = <span {...stylex.props(styles.line)}>{t`Uploading…`}</span>;
  }
  return (
    <li {...stylex.props(styles.chip, problem === null && styles.bare)}>
      <span {...stylex.props(styles.page)}>
        <PixelPage cell={2} filled={filled} kind={kindOfName(name)} />
        {done ? <Tick settled={false} /> : null}
      </span>
      <span {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.name, !done && styles.coming)}>
          {name}
        </span>
        {line}
      </span>
      {problem === null ? null : (
        <>
          <Button onClick={onRetry} size="xs" variant="ghost">
            {t`Try again`}
          </Button>
          <Remove name={name} onClick={onDismiss} />
        </>
      )}
    </li>
  );
};

/**
 * The documents shared (`kept`, newest first, as core lists them) and the
 * files on their way (`coming`), one chip each, in the order they came.
 */
export const DocumentShelf = ({
  kept,
  coming,
  busy,
  onRemove,
  onRetry,
  onDismiss,
}: {
  kept: readonly { id: string; name: string }[];
  coming: readonly Sending[];
  busy: boolean;
  onRemove: (id: string) => void;
  onRetry: (file: File) => void;
  onDismiss: (file: File) => void;
}) => {
  const { t } = useLingui();
  // A file just in is still its own chip for a moment, its page filling to the end: not twice.
  const arriving = new Set(coming.map(({ file }) => file.name));
  const shared = kept.filter(({ name }) => !arriving.has(name)).toReversed();
  if (shared.length === 0 && coming.length === 0) {
    return null;
  }
  return (
    <ul aria-label={t`Documents you shared`} {...stylex.props(styles.shelf)}>
      {shared.map(({ id, name }) => (
        <li key={id} {...stylex.props(styles.chip, styles.settled)}>
          <span {...stylex.props(styles.page)}>
            <PixelPage cell={2} kind={kindOfName(name)} />
            <Tick settled />
          </span>
          <span {...stylex.props(styles.words)}>
            <span {...stylex.props(styles.name)}>{name}</span>
          </span>
          <Remove
            disabled={busy}
            name={name}
            onClick={() => {
              onRemove(id);
            }}
          />
        </li>
      ))}
      {coming.map((sending) => (
        <ComingChip
          key={`${sending.file.name}-${String(sending.file.lastModified)}-${String(sending.file.size)}`}
          onDismiss={() => {
            onDismiss(sending.file);
          }}
          onRetry={() => {
            onRetry(sending.file);
          }}
          sending={sending}
        />
      ))}
    </ul>
  );
};
