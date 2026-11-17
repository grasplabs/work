// Avatar group: a few people as one stack of faces, then "+N" for the rest, named once for a
// screen reader ("Anna de Vries, Ravi Menon and 4 others"). A team in a row, the people on a
// thread. Up to four faces by default; the faces overlap by a quarter, each one cut back where the
// next stands; a face without a picture shows one letter, the first name's, since two initials
// fill a face and the next one would cut the second, so a gap of the ground shows between them on any ground (a mask, no ring of a
// colour that would have to match). Every value is a token.
//
//   <AvatarGroup people={team.people} size="xs" />
"use client";

import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { Avatar, AvatarFallback, AvatarImage, initialsOf } from "./avatar";
import type { AvatarSize } from "./avatar";
import { avatarGroupWords } from "./words";

/** Someone in the group: their name, and their picture if they have one. */
export interface AvatarGroupPerson {
  name: string;
  src?: string;
}

/** Every prop an AvatarGroup takes. */
export interface AvatarGroupProps {
  /** The people, in the order their faces stand. */
  people: readonly AvatarGroupPerson[];
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
  /** Its name for a screen reader, when the people's names are not the right one ("Finance, 6 people"). */
  "aria-label"?: string;
  /**
   * The words, in the page's language: the rest as a mark ("+3"), and the group's name made from
   * the names it shows and how many more there are.
   */
  words?: Partial<AvatarGroupWords>;
}

/** What an AvatarGroup says. */
export interface AvatarGroupWords {
  /** The mark for the rest. @default (count) => `+${count}` */
  more: (count: number) => string;
  /** The group's name. @default "Anna de Vries, Ravi Menon and 2 others" */
  name: (shown: readonly string[], rest: number) => string;
}

const sizes: Record<AvatarSize, string> = {
  "2xs": grasp.avatar2xs,
  xs: grasp.avatarXs,
  sm: grasp.avatarSm,
  md: grasp.avatarMd,
  lg: grasp.avatarLg,
  xl: grasp.avatarXl,
};

const styles = stylex.create({
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
  // two pixels wider, centred where the next face's centre is. In forced colours the faces' own
  // edges are real lines, and the cut keeps them apart all the same.
  cut: (face: string) => ({
    maskImage: `radial-gradient(circle at calc(${face} * 1.25) 50%, transparent calc(${face} / 2 + 2px), #000 calc(${face} / 2 + 2.5px))`,
  }),
  // The rest, as a face of its own: the soft fill, the system's edge, the count in quiet ink.
  more: (face: string) => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: face,
    height: face,
    paddingInline: grasp.space1,
    borderRadius: grasp.cornerCircle,
    backgroundColor: grasp.soft,
    boxShadow: grasp.avatarEdge,
    outlineWidth: { default: 0, [media.forced]: 1 },
    outlineStyle: "solid",
    outlineOffset: -1,
    fontFamily: grasp.fontSans,
    fontSize: `max(10px, calc(${face} * 0.4))`,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
    letterSpacing: "-0.02em",
    color: grasp.muted,
    whiteSpace: "nowrap",
  }),
});

// The first character as a person sees it (an accent with its letter, an emoji whole), as Avatar's.
const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

/** One letter for a face in a stack: the first of the person's initials. */
const firstLetter = (name: string) =>
  segmenter.segment(initialsOf(name))[Symbol.iterator]().next().value
    ?.segment ?? "";

/** A few people as one stack of faces, then "+N", named once. */
export const AvatarGroup = ({
  people,
  max = 4,
  size = "xs",
  "aria-label": label,
  words: given,
}: AvatarGroupProps) => {
  // Its words: the product's, by its catalogue, else English; the caller's `words` still win.
  const words = withGiven(
    useWords("avatarGroup", avatarGroupWords),
    given ?? {}
  );
  const face = sizes[size];
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  const name =
    label ??
    words.name(
      shown.map((person) => person.name),
      rest
    );
  return (
    <span
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a stack of faces is one picture with one name
      role="img"
      aria-label={name}
      data-slot="avatar-group"
      {...stylex.props(styles.group)}
    >
      {shown.map((person, index) => (
        <span
          key={`${person.name}-${index}`}
          {...stylex.props(
            styles.face(face),
            (index < shown.length - 1 || rest > 0) && styles.cut(face)
          )}
        >
          <Avatar name={person.name} size={size} decorative>
            <AvatarImage src={person.src} />
            {/* Alone, a face is not stacked: it keeps both initials. */}
            <AvatarFallback>
              {shown.length + (rest > 0 ? 1 : 0) > 1
                ? firstLetter(person.name)
                : undefined}
            </AvatarFallback>
          </Avatar>
        </span>
      ))}
      {rest > 0 && (
        <span
          aria-hidden="true"
          data-slot="avatar-group-more"
          {...stylex.props(styles.face(face), styles.more(face))}
        >
          {words.more(rest)}
        </span>
      )}
    </span>
  );
};
