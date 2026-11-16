// Item: one row of a list, a thing with its name, a line about it, an icon and its actions, from
// shadcn's (registry/bases/base/ui/item.tsx), converted from Tailwind to StyleX and made Grasp's:
// the system's edge and corner, Geist, words in ink and muted. Plain semantic HTML: UI SDK has no
// primitive for it, and a row is a <div> or, with `href`, a link.
//
//   <Item icon={Folder} title="Spring launch" description="Updated 2 hours ago" />
//   <Item variant="outline" title="Two-step sign-in" description="On" actions={<Button>Manage</Button>} />
//   <Item href="/settings/billing" title="Billing" description="Plan, invoices and payment" />
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { useContext } from "react";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { ChevronRight, Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import { Separator } from "../separator";
import { grasp, media } from "../tokens/tokens.stylex";
import { ItemGroupContext } from "./context";
import { itemRowMarker } from "./markers.stylex";

export type ItemVariant = "plain" | "outline" | "soft";
export type ItemSize = "sm" | "md";

type Layout = string | number | null;

/** What a caller may style: where the item sits and how wide it is. Never its look. */
export type ItemLayoutStyle = stylex.StyleXStyles<{
  alignSelf?: Layout;
  justifySelf?: Layout;
  flexGrow?: Layout;
  flexShrink?: Layout;
  flexBasis?: Layout;
  gridArea?: Layout;
  gridColumn?: Layout;
  gridRow?: Layout;
  order?: Layout;
  width?: Layout;
  minWidth?: Layout;
  maxWidth?: Layout;
  margin?: Layout;
  marginBlock?: Layout;
  marginBlockStart?: Layout;
  marginBlockEnd?: Layout;
  marginInline?: Layout;
  marginInlineStart?: Layout;
  marginInlineEnd?: Layout;
}>;

/** What every item takes. */
interface ItemBase {
  /** Its name, in a few words ("Spring launch"). */
  title: ReactNode;
  /** One line about it: a date, a state, a count ("Updated 2 hours ago"). It wraps; never cut off. */
  description?: ReactNode;
  /** An icon in a square before the words, when it says what kind of thing it is. From the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * `plain` in a list on the page, `outline` for a row that stands alone, `soft` on a quieter fill.
   * @default "plain"
   */
  variant?: ItemVariant;
  /**
   * The room round it: `md` for a list someone reads, `sm` for a dense one.
   * @default "md"
   */
  size?: ItemSize;
  /** Layout only: margins, alignment and width. The look belongs to the item. */
  style?: ItemLayoutStyle;
}

/**
 * An item that does things: its buttons at the end.
 */
interface WithActions {
  /** Buttons at the end of the row, most used last ("Manage"). Not with `href`. */
  actions?: ReactNode;
  href?: never;
}

/**
 * An item that is a link: the whole row goes there, with a chevron at its end.
 */
interface AsLink {
  /** Where the whole row leads. It is then one link, so it holds no buttons of its own. */
  href: string;
  actions?: never;
}

/** Every prop an Item takes. */
export type ItemProps = ItemBase & (WithActions | AsLink);

const HOVER = media.hover;
const FORCED = media.forced;

const styles = stylex.create({
  item: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    color: grasp.ink,
    fontFamily: grasp.fontSans,
    textAlign: "start",
    textDecoration: "none",
    // In forced colours fills and shadows are dropped, so an outline draws an outlined item.
    outlineOffset: -1,
  },
  md: { gap: grasp.space4, padding: grasp.space4 },
  sm: {
    gap: grasp.space3,
    paddingBlock: grasp.space3,
    paddingInline: grasp.space4,
  },
  plain: { backgroundColor: "transparent" },
  outline: {
    backgroundColor: grasp.raised,
    boxShadow: grasp.edge,
    outline: { default: "none", [FORCED]: "1px solid CanvasText" },
  },
  soft: { backgroundColor: grasp.soft },
  // A link lights under a pointer, as a ghost button does.
  link: {
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  linkPlain: {
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: grasp.ghostFillHover },
      ":active": grasp.ghostFillPress,
    },
  },
  linkOutline: {
    backgroundColor: {
      default: grasp.raised,
      ":hover": { default: null, [HOVER]: grasp.quietFillHover },
      ":active": grasp.quietFillPress,
    },
  },
  linkSoft: {
    backgroundColor: {
      default: grasp.soft,
      ":hover": { default: null, [HOVER]: grasp.ghostFillHover },
      ":active": grasp.ghostFillPress,
    },
  },
  media: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
    width: grasp.controlMd,
    height: grasp.controlMd,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlMd} / 2))`,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.quietFill,
    boxShadow: grasp.edge,
    color: grasp.ink,
  },
  mediaSm: {
    width: grasp.controlSm,
    height: grasp.controlSm,
    borderRadius: `min(${grasp.corner}, calc(${grasp.controlSm} / 2))`,
  },
  words: {
    display: "grid",
    flexGrow: 1,
    minWidth: 0,
    gap: grasp.space1,
  },
  title: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    overflowWrap: "anywhere",
    hyphens: "manual",
  },
  description: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
    overflowWrap: "anywhere",
    hyphens: "manual",
  },
  actions: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space2,
  },
  // The chevron's glyph stands 9 of its 24 units in from the box's end, so the box reaches past the
  // padding by that much: the glyph's end then sits on the row's inset, as the words' start does.
  chevron: {
    display: "flex",
    flexShrink: 0,
    marginInlineEnd: `calc(${grasp.iconSm} * -9 / 24)`,
    color: grasp.muted,
  },
});

const linkLook = {
  plain: styles.linkPlain,
  outline: styles.linkOutline,
  soft: styles.linkSoft,
} as const;

// The row itself: a link, or a plain box.
const ItemRow = ({
  title,
  description,
  icon,
  variant = "plain",
  size = "md",
  actions,
  href,
  style,
}: ItemProps) => {
  const linked = href !== undefined && href !== "";
  const inside = (
    <>
      {icon && (
        <span
          aria-hidden="true"
          {...stylex.props(styles.media, size === "sm" && styles.mediaSm)}
        >
          <Icon icon={icon} />
        </span>
      )}
      <span {...stylex.props(styles.words)}>
        <span {...stylex.props(styles.title)}>{title}</span>
        {Boolean(description) && (
          <span {...stylex.props(styles.description)}>{description}</span>
        )}
      </span>
      {Boolean(actions) && (
        <span {...stylex.props(styles.actions)}>{actions}</span>
      )}
      {linked && (
        <span aria-hidden="true" {...stylex.props(styles.chevron)}>
          <Icon icon={ChevronRight} />
        </span>
      )}
    </>
  );
  if (linked) {
    return (
      <a
        href={href}
        data-slot="item"
        {...stylex.props(
          styles.item,
          styles[size],
          styles[variant],
          styles.link,
          linkLook[variant],
          focus.ring,
          style
        )}
      >
        {inside}
      </a>
    );
  }
  return (
    <div
      data-slot="item"
      {...stylex.props(styles.item, styles[size], styles[variant], style)}
    >
      {inside}
    </div>
  );
};

// In an ItemGroup: each row stands space-1 clear of the hairline over it, above and below, so a
// row's hover or focus fill never touches the line. The first row has no line.
const rowStyles = stylex.create({
  row: { display: "grid", minWidth: 0 },
  lined: { rowGap: grasp.space1 },
  line: {
    display: {
      default: "contents",
      [stylex.when.ancestor(":first-child", itemRowMarker)]: "none",
    },
  },
});

/** One row of a list: its name, a line about it, an icon and its actions, or a link. */
export const Item = (props: ItemProps) => {
  const group = useContext(ItemGroupContext);
  const row = <ItemRow {...props} />;
  if (!group.grouped) {
    return row;
  }
  // In an ItemGroup, a row of its list, with the hairline over it when the group is separated.
  return (
    <li
      {...stylex.props(
        rowStyles.row,
        itemRowMarker,
        group.separated && rowStyles.lined
      )}
    >
      {group.separated && (
        <span {...stylex.props(rowStyles.line)}>
          <Separator decorative />
        </span>
      )}
      {row}
    </li>
  );
};
