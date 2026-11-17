// ComposerAttachment: one file waiting to be sent with a composer's message (composer.tsx), as a
// small card in the strip above the text. A real thumbnail for an image, else a mark by kind; the
// name whole when there is room, else cut in the middle so its extension stays; its size or pages. While it uploads, a thin bar
// shows how far; if it failed, it says so with Try again; if it was refused, it says why. Remove shows
// under a pointer or focus, and always on a touch screen.
//
// The words are shared with the File upload component: Uploading, Uploaded, Could not upload,
// Try again, Remove.
"use client";

import * as stylex from "@stylexjs/stylex";
import { Button as PressPrimitive } from "@ui-sdk/react/button";
import { useState } from "react";

import { focus } from "../focus/focus";
import { Cross, File, Icon, Image } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";

/** Where a file is. */
export type ComposerAttachmentStatus =
  | "uploading"
  | "done"
  | "failed"
  | "refused";

/** The words an attachment says, shared with File upload. */
export interface ComposerAttachmentWords {
  uploading: string;
  done: string;
  failed: string;
  retry: string;
  remove: string;
  /**
   * A file's size as people read it, from its bytes ("820 KB", "1.4 MB"): the host formats the
   * number and the unit for its language.
   */
  size: (bytes: number) => string;
  /** A document's pages, from their count, with the plural the language takes ("1 page", "12 pages"). */
  pages: (count: number) => string;
}

/** Every prop a ComposerAttachment takes. */
export interface ComposerAttachmentProps {
  /** The file's name, as the person knows it ("brief.pdf"). */
  name: string;
  /** Its size in bytes, shown as people say it ("1.4 MB"). */
  size?: number;
  /** Its pages, shown in place of its size for a document. */
  pages?: number;
  /** Its media type ("image/png"): an image shows its picture, anything else a file mark. */
  type?: string;
  /** A picture of it: for an image, its own address. */
  preview?: string;
  /**
   * Where it is: `uploading` with `progress`, `done`, `failed` (Try again), or `refused` with `reason`.
   * @default "done"
   */
  status?: ComposerAttachmentStatus;
  /** How far it has uploaded, from 0 to 1. */
  progress?: number;
  /** Why it failed or was refused ("Larger than 20 MB"). */
  reason?: string;
  /** Takes the file off the message. Without it, there is no cross. */
  onRemove?: () => void;
  /** Tries the upload again after a failure. */
  onRetry?: () => void;
  /** Opens the file: a press on the card. */
  onOpen?: () => void;
  /** The words, in the page's language. */
  words?: Partial<ComposerAttachmentWords>;
}

