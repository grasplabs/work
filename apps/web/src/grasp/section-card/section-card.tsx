// SectionCard: one part of a page on a card, its header at the top: a title, a sentence and the
// part's own buttons, then what it holds, and a foot when it has one. The product's own part, made
// of the finished ones: Card (src/components/card), SectionHeader (src/components/section-header)
// and Separator. Palermo has no section card; it takes Palermo's Card and Section Header as they are.
//
//   <SectionCard title="Usage" description="Seats and storage this month." actions={<Button>Export</Button>}>
//     …
//   </SectionCard>
//   <SectionCard title="Members" flush footer="12 people">
//     <Table …/>                                   a table or a list runs edge to edge
//   </SectionCard>
//   <SectionCard title="Revenue" fill handle={{ label: "Move Revenue", ...dragProps }}>
//     <Chart …/>                                   a dashboard widget: its cell's height, moved by its title row
//   </SectionCard>
//
// Every value is a token (src/tokens). A caller may set layout and width only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef } from "react";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

import { Card } from "../card";
import type { CardLayoutStyle } from "../card";
import { focus } from "../focus/focus";
import { SectionHeader } from "../section-header";
import { Separator } from "../separator";
import { tableVars } from "../table/table.stylex";
import { grasp } from "../tokens/tokens.stylex";

/**
 * The title row as a drag handle on a board of widgets. The library draws and names it; the drag
 * and moving by keyboard are the host's: spread a drag library's listeners and attributes here, or
 * find it by `[data-slot=section-card-handle]`.
 */
export interface SectionCardHandle extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "className" | "style" | "type"
> {
  /** Its name for a screen reader, what moving it does: "Move Revenue". */
  label: string;
  /** The handle's element, for a drag library that asks for it. */
  ref?: Ref<HTMLButtonElement>;
}

/**
 * A Section card's name: a title in its header, or, with no header (one card on a page whose title
 * already says it), a name for a screen reader.
 */
type SectionCardName =
  | {
      /** The part's name, in sentence case ("Usage"). Leave it out for a card the page's own title names. */
      title: ReactNode;
      /** Its name for a screen reader, when it has a title: the title names it already. */
      "aria-label"?: string;
    }
  | {
      title?: undefined;
      /** With no title: the card draws no header, and this names it for a screen reader ("Profile"). */
      "aria-label": string;
    };

/** Every prop a SectionCard takes. */
export type SectionCardProps = SectionCardName & SectionCardOwn;

/** What a SectionCard takes besides its name. */
interface SectionCardOwn {
  /** One sentence under the title: what the part holds. */
  description?: ReactNode;
  /** Beside the title: a badge that says it is new, a count. */
  aside?: ReactNode;
  /** At the end of the header's row: the part's own buttons. */
  actions?: ReactNode;
  /** What the part holds. */
  children: ReactNode;
  /** A line at the foot, under a hairline: a total, when it was last updated, a link to all. */
  footer?: ReactNode;
  /**
   * What it holds runs edge to edge, under a hairline: a Table, a list of Items. Without it the
   * card's room surrounds it.
   * @default false
   */
  flush?: boolean;
  /**
   * The title's heading level, so the page's outline stays in order.
   * @default 2
   */
  headingLevel?: 2 | 3 | 4;
  /** @deprecated Use `headingLevel`. */
  level?: 2 | 3 | 4;
  /**
   * `comfortable` for a part of a page; `compact` for a dense one, a settings card: the head's
   * title and sentence at text-sm, 12px above and below them and 16px at the sides, so the room
   * above the first row is the same with a sentence or without.
   * @default "comfortable"
   */
  density?: "comfortable" | "compact";
  /** Placeholders where the title and the sentence will be, while they load. @default false */
  loading?: boolean;
  /**
   * The card takes the height it is given, a dashboard's fixed grid cell: what it holds stretches
   * to the foot and clips what does not fit, fading at the foot while there is more.
   * @default false
   */
  fill?: boolean;
  /**
   * The header's title row becomes a drag handle: a grab cursor, a name for a screen reader, and
   * the shared focus ring. The header's actions stay pressable and are not part of it.
   */
  handle?: SectionCardHandle;
  /** @deprecated Use `layout`. */
  style?: CardLayoutStyle;
  /** Layout only: margins, alignment and width. The look belongs to the card. */
  layout?: CardLayoutStyle;
}

