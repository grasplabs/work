// ComposerAttachments: the strip of files above a composer's text (composer.tsx). Many files scroll
// sideways inside it; it never grows the composer taller without limit. A card arrives by growing
// from the plus button's side and fading in; one that leaves shrinks and fades while the others
// close up; the strip's own height eases open and shut. With reduced motion, nothing moves or fades.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import { simply } from "../motion/simply.stylex";
import { scroll } from "../scroll/scroll";
import { grasp, media } from "../tokens/tokens.stylex";
import { ms } from "../tokens/tokens.values";
import { ComposerAttachment } from "./attachment";
import type {
  ComposerAttachmentStatus,
  ComposerAttachmentWords,
} from "./attachment";
import { stripVars } from "./strip.stylex";

/** One file in a composer's strip. */
export interface ComposerFile {
  /** Its own key. */
  id: string;
  /** Its name ("brief.pdf"). */
  name: string;
  /** Its size in bytes. */
  size?: number;
  /** Its pages, for a document. */
  pages?: number;
  /** Its media type ("image/png"). */
  type?: string;
  /** A picture of it, such as an image's own address. */
  preview?: string;
  /** Where it is. */
  status?: ComposerAttachmentStatus;
  /** How far it has uploaded, from 0 to 1. */
  progress?: number;
  /** Why it failed or was refused. */
  reason?: string;
}

interface StripProps {
  files: ComposerFile[];
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
  onOpen?: (id: string) => void;
  words?: Partial<ComposerAttachmentWords>;
  label: string;
}

const REDUCED = media.reduced;

const arrive = stylex.keyframes({
  from: { opacity: 0, transform: `scale(${grasp.attachmentFromScale})` },
  to: { opacity: 1, transform: "none" },
});

const leave = stylex.keyframes({
  from: {
    opacity: 1,
    transform: "none",
    gridTemplateColumns: "minmax(0, 1fr)",
  },
  to: {
    opacity: 0,
    transform: `scale(${grasp.attachmentFromScale})`,
    gridTemplateColumns: "minmax(0, 0fr)",
    marginInlineEnd: `calc(-1 * ${grasp.space2})`,
  },
});

const styles = stylex.create({
  // The strip's height eases between nothing and its row of cards.
  shell: {
    display: "grid",
    gridTemplateRows: "0fr",
    transitionProperty: "grid-template-rows",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  shellOpen: {
    gridTemplateRows: "1fr",
  },
  clip: {
    minHeight: 0,
    overflow: "hidden",
  },
  strip: {
    display: "flex",
    gap: grasp.space2,
    margin: 0,
    paddingInline: grasp.space4,
    paddingBlockStart: grasp.space4,
    // Room for a card's edge and focus ring inside the sideways scroll.
    paddingBlockEnd: grasp.space1,
    listStyle: "none",
    overflowX: "auto",
    overflowY: "hidden",
    // A card's widest is the strip's own width (attachment.tsx), so a long name never runs past it.
    containerType: "inline-size",
    scrollPaddingInline: grasp.space4,
    // More files than room: the side with more beyond it fades out to the ground, so a card is
    // never cut off in silence and the strip says it scrolls without a bar. The fade is wide, and
    // its last band shows only the ground, so a card's border dissolves before the composer's edge
    // (watchEdges sets how far each side reaches).
    maskImage: `linear-gradient(to right, transparent ${stripVars.leftClear}, black ${stripVars.left}, black calc(100% - ${stripVars.right}), transparent calc(100% - ${stripVars.rightClear}))`,
  },
  // How far each side's fade reaches, from the cards past it.
  fades: (
    left: string,
    leftClear: string,
    right: string,
    rightClear: string
  ) => ({
    [stripVars.left]: left,
    [stripVars.leftClear]: leftClear,
    [stripVars.right]: right,
    [stripVars.rightClear]: rightClear,
  }),
  // Each card is as wide as its name; a one-column grid lets one that leaves close its width from
  // whatever it is down to nothing.
  item: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    flexShrink: 0,
    // It grows from the start side, where the plus button is.
    transformOrigin: "left center",
    animationName: { default: arrive, [REDUCED]: "none" },
    animationDuration: grasp.durationUi,
    animationTimingFunction: grasp.ease,
  },
  leaving: {
    overflow: "hidden",
    pointerEvents: "none",
    animationName: { default: leave, [REDUCED]: "none" },
    opacity: { default: null, [REDUCED]: 0 },
    animationDuration: grasp.durationLeave,
    animationTimingFunction: grasp.ease,
    animationFillMode: "forwards",
  },
});

type Shown = ComposerFile & { leaving?: boolean };

/**
 * How far into the strip from its `edge` (a physical side, in pixels from the left) the card cut by
 * that edge reaches. A card that would show less than half of itself is given wholly to the fade,
 * with the gap before it; one that shows half or more fades out over the usual width.
 */
