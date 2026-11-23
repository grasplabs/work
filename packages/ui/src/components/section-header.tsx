// SectionHeader: the heading row of a part of a page: its title, a sentence under it, and that
// part's actions at the end of the row. The title in the sans at text-lg medium, as a card's, the
// sentence muted. Anything that belongs beside the title (a badge) goes in `badge`. While the
// section loads, placeholders stand where the words will be, and the words fade in once they come.
//
//   <SectionHeader title="Usage" description="Seats and storage this month." actions={<Button>Export</Button>} />
//
// A Section holds a header and what follows it, the same room between each; it is a region once
// `aria-labelledby` names the header's `id`:
//
//   <Section aria-labelledby="billing">
//     <SectionHeader id="billing" title="Billing" />
//     <BillingTable />
//   </Section>
//
// `variant="group"` names a group of rows standing over its card (`<SectionHeader variant="group" />`
// then a `<Card>`): the title a step over the rows' labels, and an xs action's foot on the title's
// line. Every value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { fadeIn } from "../lib/styles";
import { colors, font, size as sizes, space } from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { sectionHeaderVars } from "./section-header.stylex";
import { Skeleton } from "./skeleton";

/** Every prop a SectionHeader takes. */
export interface SectionHeaderProps {
  /** The section's name, in sentence case ("Usage"). */
  title: ReactNode;
  /** One sentence under it: what the section holds. */
  description?: ReactNode;
  /** Beside the title: a badge that says it is new, a count. */
  badge?: ReactNode;
  /** At the end of the row: the section's own buttons. Put xs buttons in a `group` header. */
  actions?: ReactNode;
  /**
   * The heading's level, so the page's outline stays in order: 2 in a page whose title is its h1.
   * @default 2
   */
  headingLevel?: 2 | 3 | 4;
  /**
   * `default` for a section of a page; `sm` for a dense one (a settings card): the title and the
   * sentence at text-sm, the sentence right under it.
   * @default "default"
   */
  size?: "default" | "sm";
  /**
   * `group` for the name of a group of rows standing over its card: the title at text-base, a step
   * over the rows' own labels, the sentence at text-sm right under it, and the actions raised so an
   * xs button's foot meets the title line's. It sets the words' size, so `size` is a `section`'s.
   * @default "section"
   */
  variant?: "section" | "group";
  /** The heading's id: for a link to the section (`#usage`), and for its Section's name. */
  id?: string;
  /**
   * Placeholders where the title and the sentence will be, while they load.
   * @default false
   */
  loading?: boolean;
  /** Layout only: margins and alignment. The look belongs to the header. */
  style?: LayoutStyle;
}

