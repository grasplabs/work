// Item: one row of a list, a thing with its name, a line about it, a mark and its actions:
// the system's edge and corner, words in ink and muted. Plain semantic HTML: UI SDK has
// no primitive for it.
//
//   <Item variant="outline">
//     <ItemMedia variant="icon"><Icon icon={FolderIcon} /></ItemMedia>
//     <ItemContent>
//       <ItemTitle>Spring launch</ItemTitle>
//       <ItemDescription>Updated 2 hours ago</ItemDescription>
//     </ItemContent>
//     <ItemActions><Button size="sm">Open</Button></ItemActions>
//   </Item>
//
// A row that goes somewhere or does one thing: `href` makes it a link, with a chevron at its end
// unless `showChevron={false}`; `onClick` makes it one button; `asChild` makes the caller's element
// (a router's link) its press (`<Item asChild><Link to="/billing">…</Link></Item>`). The press is
// always the title, stretched over the whole row and described by the description, so ItemActions
// anywhere in the row stand above it as their own stops for the keyboard, never inside the link or
// the button. `disabled` puts the press out of use, dimmed as a disabled Button is.
//
// The parts that hold others (ItemContent, ItemActions, ItemHeader, ItemFooter) are blocks, so a
// form (a choice and its button) or a list stands in a row as it would anywhere; the title and the
// lines of words are words.
//
// In an ItemGroup each Item is a list item; an ItemSeparator between two draws the page's hairline,
// and `separated` draws it between every two.
// An ItemGrid lays Items out as tiles. Before its data, `loading` keeps the row's boxes: a part
// given empty waits as a quiet placeholder of its own size. In a narrow row the actions drop under
// the words, on the row's end edge, by the row's own width.
//
// In a side panel's card (a SidePanelSection's) an `xs` row takes the panel's rhythm: 44px, the
// panel's smaller words, its bare icon in the accent, its ItemDetail at the row's end, and the
// room of an action kept on every row, so the details end on one line. The list is flush there, a
// hairline between two rows.
//
// Every value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { mergeProps } from "@ui-sdk/react/primitive";
import {
  Fragment,
  createContext,
  createElement,
  isValidElement,
  use,
  useId,
} from "react";
import type { MouseEventHandler, ReactElement, ReactNode } from "react";

import { ChevronRightIcon, Icon } from "../lib/icons";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { isBlank, listOf } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import {
  iconVars,
  sidePanelCardMarker,
  skeletonVars,
} from "../lib/vars.stylex";
import { itemMarker, itemVars } from "./item.stylex";
import { Separator } from "./separator";
import { Skeleton } from "./skeleton";

/** `default` in a list on the page, `outline` for a row that stands alone, `muted` on a quieter fill. */
export type ItemVariant = "default" | "outline" | "muted";
/** The room round it: `default` for a list someone reads, `sm` dense, `xs` among setting rows. */
export type ItemSize = "xs" | "sm" | "default";

/** Every prop an Item takes. */
export interface ItemProps {
  /**
   * Its parts: an ItemMedia, an ItemContent (with ItemTitle and ItemDescription), ItemActions, and
   * an ItemHeader or ItemFooter. With `asChild`, the one element to draw as the row, holding them.
   */
  children: ReactNode;
  /**
   * `default` in a list on the page, `outline` for a row that stands alone, `muted` on a quieter
   * fill.
   * @default "default"
   */
  variant?: ItemVariant;
  /**
   * The room round it: `default` for a list someone reads, `sm` for a dense one, `xs` for a list
   * among setting rows (members, providers): their row height (48px; 56px with a description) and
   * their inset, so a page has one rhythm.
   * @default "default"
   */
  size?: ItemSize;
  /**
   * The open one of a list beside its detail: the selected fill, said as the current page for a
   * link (`aria-current="page"`) and as the current one otherwise.
   * @default false
   */
  active?: boolean;
  /** Where the whole row leads: it is one link, with a chevron at its end. */
  href?: string;
  /**
   * The chevron at the end of a row that is a link (`href` or `asChild`). Leave it out where every
   * row of a list plainly opens its own page (a list of sources, a page's sections).
   * @default true
   */
  showChevron?: boolean;
  /**
   * Makes the row one button: a choice ("Acme AI, European Union"), pressed by pointer, Enter or
   * Space anywhere on the row. Named by its title alone; its description is said after it. No
   * chevron: it chooses.
   */
  onClick?: MouseEventHandler<HTMLElement>;
  /**
   * Make the one element given as the child (a router's link) the row's press: it holds the parts,
   * and is drawn round the title, stretched over the row, with a chevron at the row's end and
   * `aria-current` when active.
   * @default false
   */
  asChild?: boolean;
  /**
   * Out of use, for a row that is a link or a button (`href`, `onClick` or `asChild`): dimmed as a
   * disabled Button is, with no light under a pointer, said as unavailable and still reached by Tab
   * so it can be read; a click, a middle click, Enter or Space does nothing. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /**
   * Before its data: each part given empty waits as a quiet placeholder of its own size (an
   * ItemMedia its square or its icon's box, an ItemTitle its line, an ItemDescription its line), so
   * the row stands as tall as it will be. The row says it is busy.
   * @default false
   */
  loading?: boolean;
  /** Layout only: margins, alignment and width. The look belongs to the item. */
  style?: LayoutStyle;
}

