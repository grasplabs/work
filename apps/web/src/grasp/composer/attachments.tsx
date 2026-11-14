// ComposerAttachments: the strip of files above a composer's text (composer.tsx). Many files scroll
// sideways inside it; it never grows the composer taller without limit. A card arrives by growing
// from the plus button's side and fading in; one that leaves shrinks and fades while the others
// close up; the strip's own height eases open and shut. With reduced motion, nothing moves or fades.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import { scroll } from "../scroll/scroll";
import { grasp, media } from "../tokens/tokens.stylex";
import { ms } from "../tokens/tokens.values";
import { ComposerAttachment } from "./attachment";
import type {
  ComposerAttachmentStatus,
  ComposerAttachmentWords,
} from "./attachment";

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
  from: { opacity: 1, transform: "none", width: grasp.attachmentWidth },
  to: {
    opacity: 0,
    transform: `scale(${grasp.attachmentFromScale})`,
    width: 0,
    marginInlineEnd: `calc(-1 * ${grasp.space2})`,
  },
});

const styles = stylex.create({
  // The strip's height eases between nothing and its row of cards.
  shell: {
    display: "grid",
    gridTemplateRows: "0fr",
    transitionProperty: "grid-template-rows",
    transitionDuration: { default: grasp.durationUi, [REDUCED]: "0s" },
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
    overscrollBehaviorX: "contain",
    scrollPaddingInline: grasp.space4,
  },
  item: {
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
        <ul aria-label={label} {...stylex.props(styles.strip, scroll.bar)}>
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