/** Every prop a Section takes. */
export interface SectionProps {
  /** A SectionHeader, then the section's parts. */
  children: ReactNode;
  /** The id of its SectionHeader's heading: a screen reader then lists it as a region by that name. */
  "aria-labelledby"?: string;
  /** Layout only: margins and alignment. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "space-between",
    columnGap: space[4],
    rowGap: space[3],
    minWidth: 0,
  },
  // A group's head: an xs button on the title's line rises so its foot meets the line's, and the
  // card under it stands its gap under both. A taller control keeps its whole box.
  headerGroup: {
    [sectionHeaderVars.actionsTrim]: `min(0px, calc(${font.textBaseLine} - ${sizes.controlXs}))`,
  },
  // A dense head with a title alone: the title on the actions' middle, not 12px above it.
  headerCentred: { alignItems: "center" },
  words: {
    display: "grid",
    rowGap: space[1],
    flexGrow: 1,
    // Beside the actions the words take what is left: a title alone down to its longest word (its
    // own min-content, a flex item's floor), a title with a line under it down to 10rem, so that
    // line is never squeezed to a word a line. Past that the actions wrap under them.
    flexBasis: 0,
  },
  wordsWithLine: { minWidth: "10rem" },
  // Dense: the title and the sentence at text-sm, one line each, no room between them.
  wordsSm: { rowGap: 0 },
  titleRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[2],
    minWidth: 0,
  },
  // The title: text-lg at medium in the foreground, balanced; a link to the section lands with room
  // above it.
  title: {
    margin: 0,
    minWidth: 0,
    fontFamily: font.sans,
    fontSize: font.textLg,
    lineHeight: font.textLgLine,
    fontWeight: font.weightMedium,
    letterSpacing: font.trackingUi,
    color: colors.foreground,
    overflowWrap: "break-word",
    textWrap: "balance",
    scrollMarginTop: space[6],
  },
  titleSm: { fontSize: font.textSm, lineHeight: font.textSmLine },
  // A group's name over its card: a step over the rows' labels (text-sm), and a weight over theirs,
  // so "Plan" over a row named Plan reads as the group's name.
  titleGroup: {
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    fontWeight: font.weightSemibold,
  },
  // The sentence: text-base in muted, its lines evened.
  description: {
    margin: 0,
    fontFamily: font.sans,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    fontWeight: font.weightNormal,
    letterSpacing: font.trackingUi,
    color: colors.mutedForeground,
    overflowWrap: "break-word",
    textWrap: "pretty",
  },
  descriptionSm: { fontSize: font.textSm, lineHeight: font.textSmLine },
  // On the title's row while they fit beside 10rem of words; under the title only when they do not.
  // On a line of their own they may shrink to its width and wrap, never past the header's edge.
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[2],
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    maxWidth: "100%",
    // On the title's line they may give back room above themselves (a group's head). Wrapped under
    // the title, the row's gap less the trim still parts them. Never below: what is there stays whole.
    marginBlockStart: sectionHeaderVars.actionsTrim,
    // Above anything a host lays over the header (a drag handle): they stay pressable.
    position: "relative",
    zIndex: 1,
  },
  // The title's placeholder: never wider than its room. The description's runs to its line's end.
  titleWait: {
    display: "block",
    width: "100%",
    maxWidth: sizes.sectionHeaderTitleWait,
  },
  section: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    rowGap: space.sectionHeaderGap,
    minWidth: 0,
  },
});

/** The text a title's placeholder stands for, so the head is as tall loading as loaded. */
const titleWaitOf = (size: "default" | "sm", group: boolean) => {
  if (group) {
    return "default";
  }
  return size === "sm" ? "sm" : "lg";
};

/** Words that replace the placeholders fade in; a header that never waited is simply there. */
const useArrived = (loading: boolean) => {
  // Remembered as state, set the first time it loads (React's way of keeping what a render saw).
  const [waited, setWaited] = useState(loading);
  if (loading && !waited) {
    setWaited(true);
  }
  return waited && !loading;
};

/** The title and the sentence under it, or their placeholders while they load. */
const Words = ({
  title,
  description,
  badge,
  headingLevel,
  size,
  group,
  id,
  loading,
}: Pick<SectionHeaderProps, "title" | "description" | "badge" | "id"> & {
  headingLevel: 2 | 3 | 4;
  size: "default" | "sm";
  group: boolean;
  loading: boolean;
}) => {
  const Heading = `h${headingLevel}` as const;
  const arrived = useArrived(loading);
  const small = size === "sm" || group;
  if (loading) {
    return (
      <>
        <span {...stylex.props(styles.titleWait)}>
          <Skeleton size={titleWaitOf(size, group)} />
        </span>
        {description !== undefined && (
          <Skeleton size={small ? "sm" : "default"} />
        )}
      </>
    );
  }
  return (
    <>
      <div {...stylex.props(styles.titleRow, arrived && fadeIn)}>
        <Heading
          id={id}
          {...stylex.props(
            styles.title,
            size === "sm" && styles.titleSm,
            group && styles.titleGroup
          )}
        >
          {title}
        </Heading>
        {badge}
      </div>
      {description !== undefined && (
        <p
          {...stylex.props(
            styles.description,
            small && styles.descriptionSm,
            arrived && fadeIn
          )}
        >
          {description}
        </p>
      )}
    </>
  );
};

export const SectionHeader = ({
  title,
  description,
  badge,
  actions,
  headingLevel = 2,
  size = "default",
  variant = "section",
  id,
  loading = false,
  style,
}: SectionHeaderProps) => {
  const group = variant === "group";
  const small = size === "sm" || group;
  return (
    <div
      data-slot="section-header"
      aria-busy={loading || undefined}
      {...stylex.props(
        styles.header,
        group && styles.headerGroup,
        small && description === undefined && styles.headerCentred,
        style
      )}
    >
      <div
        {...stylex.props(
          styles.words,
          description !== undefined && styles.wordsWithLine,
          small && styles.wordsSm
        )}
      >
        <Words
          title={title}
          description={description}
          badge={badge}
          headingLevel={headingLevel}
          size={size}
          group={group}
          id={id}
          loading={loading}
        />
      </div>
      {actions !== undefined && (
        <div {...stylex.props(styles.actions)}>{actions}</div>
      )}
    </div>
  );
};

/** A part of a page: its SectionHeader and what follows it, with the same room between each. */
export const Section = ({
  children,
  "aria-labelledby": labelledBy,
  style,
}: SectionProps) => (
  <section
    aria-labelledby={labelledBy}
    data-slot="section-header-section"
    {...stylex.props(styles.section, style)}
  >
    {children}
  </section>
);