// The fade at the foot while more runs past it, as the lists and Thread draw it: clear for the
// last space-2, so nothing is cut by a hard line.
const fadeFoot = `linear-gradient(to bottom, black calc(100% - ${grasp.space10}), transparent calc(100% - ${grasp.space2}))`;
const fadeHead = `linear-gradient(to bottom, transparent ${grasp.space2}, black ${grasp.space10})`;

const styles = stylex.create({
  card: { display: "grid", gridTemplateColumns: "minmax(0, 1fr)" },
  // Filling its cell: the header, its line and the foot keep their height, what it holds takes the
  // rest and clips.
  cardFill: { display: "flex", flexDirection: "column", minHeight: 0 },
  // The header's container: its actions go under the title by the card's width (SectionHeader).
  head: {
    padding: grasp.space5,
    containerType: "inline-size",
    containerName: "section-card-head",
  },
  headFill: { flexShrink: 0 },
  headCompact: { paddingBlock: grasp.space3, paddingInline: grasp.space4 },
  bodyCompact: { paddingInline: grasp.space4, paddingBlockEnd: grasp.space4 },
  // With no header, the room over what it holds is the room at its sides.
  bodyTop: { paddingBlockStart: grasp.space5 },
  bodyTopCompact: { paddingBlockStart: grasp.space4 },
  footCompact: { paddingInline: grasp.space4 },
  // Over the header, under its actions (SectionHeader lifts them): the whole row but the buttons
  // takes the press. Its top corners are the card's, so the ring inside it follows them.
  handled: { position: "relative" },
  handle: {
    position: "absolute",
    inset: 0,
    zIndex: 0,
    // A button drawn as nothing but the press and the ring.
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    appearance: "none",
    cursor: { default: "grab", ":active": "grabbing" },
    touchAction: "none",
    borderStartStartRadius: grasp.corner,
    borderStartEndRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
  },
  bodyFill: {
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 0,
    overflow: "hidden",
    maskImage: {
      default: null,
      ":is([data-under-end]:not([data-under-start]))": fadeFoot,
      ":is([data-under-start]:not([data-under-end]))": fadeHead,
      ":is([data-under-start][data-under-end])": `${fadeHead}, ${fadeFoot}`,
    },
    maskComposite: {
      default: null,
      ":is([data-under-start][data-under-end])": "intersect",
    },
  },
  footFill: { flexShrink: 0 },
  body: { paddingInline: grasp.space5, paddingBlockEnd: grasp.space5 },
  // A table flush under the hairline stands square (Table's corner set to 0): its box, frame and
  // ring meet the card's edges, so nothing clips the soft head's ground at its corners
  // (B-section-card-02: two white notches).
  flush: { minWidth: 0, [tableVars.corner]: 0 },
  // Flush, the title and the foot line up with the words in a table's first column.
  edgeFlush: { paddingInline: grasp.tableCellInline },
  foot: {
    paddingInline: grasp.space5,
    paddingBlock: grasp.space3,
    color: grasp.muted,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
  },
});

// Marks which ends of the body have what it holds past them, as attributes its fade reads, so it
// never renders. The observer reports once when it starts, after the page is laid out.
const watchEdges = (element: HTMLElement) => {
  const mark = () => {
    const room = element.scrollHeight - element.clientHeight;
    element.toggleAttribute(
      "data-under-start",
      room > 1 && element.scrollTop > 1
    );
    element.toggleAttribute(
      "data-under-end",
      room > 1 && element.scrollTop < room - 1
    );
  };
  const observer = new ResizeObserver(mark);
  observer.observe(element);
  for (const child of element.children) {
    observer.observe(child);
  }
  element.addEventListener("scroll", mark, { passive: true });
  return () => {
    observer.disconnect();
    element.removeEventListener("scroll", mark);
  };
};

