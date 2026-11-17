// Item: one row of a list, a thing with its name, a line about it, an icon and its actions, from
// shadcn's (registry/bases/base/ui/item.tsx), converted from Tailwind to StyleX and made Grasp's:
// the system's edge and corner, Geist, words in ink and muted. Plain semantic HTML: UI SDK has no
// primitive for it, and a row is a <div> or, with `href`, a link.
//
//   <Item icon={Folder} title="Spring launch" description="Updated 2 hours ago" />
//   <Item variant="outline" title="Two-step sign-in" description="On" actions={<Button>Manage</Button>} />
//   <Item href="/settings/billing" title="Billing" description="Plan, invoices and payment" />
//   <Item media={<Avatar name="Anna de Vries" size="xs" />} title="Anna de Vries" description="anna@…" actions={…} />
//   <Item icon={Key} iconLook="inline" title="API key" description="Ending in 4f2a" />
//
// In a narrow row the actions drop under the words, on the row's end edge, rather than squeeze
// them: by the row's own width, not the window's.
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
import type { LayoutStyle } from "../layout/layout";
import { Separator } from "../separator";
import { grasp, media } from "../tokens/tokens.stylex";
import { ItemGroupContext } from "./context";
import { itemRowMarker } from "./markers.stylex";

export type ItemVariant = "plain" | "outline" | "soft";
export type ItemSize = "xs" | "sm" | "md";

/** What a caller may style: where the item sits and how wide it is. Never its look. */
export type ItemLayoutStyle = LayoutStyle;

/** What every item takes. */
interface ItemBase {
  /** Its name, in a few words ("Spring launch"). */
  title: ReactNode;
  /**
   * A quieter word or two on the title's line, after the name: a role, "you", a count ("Admin").
   * In the muted ink at the regular weight; it wraps with the title, never cut off.
   */
  detail?: ReactNode;
  /** One line about it: a date, a state, a count ("Updated 2 hours ago"). It wraps; never cut off. */
  description?: ReactNode;
  /** An icon in a square before the words, when it says what kind of thing it is. From the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * How the icon stands: `square` in its 40px box (32px at `sm`), or `inline`, the bare icon in
   * line with the title, for a row that is dense or carries its kind in its words already.
   * @default "square"
   */
  iconLook?: "square" | "inline";
  /**
   * Before the words, in place of an icon: an Avatar for a person (`xs` or `sm`), or a Brand icon
   * for a provider. Centred on the title's line, with the row's gap after it.
   */
  media?: ReactNode;
  /**
   * `plain` in a list on the page, `outline` for a row that stands alone, `soft` on a quieter fill.
   * @default "plain"
   */
  variant?: ItemVariant;
  /**
   * The room round it: `md` for a list someone reads, `sm` for a dense one, `xs` for a list
   * among setting rows (members, providers): their row height (setting-row, 48px; 56px with a
   * description) and their inset, so a page has one rhythm.
   * @default "md"
   */
  size?: ItemSize;
  /** Layout only: margins, alignment and width. The look belongs to the item. */
  style?: ItemLayoutStyle;
  /** The same as `style`, by a name a style lint does not take for an inline style attribute. */
  layout?: ItemLayoutStyle;
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
  // The setting rows' rhythm: 8px above and below, a table cell's inset, setting-row at least.
  xs: {
    gap: grasp.space3,
    paddingBlock: grasp.space2,
    paddingInline: grasp.tableCellInline,
    minHeight: grasp.settingRow,
  },
  // Its title and description one line each, with no room between, as a setting row's.
  wordsXs: { gap: 0 },
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
  // The words take the room, but never under 10rem: past that the actions wrap under them.
  words: {
    display: "grid",
    flexGrow: 1,
    flexBasis: "10rem",
    minWidth: 0,
    gap: grasp.space1,
  },
  // A row whose actions may wrap: under the words, a gap between the lines.
  wraps: { flexWrap: "wrap", rowGap: grasp.space2 },
  // An icon in line with the title: the bare icon, centred on its line.
  mediaInline: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    alignSelf: "flex-start",
    height: grasp.textSmLine,
    color: grasp.muted,
  },
  // A person's or a provider's mark before the words: centred on the title's line, so a row with a
  // line under its title keeps the mark by its name.
  mediaSlot: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    alignSelf: "flex-start",
    height: grasp.textSmLine,
  },
  leadAlone: { alignSelf: "center" },
  // On a line of their own the actions keep to the row's end edge.
  actionsEnd: { marginInlineStart: "auto" },
  title: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    overflowWrap: "anywhere",
    hyphens: "manual",
  },
  // On the title's line, after a space and a little more room: quieter, not bolder.
  detail: {
    marginInlineStart: grasp.space1,
    fontWeight: grasp.weightRegular,
    color: grasp.muted,
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
/** What stands before the words: a mark, an icon in its square, or the bare icon in line. */
const Lead = ({
  icon,
  iconLook,
  media: mark,
  size,
  alone,
}: Pick<ItemProps, "icon" | "iconLook" | "media" | "size"> & {
  alone: boolean;
}) => {
  // On the title's line: at the top with a line under the title, centred when the title is alone
  // (the row centres its one line).
  if (mark !== undefined && mark !== null) {
    return (
      <span {...stylex.props(styles.mediaSlot, alone && styles.leadAlone)}>
        {mark}
      </span>
    );
  }
  if (!icon) {
    return null;
  }
  return (
    <span
      aria-hidden="true"
      {...stylex.props(
        iconLook === "inline"
          ? [styles.mediaInline, alone && styles.leadAlone]
          : [styles.media, size !== "md" && styles.mediaSm]
      )}
    >
      <Icon icon={icon} />
    </span>
  );
};

/** The title, and its quieter detail on the same line. */
const Title = ({ title, detail }: Pick<ItemProps, "title" | "detail">) => (
  <span {...stylex.props(styles.title)}>
    {title}
    {detail !== undefined && detail !== null && detail !== false && (
      <>
        {" "}
        <span data-slot="item-detail" {...stylex.props(styles.detail)}>
          {detail}
        </span>
      </>
    )}
  </span>
);

const ItemRow = ({
  title,
  detail,
  description,
  icon,
  iconLook = "square",
  media: mark,
  variant = "plain",
  size = "md",
  actions,
  href,
  style: styleProp,
  layout,
}: ItemProps) => {
  const linked = href !== undefined && href !== "";
  const acting = Boolean(actions);
  const inside = (
    <>
      <Lead
        icon={icon}
        iconLook={iconLook}
        media={mark}
        size={size}
        alone={
          description === undefined ||
          description === null ||
          description === false ||
          description === ""
        }
      />
      <span {...stylex.props(styles.words, size === "xs" && styles.wordsXs)}>
        <Title title={title} detail={detail} />
        {Boolean(description) && (
          <span {...stylex.props(styles.description)}>{description}</span>
        )}
      </span>
      {acting && (
        <span {...stylex.props(styles.actions, styles.actionsEnd)}>
          {actions}
        </span>
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
          layout ?? styleProp
        )}
      >
        {inside}
      </a>
    );
  }
  return (
    <div
      data-slot="item"
      {...stylex.props(
        styles.item,
        styles[size],
        styles[variant],
        acting && styles.wraps,
        layout ?? styleProp
      )}
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