/** Every prop an ItemGroup takes. */
export interface ItemGroupProps {
  /** The Items, in the order they are read, with an ItemSeparator between two for a hairline. */
  children: ReactNode;
  /**
   * The page's hairline between every two rows, for plain rows in a long list; outlined or muted
   * rows stand apart by the gap instead. The list keeps 4px at its top and foot whatever its count,
   * a list of one row too (none in a side panel's card).
   * @default false
   */
  separated?: boolean;
  /** What the list holds, when no heading above it says ("Recent projects"). */
  "aria-label"?: string;
  /** The id of a heading that names it, in place of `aria-label`. */
  "aria-labelledby"?: string;
  /**
   * Narrower than 30rem of the list's own width (a phone, a narrow panel), each row's ItemDetail
   * goes on a line under its name, at every row size; an `xs` row's name then wraps whole, where
   * otherwise its detail stands at the row's end and the name is cut short. The list lays out by
   * its own width (a size container, as the original's row list did), so it takes none from its
   * rows: in a box that sizes to its content (a shrink-wrapped flex item, an inline-block), give
   * the list or the box a width.
   * @default false
   */
  stack?: boolean;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop an ItemGrid takes. */
export interface ItemGridProps {
  /** The Items, in the order they are read: row by row, from the start. */
  children: ReactNode;
  /** What the list holds, when no heading above it says ("Connected apps"). */
  "aria-label"?: string;
  /** The id of a heading that names it, in place of `aria-label`. */
  "aria-labelledby"?: string;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop an ItemSeparator takes. */
export interface ItemSeparatorProps {
  /** Layout only: margins. */
  style?: LayoutStyle;
}

/** Every prop an ItemMedia takes: what stands before the words. */
export interface ItemMediaProps {
  /**
   * The mark: an `<Icon />`, an Avatar for a person (`xs` or `sm`), a BrandIcon for a provider, or
   * an `<img>`. Left out in a `loading` row, it waits as its box.
   */
  children?: ReactNode;
  /**
   * `default` the mark as it is, an icon bare and muted in line with the title; `icon` an icon in
   * its 40px square (32px at `sm` and `xs`); `image` a picture cut to that square.
   * @default "default"
   */
  variant?: "default" | "icon" | "image";
  /**
   * Where it stands. `start` on the title's line (and in the middle of a row with no
   * description); `center` in the middle of its row, on all the words however many lines they
   * take, as a logo, a tile or a face stands.
   * @default "start" for a bare mark, "center" for an icon in its square or a picture
   */
  align?: "start" | "center";
  /** Layout only: margins. */
  style?: LayoutStyle;
}

/** Every prop an ItemContent, ItemTitle, ItemDescription, ItemDetail, ItemHeader or ItemFooter takes. */
export interface ItemContentProps {
  /** What it holds. Left out in a `loading` row, an ItemTitle or ItemDescription waits as its line. */
  children?: ReactNode;
  /** Layout only: margins. */
  style?: LayoutStyle;
}
export type ItemTitleProps = ItemContentProps;
export type ItemDescriptionProps = ItemContentProps;
export type ItemDetailProps = ItemContentProps;
export type ItemHeaderProps = ItemContentProps;
export type ItemFooterProps = ItemContentProps;

/** Every prop an ItemActions takes. */
export interface ItemActionsProps {
  /**
   * Its buttons, most used last ("Manage"): their own stops for the keyboard. Or a small form (a
   * choice and the button that sends it).
   */
  children?: ReactNode;
  /**
   * The actions stand quiet until the row is pointed at or holds focus: always there for the
   * keyboard (they show when they, or anything in the row, take focus), and always shown where
   * there is no pointer to hover with.
   * @default false
   */
  showOnHover?: boolean;
  /** Layout only: margins. */
  style?: LayoutStyle;
}

const HOVER = media.hover;
const FORCED = media.forcedColors;
// A list that stacks (ItemGroup's `stack`), narrower than this: an xs row's detail goes on a line
// under its name, and the name wraps, as the original's row list stacked them.
const STACK = "@container item-group-stack (width < 30rem)";

const styles = stylex.create({
  // A row whose whole width is one press: the keyboard's ring round the row when the press inside
  // it has focus, drawn inside so the card never clips it.
  focusBand: {
    outline: {
      default: "none",
      ":has([data-row-press]:focus-visible)": `${sizes.ringWidth} solid ${colors.ring}`,
    },
    outlineOffset: `calc(-1 * ${sizes.ringWidth})`,
  },
  item: {
    [iconVars.size]: sizes.iconSm,
    [iconVars.stroke]: sizes.iconStroke,
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    // The system's corner, as the original's Item: the card's.
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    color: colors.foreground,
    fontFamily: font.sans,
    textAlign: "start",
    textDecoration: "none",
    // In forced colours fills and shadows are dropped, so an outline draws an outlined item.
    outlineOffset: -1,
  },
  default: { gap: space["4"], padding: space["4"] },
  sm: {
    gap: space["3"],
    paddingBlock: space["3"],
    paddingInline: space["4"],
  },
  // The setting rows' rhythm: 8px above and below, a table cell's inset, a field row at least.
  // In a side panel's card: a finger's 44px, the panel's inset, and at the row's end, in a list
  // where some row has an action, the room of one (a 28px button and its gap) on a row that has
  // none, so every detail ends on one line; in a list with none, every detail ends at the inset.
  xs: {
    gap: {
      default: space["3"],
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: space["2"],
    },
    paddingBlock: {
      default: space["2"],
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: 0,
      [STACK]: space["2"],
    },
    paddingInlineStart: {
      default: space.tableCellInline,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]:
        space.sidePanelPadding,
    },
    paddingInlineEnd: {
      default: space.tableCellInline,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: {
        default: space.sidePanelPadding,
        ":not(:has([data-slot=item-actions]))": `calc(${space.sidePanelPadding} + ${itemVars.actionRoom})`,
      },
    },
    minHeight: {
      default: space.fieldRow,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: sizes.tapTarget,
    },
    // In a side panel's card the hairline before a row is that row's own top, as the original's
    // row list drew it: the separator lies over this edge, so a row taller than a finger's 44px
    // (a detail on its own line) is one hairline taller, and a short row stays 44px.
    borderBlockStartWidth: {
      default: null,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: itemVars.lineAbove,
    },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: "transparent",
  },
  plain: { backgroundColor: "transparent" },
  outline: {
    backgroundColor: colors.card,
    boxShadow: sizes.borderStrong,
    outline: { default: "none", [FORCED]: "1px solid CanvasText" },
  },
  muted: { backgroundColor: colors.muted },
  // The open one of a list: the selected fill (a border in forced colours, where fills drop).
  active: {
    backgroundColor: colors.accentActive,
    outlineStyle: { default: "none", [FORCED]: "solid" },
    outlineWidth: { default: null, [FORCED]: sizes.hairline },
  },
  // A row that holds a stretched press: the press's target covers it.
  stretched: { position: "relative" },
  // Out of use: dimmed as a disabled Button is, with no light under a pointer.
  disabled: { opacity: sizes.opacityDisabled, cursor: "not-allowed" },
  // A row that answers a pointer lights under it, as a ghost button does.
  link: {
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  linkPlain: {
    backgroundColor: {
      default: "transparent",
      ":hover": { default: null, [HOVER]: colors.accent },
      ":active": colors.accentActive,
    },
  },
  linkOutline: {
    backgroundColor: {
      default: colors.card,
      ":hover": { default: null, [HOVER]: colors.controlHover },
      ":active": colors.controlActive,
    },
  },
  linkMuted: {
    backgroundColor: {
      default: colors.muted,
      ":hover": { default: null, [HOVER]: colors.accent },
      ":active": colors.accentActive,
    },
  },
  // A row whose actions, header or footer may wrap: on lines of their own, a gap between them.
  wraps: { flexWrap: "wrap", rowGap: space["2"] },
  // The words take the room, but never under 10rem: past that the actions wrap under them.
  content: {
    display: "grid",
    flexGrow: 1,
    flexBasis: "10rem",
    minWidth: 0,
    gap: space["1"],
  },
  // Its title and description one line each, with no room between, as a setting row's.
  contentXs: { gap: 0 },
  // The mark as it is: centred on the title's line, or in the middle of a row with no description.
  media: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    height: font.textSmLine,
    color: colors.mutedForeground,
    alignSelf: {
      default: "flex-start",
      [stylex.when.ancestor(
        ":not(:has([data-slot=item-description]))",
        itemMarker
      )]: "center",
    },
  },
  // In a side panel's card the bare icon says what kind of thing the row is, in the one accent.
  mediaXs: {
    height: {
      default: font.textSmLine,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]:
        sizes.sidePanelTextLine,
    },
    color: {
      default: colors.mutedForeground,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: colors.mintDeep,
    },
  },
  // A mark (a logo, a tile, a face) in the middle of its row, on all the words, at its own height.
  mediaCentred: { alignSelf: "center", height: "auto" },
  // An icon in its square, at the row's size.
  mediaIcon: {
    justifyContent: "center",
    width: sizes.controlDefault,
    height: sizes.controlDefault,
    borderRadius: `min(${radius.xl}, calc(${sizes.controlDefault} / 2))`,
    cornerShape: radius.shape,
    backgroundColor: colors.control,
    boxShadow: sizes.borderStrong,
    color: colors.foreground,
  },
  // A picture cut to the square.
  mediaImage: {
    justifyContent: "center",
    width: sizes.controlDefault,
    height: sizes.controlDefault,
    overflow: "hidden",
    borderRadius: `min(${radius.xl}, calc(${sizes.controlDefault} / 2))`,
    cornerShape: radius.shape,
  },
  mediaSm: {
    width: sizes.controlSm,
    height: sizes.controlSm,
    borderRadius: `min(${radius.xl}, calc(${sizes.controlSm} / 2))`,
    cornerShape: radius.shape,
  },
  // The title and the description may shrink below their words, so a line meant to end in an
  // ellipsis (one with `white-space: nowrap` inside) is cut at the content's edge, before the
  // row's actions or chevron, rather than running under them.
  title: {
    minWidth: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightMedium,
    overflowWrap: "anywhere",
    hyphens: "manual",
  },
  // In a side panel's card: the panel's smaller words, the name and what follows it in one row;
  // in a narrow list that stacks, the name and under it its detail.
  titleXs: {
    display: {
      default: null,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: "flex",
      [STACK]: "block",
    },
    alignItems: {
      default: null,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: "center",
    },
    gap: {
      default: null,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: space["2"],
    },
    fontSize: {
      default: font.textSm,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]:
        sizes.sidePanelText,
    },
    lineHeight: {
      default: font.textSmLine,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]:
        sizes.sidePanelTextLine,
    },
  },
  // In a side panel's card: the name on one line, cut with an ellipsis so its detail stays whole;
  // in a narrow list that stacks it wraps, whole.
  nameXs: {
    minWidth: {
      default: null,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: 0,
    },
    overflow: {
      default: null,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: "hidden",
    },
    textOverflow: {
      default: null,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: "ellipsis",
    },
    whiteSpace: {
      default: null,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: "nowrap",
      [STACK]: "normal",
    },
  },
  // On the title's line, after a space and a little more room: quieter, not bolder. In a narrow
  // list that stacks, on a line of its own under the name, at every row size.
  detail: {
    display: { default: null, [STACK]: "block" },
    marginInlineStart: { default: space["1"], [STACK]: 0 },
    fontWeight: font.weightNormal,
    color: colors.mutedForeground,
  },
  // In a side panel's card: at the row's end, whole and on one line; the name gives way to it. In a
  // narrow list that stacks, on a line of its own under the name, cut with an ellipsis at the row's
  // width.
  detailXs: {
    overflow: { default: null, [STACK]: "hidden" },
    textOverflow: { default: null, [STACK]: "ellipsis" },
    marginInlineStart: {
      default: space["1"],
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: "auto",
      [STACK]: 0,
    },
    flexShrink: {
      default: null,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: 0,
    },
    whiteSpace: {
      default: null,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: "nowrap",
    },
  },
  description: {
    minWidth: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.mutedForeground,
    overflowWrap: "anywhere",
    hyphens: "manual",
  },
  // On a line of their own the actions keep to the row's end edge; above a stretched press.
  actions: {
    position: "relative",
    zIndex: 1,
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: space["2"],
    // Each control's touch target reaches the middle of the gap to the next (tapTarget).
    "--tap-room-inline": `calc(${space["2"]} / 2)`,
    marginInlineStart: "auto",
  },
  // Hidden only to the eye, never to the keyboard or a screen reader: focus shows them.
  reveal: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(":hover", itemMarker)]: 1,
      [stylex.when.ancestor(":focus-within", itemMarker)]: 1,
      [media.pointerCoarse]: 1,
    },
    transitionProperty: "opacity",
    transitionDuration: duration.hover,
  },
  // A header or a footer: a line of its own across the row, its parts at both ends.
  band: {
    display: "flex",
    flexBasis: "100%",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["2"],
    minWidth: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
  },
  // The chevron's glyph stands 9 of its 24 units in from the box's end, so the box reaches past the
  // padding by that much: the glyph's end then sits on the row's inset, as the words' start does.
  chevron: {
    display: "flex",
    flexShrink: 0,
    marginInlineEnd: `calc(${sizes.iconSm} * -9 / 24)`,
    color: colors.mutedForeground,
  },
  // The title's press: plain words whose target stretches over the row. A block the title's
  // width, so it gives way to the row's end as the title does (a button would keep its words'
  // width, and run under the chevron).
  press: {
    display: "block",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    lineHeight: "inherit",
    fontWeight: "inherit",
    textAlign: "start",
    textDecoration: "none",
    cursor: {
      default: "pointer",
      ":is([aria-disabled=true])": "not-allowed",
    },
    outline: "none",
    "::after": {
      content: '""',
      position: "absolute",
      inset: 0,
      borderRadius: "inherit",
      cornerShape: "inherit",
    },
  },
  // In a side panel's card the press is the title's flex row, so its name gives way as the title's.
  pressXs: {
    display: {
      default: "block",
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: "flex",
      [STACK]: "block",
    },
    flexGrow: {
      default: null,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: 1,
    },
    alignItems: {
      default: null,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: "center",
    },
    gap: {
      default: null,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: space["2"],
    },
  },
  // A list that stacks: its rows lay out by its own width.
  stack: { containerType: "inline-size", containerName: "item-group-stack" },
  // Lists: a real list, the rows one under another, 8px apart, or 4px either side of a hairline.
  group: {
    // The room a row keeps for an action it lacks: only where some row holds one.
    [itemVars.actionRoom]: {
      default: "0px",
      ":has([data-slot=item-actions])": `calc(${sizes.controlXs} + ${space["2"]})`,
    },
    display: "grid",
    width: "100%",
    margin: 0,
    padding: 0,
    listStyle: "none",
    // In a side panel's card the list is flush: the rows meet at the hairline.
    rowGap: {
      default: space["2"],
      ":has(> [data-slot=item-separator])": {
        default: space["1"],
        [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: 0,
      },
    },
    columnGap: {
      default: space["2"],
      ":has(> [data-slot=item-separator])": "normal",
    },
    // The same 4px at the list's top and foot gives the first and last rows as much room from the
    // card's edge or head line as from a hairline.
    paddingBlock: {
      default: 0,
      ":has(> [data-slot=item-separator])": {
        default: space["1"],
        [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: 0,
      },
    },
  },
  // A list given `separated` keeps a hairline list's rhythm whatever its count, so a list of one
  // row has the same 4px at its top and foot as a longer one, as the original's.
  separated: {
    rowGap: {
      default: space["1"],
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: 0,
    },
    columnGap: "normal",
    paddingBlock: {
      default: space["1"],
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]: 0,
    },
  },
  // A list's row: after a hairline, it tells its Item so (itemVars.lineAbove).
  row: {
    [itemVars.lineAbove]: {
      default: "0px",
      ":is([data-slot=item-separator] + *)": sizes.hairline,
    },
    display: "grid",
    minWidth: 0,
  },
  // In a side panel's card the hairline is the top of the row after it, and takes no height.
  separator: {
    display: "grid",
    margin: 0,
    padding: 0,
    marginBlockEnd: {
      default: 0,
      [stylex.when.ancestor(":is(*)", sidePanelCardMarker)]:
        `calc(-1 * ${sizes.hairline})`,
    },
  },
  grid: {
    display: "grid",
    // As many as fit, never under the tile's least width, and one whole column on a narrow page.
    gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${sizes.itemGridTile}), 1fr))`,
    gap: space["3"],
    width: "100%",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
});

const waits = stylex.create({
  // A placeholder's box, which its Skeleton fills; the square at the row's size.
  box: { [skeletonVars.size]: "100%", display: "flex", flexShrink: 0 },
  media: { width: sizes.controlDefault, height: sizes.controlDefault },
  mediaSm: { width: sizes.controlSm, height: sizes.controlSm },
  // The bare icon's box, in line with the title: a block the icon's size.
  icon: { width: sizes.iconSm, height: sizes.iconSm },
  // The title's and the description's lines, as long as a short name and a short line.
  title: { display: "flex", width: "10rem", maxWidth: "100%" },
  description: { display: "flex", width: "14rem", maxWidth: "100%" },
});

const linkLooks = {
  default: styles.linkPlain,
  outline: styles.linkOutline,
  muted: styles.linkMuted,
} as const;
const looks = {
  default: styles.plain,
  outline: styles.outline,
  muted: styles.muted,
} as const;
const roomOf = {
  xs: styles.xs,
  sm: styles.sm,
  default: styles.default,
} as const;

// The row's size, for a mark's box and the words' gap.
const RowSize = createContext<ItemSize>("default");
// Whether the row waits for its data: an empty part then draws its placeholder.
const RowLoading = createContext(false);
// In a link or a button row: the press its title carries, stretched over the row, and the id its
// description takes, so the press is named by the title and described by the description.
interface Press {
  id: string;
  href?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  element?: ReactElement<{ children?: ReactNode }>;
  active: boolean;
  disabled: boolean;
}

/** Stops a press of a row out of use: its own action, a link's way and a router's. */
const refuse = (event: { preventDefault: () => void }) => {
  event.preventDefault();
};

/**
 * A row out of use, whatever its press: said unavailable and still a stop for Tab, so its name and
 * its reason can be read; a click, a middle click, Enter or Space does nothing and goes nowhere.
 */
const outOfUse = {
  "aria-disabled": true,
  onClick: refuse,
  onAuxClick: refuse,
};
/** An element's attributes the DOM draws on any element: ARIA, data, its id, class, style, title, language and direction. */
const attributesOf = (props: object): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(props).filter(([key]) =>
      /^(?:aria-|data-|(?:id|className|style|title|lang|dir)$)/u.test(key)
    )
  );
const TitlePress = createContext<Press | undefined>(undefined);
// Whether the Item stands in an ItemGroup or an ItemGrid: then it is a list item.
const InList = createContext(false);

/** Whether the parts hold one of these parts with something in it. */
const holds = (children: ReactNode, parts: readonly unknown[]) =>
  listOf(children).some(
    (child) =>
      isValidElement<{ children?: ReactNode }>(child) &&
      parts.includes(child.type) &&
      !isBlank(child.props.children)
  );

/** What stands before the words: a mark as it is, an icon in its square, or a picture. */
export const ItemMedia = ({
  children,
  variant = "default",
  align: given,
  style,
}: ItemMediaProps) => {
  // A square or a picture stands in the middle of its row, on all the words; a bare icon on the
  // title's line.
  const align = given ?? (variant === "default" ? "start" : "center");
  const sized = use(RowSize);
  const small = sized !== "default";
  if (use(RowLoading) && isBlank(children)) {
    // The bare icon waits in line with the title; the square at the row's size. Each placeholder
    // is its box's own size, so its ground and pixels are whole.
    return variant === "default" ? (
      <span
        aria-hidden="true"
        data-slot="item-media"
        {...stylex.props(styles.media, style)}
      >
        <span {...stylex.props(waits.box, waits.icon)}>
          <Skeleton variant="rectangular" />
        </span>
      </span>
    ) : (
      <span
        aria-hidden="true"
        data-slot="item-media"
        {...stylex.props(waits.box, waits.media, small && waits.mediaSm, style)}
      >
        <Skeleton variant="rectangular" />
      </span>
    );
  }
  if (isBlank(children)) {
    return null;
  }
  return (
    <span
      data-slot="item-media"
      data-variant={variant}
      {...stylex.props(
        styles.media,
        align === "center" && styles.mediaCentred,
        variant === "default" && sized === "xs" && styles.mediaXs,
        variant === "icon" && styles.mediaIcon,
        variant === "image" && styles.mediaImage,
        variant !== "default" && small && styles.mediaSm,
        style
      )}
    >
      {children}
    </span>
  );
};

/** The words: the title, and the line about it under it. */
export const ItemContent = ({ children, style }: ItemContentProps) => (
  <div
    data-slot="item-content"
    {...stylex.props(
      styles.content,
      use(RowSize) === "xs" && styles.contentXs,
      style
    )}
  >
    {children}
  </div>
);

/** The title's words, as the row's stretched press when the row is a link or a button. */
const TitleWords = ({ children }: { children: ReactNode }): ReactNode => {
  const press = use(TitlePress);
  const dense = use(RowSize) === "xs";
  if (press === undefined) {
    return children;
  }
  const { id, href, onClick, element, active, disabled } = press;
  const own = {
    "data-row-press": "",
    "aria-describedby": `${id}-description`,
    ...stylex.props(styles.press, dense && styles.pressXs),
  };
  // The caller's element (a router's link) carries the title alone; the row holds its other parts.
  if (element !== undefined && !disabled) {
    return createElement(
      element.type,
      mergeProps(
        { ...own, "aria-current": active ? "page" : undefined },
        element.props
      ),
      children
    );
  }
  if (href !== undefined || element !== undefined) {
    // Out of use a link has no address, so nothing (a middle click, the menu's "Open in new tab")
    // can follow it: still a link, and a stop for Tab. A router's link is then this plain one, as
    // its own element would draw its address whatever it is given; it keeps the caller's attributes
    // (a name, a class, an id, a test id), never its address or its handlers.
    return (
      <a
        href={disabled ? undefined : href}
        role={disabled ? "link" : undefined}
        tabIndex={disabled ? 0 : undefined}
        {...mergeProps(
          { ...own, "aria-current": active ? "page" : undefined },
          element === undefined ? {} : attributesOf(element.props),
          disabled ? outOfUse : { onClick }
        )}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      {...(disabled ? outOfUse : { onClick })}
      {...own}
    >
      {children}
    </button>
  );
};

const isWords = (part: ReactNode): boolean =>
  typeof part === "string" || typeof part === "number";

/**
 * An xs row's words: the name (the words before its first element) in a span of its own, in order,
 * so in a side panel's card, where the title is a flex row, the name alone gives way with an
 * ellipsis and what follows it (a mark, the detail) stays whole. A name not written as words
 * first is left as written.
 */
const nameFirst = (children: ReactNode): ReactNode => {
  const parts = [children].flat();
  const first = parts.findIndex((part) => !isWords(part));
  const end = first === -1 ? parts.length : first;
  if (end === 0) {
    return children;
  }
  return createElement(
    Fragment,
    null,
    createElement("span", stylex.props(styles.nameXs), ...parts.slice(0, end)),
    ...parts.slice(end)
  );
};

/** Its name, in a few words ("Spring launch"). */
export const ItemTitle = ({ children, style }: ItemTitleProps) => {
  const dense = use(RowSize) === "xs";
  return (
    <span
      data-slot="item-title"
      {...stylex.props(styles.title, dense && styles.titleXs, style)}
    >
      {use(RowLoading) && isBlank(children) ? (
        <span {...stylex.props(waits.title)}>
          <Skeleton />
        </span>
      ) : (
        <TitleWords>{dense ? nameFirst(children) : children}</TitleWords>
      )}
    </span>
  );
};

/**
 * A quieter word or two on the title's line, after the name: a role, "you", a count ("Admin"). In
 * the muted ink at the regular weight; it wraps with the title, never cut off. Put it in the
 * ItemTitle. On an `xs` row in a side panel's card it stands at the row's end instead, on one line.
 * In an ItemGroup that stacks, narrower than 30rem, it stands on a line of its own under the name.
 */
export const ItemDetail = ({ children, style }: ItemDetailProps) => {
  const dense = use(RowSize) === "xs";
  return isBlank(children) ? null : (
    <>
      {" "}
      <span
        data-slot="item-detail"
        {...stylex.props(styles.detail, dense && styles.detailXs, style)}
      >
        {children}
      </span>
    </>
  );
};

/** One line about it: a date, a state, a count ("Updated 2 hours ago"). It wraps; never cut off. */
export const ItemDescription = ({ children, style }: ItemDescriptionProps) => {
  const press = use(TitlePress);
  const waiting = use(RowLoading) && isBlank(children);
  // With no words, nothing: the row then centres its mark on the title alone.
  if (!waiting && isBlank(children)) {
    return null;
  }
  return (
    <span
      id={press === undefined ? undefined : `${press.id}-description`}
      data-slot="item-description"
      {...stylex.props(styles.description, style)}
    >
      {waiting ? (
        <span {...stylex.props(waits.description)}>
          <Skeleton />
        </span>
      ) : (
        children
      )}
    </span>
  );
};

/** Buttons at the end of the row, most used last ("Manage"), each its own stop for the keyboard. */
export const ItemActions = ({
  children,
  showOnHover = false,
  style,
}: ItemActionsProps) =>
  isBlank(children) ? null : (
    <div
      data-slot="item-actions"
      {...stylex.props(styles.actions, showOnHover && styles.reveal, style)}
    >
      {children}
    </div>
  );

/** A line of its own above the row's parts: a label and a control at its ends. */
export const ItemHeader = ({ children, style }: ItemHeaderProps) => (
  <div data-slot="item-header" {...stylex.props(styles.band, style)}>
    {children}
  </div>
);

/** A line of its own under the row's parts: a note and a control at its ends. */
export const ItemFooter = ({ children, style }: ItemFooterProps) => (
  <div data-slot="item-footer" {...stylex.props(styles.band, style)}>
    {children}
  </div>
);

/** The chevron at a link's end. */
const Chevron = () => (
  <span aria-hidden="true" {...stylex.props(styles.chevron)}>
    <Icon icon={ChevronRightIcon} />
  </span>
);

/** What every form of the row is drawn from: its parts, settled once. */
interface RowShape extends Omit<ItemProps, "children" | "asChild"> {
  /** The parts, the row's own or its element's. */
  parts: ReactNode;
  /** Whether the parts hold actions, or a header or a footer, which may wrap. */
  wraps: boolean;
}

/** The row's look: its box, its room, its fill, a pointer's light when it answers one, its ring. */
const lookOf = (
  {
    variant = "default",
    size = "default",
    active = false,
    disabled = false,
    wraps,
    style,
  }: RowShape,
  pressed: boolean
) =>
  stylex.props(
    itemMarker,
    styles.item,
    roomOf[size],
    looks[variant],
    pressed && [styles.stretched, styles.focusBand],
    pressed && !disabled && [styles.link, linkLooks[variant]],
    pressed && disabled && styles.disabled,
    wraps && styles.wraps,
    active && styles.active,
    style
  );

/** The parts, with the row's size and whether it waits. */
const Parts = ({ parts, size = "default", loading = false }: RowShape) => (
  <RowSize value={size}>
    <RowLoading value={loading}>{parts}</RowLoading>
  </RowSize>
);

/** A link, a button or the caller's element: its title is the press, stretched over the row. */
const PressRow = ({
  element,
  ...shape
}: RowShape & { element: Press["element"] }) => {
  const id = useId();
  const {
    href,
    onClick,
    active = false,
    disabled = false,
    showChevron = true,
    loading = false,
  } = shape;
  const linked = href !== undefined && href !== "";
  const press: Press = {
    id,
    href: linked ? href : undefined,
    onClick,
    element,
    active,
    disabled,
  };
  return (
    <div
      data-slot="item"
      aria-busy={loading || undefined}
      {...lookOf(shape, true)}
    >
      {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled */}
      <TitlePress value={press}>
        <Parts {...shape} />
      </TitlePress>
      {(linked || element !== undefined) && showChevron && <Chevron />}
    </div>
  );
};

/** The row itself: a box, or a press stretched over it. */
const Row = ({ children, asChild = false, ...props }: ItemProps) => {
  const element =
    asChild && isValidElement<{ children?: ReactNode }>(children)
      ? children
      : undefined;
  const parts = element === undefined ? children : element.props.children;
  const shape: RowShape = {
    ...props,
    parts,
    wraps: holds(parts, [ItemActions, ItemHeader, ItemFooter]),
  };
  const { href, onClick, active = false, loading = false } = shape;
  if (
    element !== undefined ||
    (href !== undefined && href !== "") ||
    onClick !== undefined
  ) {
    return <PressRow {...shape} element={element} />;
  }
  return (
    <div
      data-slot="item"
      aria-current={active ? "true" : undefined}
      aria-busy={loading || undefined}
      {...lookOf(shape, false)}
    >
      <Parts {...shape} />
    </div>
  );
};

/** One row of a list: its name, a line about it, a mark and its actions, or a link or a choice. */
export const Item = (props: ItemProps) => {
  if (!use(InList)) {
    return <Row {...props} />;
  }
  // In an ItemGroup or an ItemGrid, a row of its list. The list item is its root there, so the
  // caller's layout is the list item's.
  const { style, ...rest } = props;
  return (
    <li {...stylex.props(styles.row, style)}>
      <Row {...rest} />
    </li>
  );
};

/** The page's hairline between two Items. */
export const ItemSeparator = ({ style }: ItemSeparatorProps) =>
  use(InList) ? (
    <li
      role="none"
      data-slot="item-separator"
      {...stylex.props(styles.separator, style)}
    >
      <Separator decorative />
    </li>
  ) : (
    <div data-slot="item-separator" {...stylex.props(styles.separator, style)}>
      <Separator decorative />
    </div>
  );

/** The rows, the page's hairline between every two: an ItemSeparator before each but the first. */
const separate = (children: ReactNode) =>
  listOf(children).map((child, at) => (
    <Fragment
      key={isValidElement(child) && child.key !== null ? child.key : `@${at}`}
    >
      {at > 0 && <ItemSeparator />}
      {child}
    </Fragment>
  ));

/** A list of Items, one per row. */
export const ItemGroup = ({
  children,
  separated = false,
  "aria-label": label,
  "aria-labelledby": labelledBy,
  stack = false,
  style,
}: ItemGroupProps) => (
  <InList value>
    <ul
      // oxlint-disable-next-line jsx-a11y/no-redundant-roles -- Safari drops a list's role once its markers are hidden
      role="list"
      aria-label={label}
      aria-labelledby={labelledBy}
      data-slot="item-group"
      {...stylex.props(
        styles.group,
        separated && styles.separated,
        stack && styles.stack,
        style
      )}
    >
      {separated ? separate(children) : children}
    </ul>
  </InList>
);

/** Items as tiles, as many per row as fit. */
export const ItemGrid = ({
  children,
  "aria-label": label,
  "aria-labelledby": labelledBy,
  style,
}: ItemGridProps) => (
  <InList value>
    <ul
      // oxlint-disable-next-line jsx-a11y/no-redundant-roles -- Safari drops a list's role once its markers are hidden
      role="list"
      aria-label={label}
      aria-labelledby={labelledBy}
      data-slot="item-grid"
      {...stylex.props(styles.grid, style)}
    >
      {children}
    </ul>
  </InList>
);