/** One part of a page on a card: its header, what it holds, and a foot. */
/** The handle over the header, under its actions: the press a host's drag holds. */
const Handle = ({ handle }: { handle: SectionCardHandle }) => {
  const { label, ref, ...handleProps } = handle;
  return (
    <button
      ref={ref}
      type="button"
      data-slot="section-card-handle"
      aria-label={label}
      {...handleProps}
      {...stylex.props(styles.handle, focus.inside)}
    />
  );
};

/** The foot and its line: one piece, which keeps its height when the card fills its cell. */
const Foot = ({
  footer,
  fill,
  compact,
  flush,
}: {
  footer: ReactNode;
  fill: boolean;
  compact: boolean;
  flush: boolean;
}) =>
  footer === undefined || footer === null || footer === false ? null : (
    <div
      data-slot="section-card-foot"
      {...stylex.props(fill && styles.footFill)}
    >
      <Separator decorative />
      <div
        {...stylex.props(
          styles.foot,
          compact && styles.footCompact,
          flush && styles.edgeFlush
        )}
      >
        {footer}
      </div>
    </div>
  );

interface HeadProps {
  id: string;
  title: ReactNode;
  description: ReactNode;
  aside: ReactNode;
  actions: ReactNode;
  level: 2 | 3 | 4;
  loading: boolean;
  compact: boolean;
  flush: boolean;
  fill: boolean;
  handle: SectionCardHandle | undefined;
}

/** The card's header row: its title, sentence, aside and actions, and the drag handle on a board. */
const Head = ({
  id,
  title,
  description,
  aside,
  actions,
  level,
  loading,
  compact,
  flush,
  fill,
  handle,
}: HeadProps) => (
  <div
    {...stylex.props(
      styles.head,
      compact && styles.headCompact,
      flush && styles.edgeFlush,
      fill && styles.headFill,
      handle && styles.handled
    )}
  >
    {handle && <Handle handle={handle} />}
    <SectionHeader
      id={id}
      title={title}
      description={description}
      aside={aside}
      actions={actions}
      headingLevel={level}
      size={compact ? "sm" : "md"}
      loading={loading}
    />
  </div>
);

export const SectionCard = ({
  title,
  "aria-label": ariaLabel,
  description,
  aside,
  actions,
  children,
  footer,
  flush = false,
  level: levelDeprecated,
  headingLevel: level = levelDeprecated ?? 2,
  loading = false,
  fill = false,
  density = "comfortable",
  handle,
  style: styleProp,
  layout,
}: SectionCardProps) => {
  const id = useId();
  const compact = density === "compact";
  const body = useRef<HTMLDivElement | null>(null);
  // Filling its cell, what runs past the foot (or above, scrolled there by focus) fades there.
  useEffect(() => {
    const element = body.current;
    return fill && element !== null ? watchEdges(element) : undefined;
  }, [fill]);
  const titled = title !== undefined;
  const bodyLook = flush
    ? styles.flush
    : [
        styles.body,
        compact && styles.bodyCompact,
        !titled && (compact ? styles.bodyTopCompact : styles.bodyTop),
      ];
  return (
    <Card
      element="section"
      padding="none"
      fill={fill}
      aria-label={ariaLabel}
      aria-labelledby={titled && ariaLabel === undefined ? id : undefined}
      layout={layout ?? styleProp}
    >
      <div {...stylex.props(styles.card, fill && styles.cardFill)}>
        {titled && (
          <Head
            id={id}
            title={title}
            description={description}
            aside={aside}
            actions={actions}
            level={level}
            loading={loading}
            compact={compact}
            flush={flush}
            fill={fill}
            handle={handle}
          />
        )}
        {titled && flush && <Separator decorative />}
        <div
          ref={body}
          data-slot="section-card-body"
          {...stylex.props(bodyLook, fill && styles.bodyFill)}
        >
          {children}
        </div>
        <Foot footer={footer} fill={fill} compact={compact} flush={flush} />
      </div>
    </Card>
  );
};
