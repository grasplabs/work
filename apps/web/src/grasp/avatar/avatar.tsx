// Avatar: a person or a team as a picture, or their initials until it loads, from shadcn's
// (registry/bases/base/ui/avatar.tsx, on Base UI), converted from Tailwind to StyleX and rebuilt on
// UI SDK's Avatar, which keeps the image a real <img> and shows the initials until it has loaded,
// and for good if it fails. The sizes and the initials at half the size are Palermo's; the circle
// and the soft fill with the system's edge are Grasp's.
//
// Since release step 6 its picture and initials are parts, as in shadcn's:
//
//   <Avatar name="Anna de Vries">
//     <AvatarImage src="/people/anna.jpg" />
//     <AvatarFallback />                                          initials of the name: AV
//   </Avatar>
//
// The older shape below, the picture as a prop, keeps working until step 9:
//
//   <Avatar name="Anna de Vries" />                              initials: AV
//   <Avatar name="Anna de Vries" src="/people/anna.jpg" />
//   <Avatar name="Anna de Vries" decorative />                   her name is written beside it
//   <Avatar name="Anna de Vries" src="…" eager />                on the first screen: loads at once
//
// Every value is a token (src/tokens).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 6: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  Avatar as AvatarPrimitive,
  AvatarFallback as FallbackPrimitive,
  AvatarImage as ImagePrimitive,
} from "@ui-sdk/react/avatar";
import { createContext, useContext } from "react";
import type { ReactNode } from "react";

import { arrive } from "../motion/arrive";
import { grasp, media } from "../tokens/tokens.stylex";

export type AvatarSize = "2xs" | "xs" | "sm" | "md" | "lg" | "xl";

/** Every prop an Avatar takes. */
export interface AvatarProps {
  /** Who it is: a person's or a team's name. It names the avatar, and gives the initials. */
  name: string;
  /**
   * Its picture and initials: an AvatarImage and an AvatarFallback. Leave it out only in the older
   * shape, where `src` gives the picture.
   */
  children?: ReactNode;
  /** @deprecated Use `AvatarImage.src`. */
  src?: string;
  /**
   * `2xs` 16px (in a control's own line; its initials one letter), `xs` 24px, `sm` 32px, `md`
   * 40px, `lg` 48px, `xl` 64px.
   * @default "md"
   */
  size?: AvatarSize;
  /**
   * Hidden from screen readers and agents, for an avatar beside its own name, so the name is not
   * said twice.
   * @default false
   */
  decorative?: boolean;
  /** @deprecated Use `AvatarImage.eager`. */
  eager?: boolean;
}

/** Every prop an AvatarImage takes: the picture, over the initials once it has loaded. */
export interface AvatarImageProps {
  /** The picture. Until it loads, and if it fails, the AvatarFallback shows. Without one, nothing. */
  src?: string;
  /**
   * Load the picture at once, for an avatar known to be on the first screen. Otherwise it loads
   * only as it nears the window, so portraits far down a page cost nothing on the first visit.
   * @default false
   */
  eager?: boolean;
}

/** Every prop an AvatarFallback takes: what shows until the picture loads, and if it fails. */
export interface AvatarFallbackProps {
  /** Its words. Leave it out for the initials of the Avatar's `name` ("Anna de Vries" is AV). */
  children?: ReactNode;
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
  // The initials keep the same share of the circle as at sm: three quarters of sm's letters, as 24px
  // is of 32. The extra-small words step was larger than that and filled the circle.
  // In a control's own line (the agent a Composer asks): one letter, at the share of its circle xs's
  // two letters take of theirs.
  "2xs": {
    width: grasp.avatar2xs,
    height: grasp.avatar2xs,
    fontSize: `calc(${grasp.textXs} * 0.75)`,
  },
  xs: {
    width: grasp.avatarXs,
    height: grasp.avatarXs,
    fontSize: `calc(${grasp.textMd} * 0.75)`,
  },
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

// The Avatar's name, for an AvatarFallback that shows its initials.
const AvatarName = createContext("");
// Whether the Avatar is small enough that its initials are one letter (2xs).
const AvatarOneLetter = createContext(false);

/** The picture, over the initials once it has loaded. The Avatar names it, so its own alt is empty. */
export const AvatarImage = ({ src, eager = false }: AvatarImageProps) =>
  // The class only: UI SDK hides the image with its own style until it has loaded. An avatar never
  // opens larger: data-no-zoom keeps a page's image zoom (the docs' own) off it.
  src === undefined || src === "" ? null : (
    <ImagePrimitive
      src={src}
      alt=""
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      data-no-zoom=""
      className={stylex.props(styles.image, arrive.whenLoaded).className}
    />
  );

/** What shows until the picture loads, and for good if it fails: the name's initials by default. */
export const AvatarFallback = ({ children }: AvatarFallbackProps) => {
  const name = useContext(AvatarName);
  const one = useContext(AvatarOneLetter);
  return (
    <FallbackPrimitive aria-hidden="true" {...stylex.props(styles.fallback)}>
      {children ?? (one ? firstOf(initialsOf(name)) : initialsOf(name))}
    </FallbackPrimitive>
  );
};

export const Avatar = ({
  name,
  children,
  src,
  size = "md",
  decorative = false,
  eager = false,
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
      <AvatarName value={name}>
        <AvatarOneLetter value={size === "2xs"}>
          {children ?? (
            <>
              <AvatarImage src={src} eager={eager} />
              <AvatarFallback />
            </>
          )}
        </AvatarOneLetter>
      </AvatarName>
      <span aria-hidden="true" {...stylex.props(styles.edge)} />
    </AvatarPrimitive>
  );
};