const cutCard = (element: HTMLElement, edge: "left" | "right") => {
  const box = element.getBoundingClientRect();
  const cards = [...element.children].map((card) =>
    card.getBoundingClientRect()
  );
  // The gap between two cards, as they stand.
  const [first, second] = cards.toSorted((a, b) => a.left - b.left);
  const gap =
    first !== undefined && second !== undefined
      ? Math.max(0, second.left - first.right)
      : 0;
  for (const own of cards) {
    const shown =
      edge === "right" ? box.right - own.left : own.right - box.left;
    const cut =
      edge === "right"
        ? own.left < box.right && own.right > box.right
        : own.right > box.left && own.left < box.left;
    if (cut && shown < own.width / 2) {
      return shown + gap;
    }
  }
  return 0;
};

/** One side's fade: none, or the usual width (more when a card shows less than half of itself). */
const fadeOf = (under: boolean, cut: number) =>
  under ? `max(${grasp.space10}, ${cut}px)` : "0px";
const clearOf = (under: boolean) => (under ? grasp.space2 : "0px");

// Marks which sides of the strip have cards scrolled past them, and sets how far each side fades,
// straight on the strip, so a scroll never renders. Right to left the scroll runs negative, so its
// distance is taken whole, and the start is the right-hand side.
const watchEdges = (element: HTMLElement) => {
  const mark = () => {
    const along = Math.abs(element.scrollLeft);
    const underStart = along > 1;
    const underEnd = along < element.scrollWidth - element.clientWidth - 1;
    element.toggleAttribute("data-under-start", underStart);
    element.toggleAttribute("data-under-end", underEnd);
    const rtl = getComputedStyle(element).direction === "rtl";
    const underLeft = rtl ? underEnd : underStart;
    const underRight = rtl ? underStart : underEnd;
    const { style } = stylex.props(
      styles.fades(
        fadeOf(underLeft, underLeft ? cutCard(element, "left") : 0),
        clearOf(underLeft),
        fadeOf(underRight, underRight ? cutCard(element, "right") : 0),
        clearOf(underRight)
      )
    );
    for (const [name, value] of Object.entries(style ?? {})) {
      element.style.setProperty(name, String(value));
    }
  };
  const observer = new ResizeObserver(mark);
  observer.observe(element);
  const watchCards = new MutationObserver(mark);
  watchCards.observe(element, { childList: true });
  element.addEventListener("scroll", mark, { passive: true });
  return () => {
    observer.disconnect();
    watchCards.disconnect();
    element.removeEventListener("scroll", mark);
  };
};

/** The files as shown: those kept, in place, those taken off marked leaving, and the new at the end. */
const mergeFiles = (before: Shown[], files: ComposerFile[]): Shown[] => {
  const now = new Map(files.map((file) => [file.id, file]));
  const merged: Shown[] = before.map(
    (old) => now.get(old.id) ?? { ...old, leaving: true }
  );
  for (const file of files) {
    if (!before.some((old) => old.id === file.id)) {
      merged.push(file);
    }
  }
  return merged;
};

/** The files above the text, arriving and leaving with care. */
export const ComposerAttachments = ({
  files,
  onRemove,
  onRetry,
  onOpen,
  words,
  label,
}: StripProps) => {
  // A file taken off stays a moment, leaving, before it goes, so the others close up smoothly.
  const [shown, setShown] = useState<Shown[]>(files);
  // A new list of files merges in while rendering, as React advises for state that follows a prop.
  const [seen, setSeen] = useState(files);
  if (seen !== files) {
    setSeen(files);
    setShown(mergeFiles(shown, files));
  }
  const strip = useRef<HTMLUListElement | null>(null);
  useEffect(() => {
    const element = strip.current;
    return element === null ? undefined : watchEdges(element);
  }, []);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    for (const file of shown) {
      if (file.leaving !== true || timers.current.has(file.id)) {
        continue;
      }
      timers.current.set(
        file.id,
        setTimeout(() => {
          timers.current.delete(file.id);
          setShown((all) =>
            all.filter(
              (entry) => entry.id !== file.id || entry.leaving !== true
            )
          );
        }, ms.durationLeave)
      );
    }
  }, [shown]);
  useEffect(() => {
    const all = timers.current;
    return () => {
      for (const timer of all.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  return (
    <div {...stylex.props(styles.shell, files.length > 0 && styles.shellOpen)}>
      <div {...stylex.props(styles.clip)}>
        {/* The fades start at none; watchEdges sets them straight on the strip as it scrolls. */}
        <ul
          ref={strip}
          aria-label={label}
          {...stylex.props(
            styles.strip,
            scroll.bar,
            styles.fades("0px", "0px", "0px", "0px")
          )}
        >
          {shown.map((file) => (
            <li
              key={file.id}
              aria-hidden={file.leaving === true ? true : undefined}
              {...stylex.props(
                styles.item,
                file.leaving === true && styles.leaving
              )}
            >
              <ComposerAttachment
                name={file.name}
                size={file.size}
                pages={file.pages}
                type={file.type}
                preview={file.preview}
                status={file.status}
                progress={file.progress}
                reason={file.reason}
                words={words}
                onRemove={
                  onRemove !== undefined && file.leaving !== true
                    ? () => {
                        onRemove(file.id);
                      }
                    : undefined
                }
                onRetry={
                  onRetry === undefined
                    ? undefined
                    : () => {
                        onRetry(file.id);
                      }
                }
                onOpen={
                  onOpen === undefined
                    ? undefined
                    : () => {
                        onOpen(file.id);
                      }
                }
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
