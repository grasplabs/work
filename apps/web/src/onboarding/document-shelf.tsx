import { Button } from "@grasp-os/ui/components/button";
import { Icon, XIcon } from "@grasp-os/ui/lib/icons";
import { colors, font, radius, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import { kindOfName } from "./document-pages.tsx";
import { useStill } from "./pixel-cursor.tsx";
import { PixelPage } from "./pixel-page.tsx";

// What was shared on the documents step, under its drop zone: one small
// chip a document, its own pixel page (pixel-page.tsx) and its name, side by
// side. A file on its way has the same chip, its page filling in cell by
// cell as it is sent and read, its name pale until it is in; then it is
// simply one of the documents shared, with Remove. One that could not be
// read says why, with Try again. A chip arrives with a small pixel step,
// as the pages do; under reduced motion it is just there.

const arrive = stylex.keyframes({
  "0%": { opacity: 0, transform: "scale(0.7)" },
  "100%": { opacity: 1, transform: "scale(1)" },
});

const styles = stylex.create({
  shelf: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
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
    minHeight: 40,
    paddingBlock: 6,
    paddingInlineStart: 10,
    paddingInlineEnd: 4,
    borderRadius: radius.lg,
    backgroundColor: colors.muted,
    animationName: {
      default: arrive,
      "@media (prefers-reduced-motion: reduce)": "none",
    },
    animationDuration: "240ms",
    animationTimingFunction: "steps(4, end)",
  },
  // A document already in comes without a step: only a file arriving makes one.
  settled: { animationName: "none" },
  // A chip without an action at its end keeps the same room there.
  bare: { paddingInlineEnd: 12 },
  page: { display: "flex", flexShrink: 0 },
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
  problem: {
    color: colors.destructive,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
  },
});

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
  return (
    <li {...stylex.props(styles.chip, problem === null && styles.bare)}>
      <span {...stylex.props(styles.page)}>
        <PixelPage cell={2} filled={filled} kind={kindOfName(name)} />
      </span>
      <span {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.name, !done && styles.coming)}>
          {name}
        </span>
        {problem === null ? null : (
          <span {...stylex.props(styles.problem)}>{problem}</span>
        )}
      </span>
      {problem === null ? null : (
        <>
          <Button onClick={onRetry} size="xs" variant="ghost">
            {t`Try again`}
          </Button>
          <Button
            aria-label={t`Remove ${name}`}
            onClick={onDismiss}
            size="icon-xs"
            variant="ghost"
          >
            <Icon icon={XIcon} />
          </Button>
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
          </span>
          <span {...stylex.props(styles.words)}>
            <span {...stylex.props(styles.name)}>{name}</span>
          </span>
          <Button
            aria-label={t`Remove ${name}`}
            disabled={busy}
            onClick={() => {
              onRemove(id);
            }}
            size="icon-xs"
            variant="ghost"
          >
            <Icon icon={XIcon} />
          </Button>
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
