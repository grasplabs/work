// Avatar: a person or a team as a picture, or their initials until it loads, from shadcn's
// (registry/bases/base/ui/avatar.tsx, on Base UI), converted from Tailwind to StyleX and rebuilt on
// UI SDK's Avatar, which keeps the image a real <img> and shows the initials until it has loaded,
// and for good if it fails. The sizes and the initials at half the size are Palermo's; the circle
// and the soft fill with the system's edge are Grasp's.
//
//   <Avatar name="Anna de Vries" />                              initials: AV
//   <Avatar name="Anna de Vries" src="/people/anna.jpg" />
//   <Avatar name="Anna de Vries" decorative />                   her name is written beside it
//
// Every value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Avatar as AvatarPrimitive,
  AvatarFallback,
  AvatarImage,
} from "@ui-sdk/react/avatar";

import { arrive } from "../motion/arrive";
import { grasp, media } from "../tokens/tokens.stylex";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

/** Every prop an Avatar takes. */
export interface AvatarProps {
  /** Who it is: a person's or a team's name. It names the avatar, and gives the initials. */
  name: string;
  /** The picture. Until it loads, and if it fails, the initials show. */
  src?: string;
  /**
   * `xs` 24px, `sm` 32px, `md` 40px, `lg` 48px, `xl` 64px.
   * @default "md"
   */
  size?: AvatarSize;
  /**
   * Hidden from screen readers and agents, for an avatar beside its own name, so the name is not
   * said twice.
   * @default false
   */
  decorative?: boolean;
}

const styles = stylex.create({
  avatar: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    overflow: "hidden",
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.soft,
    // In forced colours the edge is a real line.
    outlineWidth: { default: 0, [media.forced]: 1 },
    outlineStyle: "solid",
    outlineOffset: -1,
    fontFamily: grasp.fontSans,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
    userSelect: "none",
  },
  // The initials stand at about half the avatar's size, never under 13px.
  xs: { width: grasp.avatarXs, height: grasp.avatarXs, fontSize: grasp.textXs },
  sm: { width: grasp.avatarSm, height: grasp.avatarSm, fontSize: grasp.textMd },
  md: {
    width: grasp.avatarMd,
    height: grasp.avatarMd,
    fontSize: grasp.titleSm,
  },
  lg: {
    width: grasp.avatarLg,
    height: grasp.avatarLg,
    fontSize: grasp.titleMd,
  },
  xl: {
    width: grasp.avatarXl,
    height: grasp.avatarXl,
    fontSize: grasp.titleLg,
  },
  image: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    // A picture that failed gives way to the initials under it.
    display: { default: "block", ":is([data-loading-status=error])": "none" },
  },
  // The system's edge, as a layer over the picture, so a white photo keeps its rim.
  edge: {
    position: "absolute",
    inset: 0,
    borderRadius: "inherit",
    boxShadow: grasp.avatarEdge,
    pointerEvents: "none",
  },
  fallback: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
  },
});

// The first character as a person sees it: an accent with its letter, an emoji whole.
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const firstOf = (word: string | undefined) =>
  word === undefined || word === ""
    ? ""
    : (segmenter.segment(word)[Symbol.iterator]().next().value?.segment ?? "");

/** The first letter of the first and last words of a name: "Anna de Vries" is AV. */
export const initialsOf = (name: string) => {
  const words = name.normalize("NFC").trim().split(/\s+/u).filter(Boolean);
  const last = words.length > 1 ? words.at(-1) : undefined;
  // The same capitals on the server and in every browser, whatever its language.
  return `${firstOf(words[0])}${firstOf(last)}`.toUpperCase();
};

export const Avatar = ({
  name,
  src,
  size = "md",
  decorative = false,
}: AvatarProps) => {
  // A blank name names nothing: then the avatar stands aside, as if decorative.
  const named = name.trim().length > 0;
  const hidden = decorative || !named;
  return (
    <AvatarPrimitive
      data-slot="avatar"
      // One image with a name, or nothing at all beside a written name.
      role={hidden ? undefined : "img"}
      aria-label={hidden ? undefined : name}
      aria-hidden={hidden ? true : undefined}
      {...stylex.props(styles.avatar, styles[size])}
    >
      {/* The class only: UI SDK hides the image with its own style until it has loaded. An avatar
          never opens larger: data-no-zoom keeps a page's image zoom (the docs' own) off it. */}
      {src !== undefined && src !== "" && (
        <AvatarImage
          src={src}
          alt=""
          data-no-zoom=""
          className={stylex.props(styles.image, arrive.whenLoaded).className}
        />
      )}
      <AvatarFallback aria-hidden="true" {...stylex.props(styles.fallback)}>
        {initialsOf(name)}
      </AvatarFallback>
      <span aria-hidden="true" {...stylex.props(styles.edge)} />
    </AvatarPrimitive>
  );
};
