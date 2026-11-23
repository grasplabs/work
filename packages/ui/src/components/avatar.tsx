// Avatar: a person or a team as a picture, or their initials until it loads, on
// UI SDK's Avatar, which keeps the image a real <img> and shows the initials until it has loaded,
// and for good if it fails. The circle and the soft fill with the system's edge are the system's.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Avatar name="Anna de Vries">
//     <AvatarImage src="/people/anna.jpg" />
//     <AvatarFallback />                                          the name's initials: AV
//   </Avatar>
//   <Avatar name="Anna de Vries" decorative>…</Avatar>            her name is written beside it
//   <AvatarGroup items={team} size="xs" />                        a few faces, then +N
//
// Every value is a token.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Avatar as AvatarPrimitive,
  AvatarFallback as FallbackPrimitive,
  AvatarImage as ImagePrimitive,
} from "@ui-sdk/react/avatar";
import { createContext, use } from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { className } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";

/**
 * `2xs` 16px (in a control's own line; its initials one letter), `xs` 24px, `sm` 32px, `default`
 * 40px, `lg` 48px, `xl` 64px.
 */
export type AvatarSize = "2xs" | "xs" | "sm" | "default" | "lg" | "xl";

/** Every prop an Avatar takes. */
export interface AvatarProps {
  /** Who it is: a person's or a team's name. It names the avatar, and gives the initials. */
  name: string;
  /** Its picture and initials: an AvatarImage and an AvatarFallback, and an AvatarBadge if any. */
  children: ReactNode;
  /**
   * Its size.
   * @default "default"
   */
  size?: AvatarSize;
  /**
   * Hidden from screen readers and agents, for an avatar beside its own name, so the name is not
   * said twice.
   * @default false
   */
  decorative?: boolean;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** Every prop an AvatarImage takes: the picture, over the initials once it has loaded. */
export interface AvatarImageProps {
  /** The picture. Until it loads, and if it fails, the AvatarFallback shows. Without one, nothing. */
  src?: string;
  /**
   * The picture's own text. The Avatar is named by its `name`, so leave it empty unless the
   * picture says something the name does not.
   * @default ""
   */
  alt?: string;
  /**
   * `eager` for an avatar known to be on the first screen. Otherwise it loads only as it nears the
   * window, so portraits far down a page cost nothing on the first visit.
   * @default "lazy"
   */
  loading?: "eager" | "lazy";
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** Every prop an AvatarFallback takes: what shows until the picture loads, and if it fails. */
export interface AvatarFallbackProps {
  /** Its words. Leave it out for the initials of the Avatar's `name` ("Anna de Vries" is AV). */
  children?: ReactNode;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** Every prop an AvatarBadge takes: a small mark on the avatar's lower end corner. */
export interface AvatarBadgeProps {
  /** What it holds: a small icon, or nothing for a dot. Say what it means in words beside the avatar too. */
  children?: ReactNode;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** Someone in an AvatarGroup: their name, and their picture if they have one. */
export interface AvatarGroupItem {
  name: string;
  src?: string;
}

/** Every prop an AvatarGroup takes. */
export interface AvatarGroupProps {
  /** The people, in the order their faces stand. */
  items: readonly AvatarGroupItem[];
  /**
   * How many faces show before "+N" stands for the rest.
   * @default 4
   */
  max?: number;
  /**
   * The faces' size, as Avatar's.
   * @default "xs"
   */
  size?: AvatarSize;
  /**
   * Its name for a screen reader, when the people's names are not the right one ("Finance, 6
   * people"). Otherwise the catalogue's `avatar.groupName` makes it from the names it shows.
   */
  "aria-label"?: string;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** Every prop an AvatarGroupCount takes: the "+N" that stands for the rest of a group. */
export interface AvatarGroupCountProps {
  /** How many more people there are than faces shown. Its words are the catalogue's `avatar.groupCount`. */
  count: number;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

const fade = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

const styles = stylex.create({
  // The picture fades in once it has loaded (UI SDK marks it so), never before.
  fadeIn: {
    animationName: {
      default: "none",
      ":is([data-loading-status=loaded])": {
        default: fade,
        [media.reducedMotion]: "none",
      },
    },
    animationDuration: duration.mark,
    animationTimingFunction: duration.ease,
    animationFillMode: "both",
  },
  avatar: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    borderRadius: radius.circle,
    backgroundColor: colors.muted,
    // In forced colours the edge is a real line.
    outlineWidth: { default: 0, [media.forcedColors]: 1 },
    outlineStyle: "solid",
    outlineOffset: -1,
    fontFamily: font.sans,
    fontWeight: font.weightMedium,
    color: colors.mutedForeground,
    userSelect: "none",
  },
  // The initials keep the same share of the circle at every size; in a control's own line (2xs)
  // one letter, at the share of its circle xs's two letters take of theirs.
  "2xs": {
    width: sizes.avatar2xs,
    height: sizes.avatar2xs,
    fontSize: `calc(${font.textXs} * 0.75)`,
  },
  xs: {
    width: sizes.avatarXs,
    height: sizes.avatarXs,
    fontSize: `calc(${font.textBase} * 0.75)`,
  },
  sm: {
    width: sizes.avatarSm,
    height: sizes.avatarSm,
    fontSize: font.textBase,
  },
  default: {
    width: sizes.avatarDefault,
    height: sizes.avatarDefault,
    fontSize: font.headingSm,
  },
  lg: {
    width: sizes.avatarLg,
    height: sizes.avatarLg,
    fontSize: font.headingMd,
  },
  xl: {
    width: sizes.avatarXl,
    height: sizes.avatarXl,
    fontSize: font.headingLg,
  },
  image: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    borderRadius: "inherit",
    objectFit: "cover",
    // A picture that failed gives way to the initials under it.
    display: { default: "block", ":is([data-loading-status=error])": "none" },
  },
  // The system's edge, as a layer over the picture, so a white photo keeps its rim.
  edge: {
    position: "absolute",
    inset: 0,
    borderRadius: "inherit",
    boxShadow: sizes.avatarBorder,
    pointerEvents: "none",
  },
  fallback: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
    borderRadius: "inherit",
  },
  // On the lower end corner, a third of the face, ringed in the page's ground so it stands clear
  // of the picture.
  badge: (face: string) => ({
    position: "absolute",
    insetInlineEnd: 0,
    insetBlockEnd: 0,
    zIndex: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: `calc(${face} / 3)`,
    height: `calc(${face} / 3)`,
    borderRadius: radius.circle,
    color: colors.primaryForeground,
    backgroundColor: colors.primary,
    boxShadow: `0 0 0 2px ${colors.background}`,
    outlineWidth: { default: 0, [media.forcedColors]: 1 },
    outlineStyle: "solid",
  }),
  group: {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: 0,
    verticalAlign: "middle",
  },
  // Each face after the first stands a quarter of a face back over the one before it. A face in a
  // stack shows one letter, so no letter is ever under the next face (two initials fill a face).
  face: (face: string) => ({
    display: "inline-flex",
    flexShrink: 0,
    marginInlineStart: `calc(${face} / -4)`,
    ":first-child": { marginInlineStart: 0 },
  }),
  // Every face but the last is cut back where the next one stands: a circle the next face's size,
  // two pixels wider, centred where the next face's centre is, so a gap of the ground shows between
  // them on any ground. In forced colours the faces' own edges are real lines, and the cut keeps
  // them apart all the same.
  cut: (face: string) => ({
    maskImage: `radial-gradient(circle at calc(${face} * 1.25) 50%, transparent calc(${face} / 2 + 2px), #000 calc(${face} / 2 + 2.5px))`,
  }),
  // The rest, as a face of its own: a face wide and tall, a circle, the avatar's edge, its soft
  // fill and the count in muted ink.
  count: (face: string) => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: face,
    height: face,
    paddingInline: space[1],
    borderRadius: radius.circle,
    backgroundColor: colors.muted,
    boxShadow: sizes.avatarBorder,
    outlineWidth: { default: 0, [media.forcedColors]: 1 },
    outlineStyle: "solid",
    outlineOffset: -1,
    fontFamily: font.sans,
    fontSize: `max(10px, calc(${face} * 0.4))`,
    fontWeight: font.weightMedium,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "-0.02em",
    color: colors.mutedForeground,
    whiteSpace: "nowrap",
  }),
});

/** A face's width at a size. */
const faceOf = (size: AvatarSize) => {
  if (size === "2xs") {
    return sizes.avatar2xs;
  }
  if (size === "xs") {
    return sizes.avatarXs;
  }
  if (size === "sm") {
    return sizes.avatarSm;
  }
  if (size === "lg") {
    return sizes.avatarLg;
  }
  return size === "xl" ? sizes.avatarXl : sizes.avatarDefault;
};

/** An avatar's look at a size. */
const lookOf = (size: AvatarSize) => {
  if (size === "2xs") {
    return styles["2xs"];
  }
  if (size === "xs") {
    return styles.xs;
  }
  if (size === "sm") {
    return styles.sm;
  }
  if (size === "lg") {
    return styles.lg;
  }
  return size === "xl" ? styles.xl : styles.default;
};

// The first character as a person sees it: an accent with its letter, an emoji whole.
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
const firstOf = (word: string | undefined) =>
  word === undefined || word === ""
    ? ""
    : (segmenter.segment(word)[Symbol.iterator]().next().value?.segment ?? "");

/** The first letter of the first and last words of a name: "Anna de Vries" is AV. */
const initialsOf = (name: string) => {
  const words = name.normalize("NFC").trim().split(/\s+/u).filter(Boolean);
  const last = words.length > 1 ? words.at(-1) : undefined;
  // The same capitals on the server and in every browser, whatever its language.
  return `${firstOf(words[0])}${firstOf(last)}`.toUpperCase();
};

// What an Avatar hands its parts: its name, for the initials, and its size.
const AvatarName = createContext("");
const AvatarSizeContext = createContext<AvatarSize>("default");
// What an AvatarGroup hands its count: the faces' size.
const AvatarGroupSize = createContext<AvatarSize>("xs");

/** The picture, over the initials once it has loaded. The Avatar names it, so its own alt is empty. */
export const AvatarImage = ({
  src,
  alt = "",
  loading = "lazy",
  style,
}: AvatarImageProps) =>
  // The class only: UI SDK hides the image with its own style until it has loaded. An avatar never
  // opens larger: data-no-zoom keeps a page's image zoom off it.
  src === undefined || src === "" ? null : (
    <ImagePrimitive
      src={src}
      alt={alt}
      loading={loading}
      decoding="async"
      data-slot="avatar-image"
      data-no-zoom=""
      className={className(styles.image, styles.fadeIn, style)}
    />
  );

/** What shows until the picture loads, and for good if it fails: the name's initials by default. */
export const AvatarFallback = ({ children, style }: AvatarFallbackProps) => {
  const name = use(AvatarName);
  const one = use(AvatarSizeContext) === "2xs";
  return (
    <FallbackPrimitive
      aria-hidden="true"
      data-slot="avatar-fallback"
      {...stylex.props(styles.fallback, style)}
    >
      {children ?? (one ? firstOf(initialsOf(name)) : initialsOf(name))}
    </FallbackPrimitive>
  );
};

/** A small mark on the avatar's lower end corner: a status, as a dot or a small icon. */
export const AvatarBadge = ({ children, style }: AvatarBadgeProps) => {
  const face = faceOf(use(AvatarSizeContext));
  return (
    <span
      aria-hidden="true"
      data-slot="avatar-badge"
      {...stylex.props(styles.badge(face), style)}
    >
      {children}
    </span>
  );
};

export const Avatar = ({
  name,
  children,
  size = "default",
  decorative = false,
  style,
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
      {...stylex.props(styles.avatar, lookOf(size), style)}
    >
      <AvatarName value={name}>
        <AvatarSizeContext value={size}>{children}</AvatarSizeContext>
      </AvatarName>
      <span aria-hidden="true" {...stylex.props(styles.edge)} />
    </AvatarPrimitive>
  );
};

/** The "+N" that stands for the rest of a group, a face wide. */
export const AvatarGroupCount = ({ count, style }: AvatarGroupCountProps) => {
  const { avatar } = useI18n();
  const face = faceOf(use(AvatarGroupSize));
  return (
    <span
      aria-hidden="true"
      data-slot="avatar-group-count"
      {...stylex.props(styles.face(face), styles.count(face), style)}
    >
      {avatar.groupCount(count)}
    </span>
  );
};

/**
 * A few people as one stack of faces, then "+N" for the rest, named once for a screen reader
 * ("Anna de Vries, Ravi Menon and 4 others"). A face without a picture shows one letter, the first
 * name's, since two initials fill a face and the next one would cut the second.
 */
export const AvatarGroup = ({
  items,
  max = 4,
  size = "xs",
  "aria-label": label,
  style,
}: AvatarGroupProps) => {
  const { avatar } = useI18n();
  const face = faceOf(size);
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  const name =
    label ??
    avatar.groupName(
      shown.map((item) => item.name),
      rest
    );
  // Alone, a face is not stacked: it keeps both initials.
  const stacked = shown.length + (rest > 0 ? 1 : 0) > 1;
  return (
    <span
      // A stack of faces is one picture with one name.
      role="img"
      aria-label={name}
      data-slot="avatar-group"
      {...stylex.props(styles.group, style)}
    >
      {shown.map((item, index) => (
        <span
          key={`${item.name}-${index}`}
          {...stylex.props(
            styles.face(face),
            (index < shown.length - 1 || rest > 0) && styles.cut(face)
          )}
        >
          <Avatar name={item.name} size={size} decorative>
            <AvatarImage src={item.src} />
            <AvatarFallback>
              {stacked ? firstOf(initialsOf(item.name)) : undefined}
            </AvatarFallback>
          </Avatar>
        </span>
      ))}
      {rest > 0 && (
        <AvatarGroupSize value={size}>
          <AvatarGroupCount count={rest} />
        </AvatarGroupSize>
      )}
    </span>
  );
};