// A size in English, in steps of a thousand: "820 KB", "1.4 MB".
const englishSize = (bytes: number) => {
  if (bytes === 0) {
    return "Empty";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

const defaultWords: ComposerAttachmentWords = {
  uploading: "Uploading",
  done: "Uploaded",
  failed: "Could not upload",
  retry: "Try again",
  remove: "Remove",
  size: englishSize,
  pages: (count) =>
    count === 0 ? "No pages" : `${count} ${count === 1 ? "page" : "pages"}`,
};

/** A name cut in the middle: its start, and its last few characters with the extension. */
const splitName = (name: string) => {
  const dot = name.lastIndexOf(".");
  const keep = Math.max(dot === -1 ? 6 : name.length - dot + 3, 6);
  return name.length <= keep + 4
    ? [name, ""]
    : [name.slice(0, name.length - keep), name.slice(name.length - keep)];
};

const styles = stylex.create({
  card: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    flexShrink: 0,
    boxSizing: "border-box",
    // As wide as its name, up to a sensible most or the strip's own width (the strip is the
    // container): only a name that truly does not fit is cut, in the middle.
    maxWidth: `min(${grasp.attachmentMaxWidth}, 100cqi)`,
    padding: grasp.space1,
    paddingInlineEnd: grasp.space2,
    overflow: "hidden",
    borderRadius: `min(${grasp.corner}, calc((${grasp.attachmentThumb} + 2 * ${grasp.space1}) / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.soft,
    boxShadow: grasp.edge,
    outline: {
      default: "none",
      [media.forced]: `${grasp.hairline} solid currentColor`,
    },
    outlineOffset: `calc(-1 * ${grasp.hairline})`,
  },
  wrong: {
    backgroundColor: grasp.dangerSoft,
  },
  thumb: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: grasp.attachmentThumb,
    height: grasp.attachmentThumb,
    overflow: "hidden",
    borderRadius: `calc(${grasp.corner} / 2)`,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.edge,
    color: grasp.muted,
  },
  picture: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  open: {
    position: "absolute",
    inset: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: "inherit",
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  words: {
    display: "grid",
    flexGrow: 1,
    minWidth: 0,
  },
  name: {
    display: "flex",
    minWidth: 0,
    color: grasp.ink,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    whiteSpace: "nowrap",
  },
  nameStart: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  nameEnd: {
    flexShrink: 0,
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  metaWrong: {
    color: grasp.danger,
  },
  bar: {
    position: "absolute",
    insetInline: 0,
    insetBlockEnd: 0,
    height: grasp.sliderTrack,
    backgroundColor: grasp.progressTrack,
  },
  barFill: {
    height: "100%",
    backgroundColor: grasp.progressFill,
    transformOrigin: "left center",
    transitionProperty: "transform",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  barScale: (scale: number) => ({ transform: `scaleX(${scale})` }),
  // Remove: under a pointer or focus, and always on a touch screen.
  remove: {
    position: "relative",
    zIndex: 1,
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    width: grasp.badgeHeight,
    height: grasp.badgeHeight,
    padding: 0,
    margin: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerCircle,
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [media.hover]: grasp.ghostFillHover },
      ":active": grasp.ghostFillPress,
    },
    color: grasp.muted,
    cursor: "pointer",
    opacity: { default: 1, [media.hover]: 0 },
    transitionProperty: "opacity, background-color",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
  shown: {
    opacity: 1,
  },
  retry: {
    position: "relative",
    zIndex: 1,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: grasp.ink,
    font: "inherit",
    textDecorationLine: "underline",
    cursor: "pointer",
  },
  reach: {
    position: "absolute",
    inset: {
      default: 0,
      [media.coarse]: `calc((${grasp.badgeHeight} - ${grasp.tap}) / 2)`,
    },
  },
});

/** The line under the name: how the upload stands, or the file's pages or size. */
const metaOf = ({
  status,
  progress,
  reason,
  pages,
  size,
  say,
}: {
  status: ComposerAttachmentStatus;
  progress: number;
  reason: string | undefined;
  pages: number | undefined;
  size: number | undefined;
  say: ComposerAttachmentWords;
}) => {
  if (status === "uploading") {
    return `${say.uploading} ${Math.round(progress * 100)}%`;
  }
  if (status === "failed" || status === "refused") {
    return reason ?? say.failed;
  }
  if (pages !== undefined && pages !== 0) {
    return say.pages(pages);
  }
  if (size === undefined) {
    return say.done;
  }
  return say.size(size);
};

/** A file waiting to be sent: its picture or mark, its name and size, and how its upload stands. */
export const ComposerAttachment = ({
  name,
  size,
  pages,
  type,
  preview,
  status = "done",
  progress = 0,
  reason,
  onRemove,
  onRetry,
  onOpen,
  words,
}: ComposerAttachmentProps) => {
  const say = { ...defaultWords, ...words };
  // Remove shows while a pointer or focus is on the card (and always on a touch screen).
  const [near, setNear] = useState(false);
  // A picture that cannot load gives way to the file's mark.
  const [broken, setBroken] = useState(false);
  const [start, end] = splitName(name);
  const image =
    Boolean(preview) && !broken && (type?.startsWith("image/") ?? true);
  const wrong = status === "failed" || status === "refused";
  const meta = metaOf({ status, progress, reason, pages, size, say });
  return (
    <div
      data-slot="composer-attachment"
      data-status={status}
      {...stylex.props(styles.card, wrong && styles.wrong, focus.within)}
      onPointerEnter={() => {
        setNear(true);
      }}
      onPointerLeave={() => {
        setNear(false);
      }}
      onFocus={() => {
        setNear(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setNear(false);
        }
      }}
    >
      {onOpen && (
        <button
          type="button"
          aria-label={name}
          onClick={onOpen}
          {...stylex.props(styles.open)}
        />
      )}
      <span aria-hidden="true" {...stylex.props(styles.thumb)}>
        {image ? (
          <img
            src={preview}
            alt=""
            onError={() => {
              setBroken(true);
            }}
            {...stylex.props(styles.picture)}
          />
        ) : (
          <Icon icon={type?.startsWith("image/") === true ? Image : File} />
        )}
      </span>
      <span {...stylex.props(styles.words)}>
        {/* A name and its line read in their own direction, so in a right-to-left page a Latin
            name still runs from its start to its extension, the cut between them. */}
        <span title={name} dir="auto" {...stylex.props(styles.name)}>
          <span {...stylex.props(styles.nameStart)}>{start}</span>
          {end !== "" && <span {...stylex.props(styles.nameEnd)}>{end}</span>}
        </span>
        <span
          role={wrong ? "alert" : undefined}
          dir="auto"
          {...stylex.props(styles.meta, wrong && styles.metaWrong)}
        >
          {meta}
          {status === "failed" && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              {...stylex.props(styles.retry, focus.words)}
            >
              {say.retry}
            </button>
          )}
        </span>
      </span>
      {status === "uploading" && (
        <span
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a <progress> draws its own bar; this one is the card's hairline
          role="progressbar"
          aria-label={`${say.uploading} ${name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          {...stylex.props(styles.bar)}
        >
          <span
            {...stylex.props(
              styles.barFill,
              styles.barScale(Math.min(Math.max(progress, 0), 1))
            )}
          />
        </span>
      )}
      {onRemove && (
        <PressPrimitive
          onClick={onRemove}
          aria-label={`${say.remove} ${name}`}
          render={(props: Record<string, unknown>) => (
            <button
              {...props}
              type="button"
              {...stylex.props(styles.remove, near && styles.shown, focus.ring)}
              data-slot="composer-attachment-remove"
            >
              <span aria-hidden="true" {...stylex.props(styles.reach)} />
              <Icon icon={Cross} />
            </button>
          )}
        />
      )}
    </div>
  );
};
