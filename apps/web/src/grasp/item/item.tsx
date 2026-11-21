// Item: one row of a list, a thing with its name, a line about it, an icon and its actions, from
// shadcn's (registry/bases/base/ui/item.tsx), converted from Tailwind to StyleX and made Grasp's:
// the system's edge and corner, Geist, words in ink and muted. Plain semantic HTML: UI SDK has no
// primitive for it, and a row is a <div> or, with `href`, a link.
//
// Since release step 6 its words, mark and actions are parts, as in shadcn's:
//
//   <Item>
//     <ItemMedia icon={Folder} />
//     <ItemContent>
//       <ItemTitle>Spring launch</ItemTitle>
//       <ItemDescription>Updated 2 hours ago</ItemDescription>
//     </ItemContent>
//     <ItemActions><Button>Open</Button></ItemActions>
//   </Item>
//
// The older shape below keeps working until step 9:
//
//   <Item icon={Folder} title="Spring launch" description="Updated 2 hours ago" />
//   <Item variant="outline" title="Two-step sign-in" description="On" actions={<Button>Manage</Button>} />
//   <Item href="/settings/billing" title="Billing" description="Plan, invoices and payment" />
//   <Item media={<Avatar name="Anna de Vries" size="xs" />} title="Anna de Vries" description="anna@…" actions={…} />
//   <Item icon={Key} iconLook="inline" title="API key" description="Ending in 4f2a" />
//
// Before its data, `loading` keeps the row's boxes: a part given empty waits as a quiet placeholder
// of its own size (the mark's square, the title's line, the description's line), so the row is
// already as tall as it will be:
//
//   <Item loading><ItemMedia /><ItemContent><ItemTitle /><ItemDescription /></ItemContent></Item>
//
// In a narrow row the actions drop under the words, on the row's end edge, rather than squeeze
// them: by the row's own width, not the window's.
//
// Every value is a token (src/tokens). A caller may set layout only (the `style` prop).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import type { RenderProp } from "@ui-sdk/react/primitive";
import { createContext, isValidElement, useContext, useId } from "react";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import { ChevronRight, Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { Separator } from "../separator";
import { Skeleton } from "../skeleton";
import { grasp, media } from "../tokens/tokens.stylex";
import { ItemGroupContext } from "./context";
import { itemMarker, itemRowMarker } from "./markers.stylex";

export type ItemVariant = "plain" | "outline" | "soft";
export type ItemSize = "xs" | "sm" | "md";

/** What a caller may style: where the item sits and how wide it is. Never its look. */
export type ItemLayoutStyle = LayoutStyle;

/** What every item takes. */
interface ItemBase {
  /**
   * Its parts: an ItemMedia, an ItemContent (with ItemTitle and ItemDescription) and ItemActions.
   * Leave it out only in the older shape, where `title` and the props below draw the row.
   */
  children?: ReactNode;
  /** @deprecated Use `ItemTitle`. */
  title?: ReactNode;
  /** @deprecated Use `ItemDetail`, in the ItemTitle. */
  detail?: ReactNode;
  /** @deprecated Use `ItemDescription`. */
  description?: ReactNode;
  /** @deprecated Use `ItemMedia.icon`. */
  icon?: IconData;
  /** @deprecated Use `ItemMedia.iconLook`. */
  iconLook?: "square" | "inline";
  /** @deprecated Use `ItemMedia`, with the mark as its children. */
  media?: ReactNode;
  /**
   * `plain` in a list on the page, `outline` for a row that stands alone, `soft` on a quieter fill.
   * @default "plain"
   */
  variant?: ItemVariant;
  /**
   * The open one of a list beside its detail: the selected fill, said as the current page for a
   * link (`aria-current="page"`) and as the current one otherwise.
   * @default false
   */
  current?: boolean;
  /**
   * The room round it: `md` for a list someone reads, `sm` for a dense one, `xs` for a list
   * among setting rows (members, providers): their row height (setting-row, 48px; 56px with a
   * description) and their inset, so a page has one rhythm.
   * @default "md"
   */
  size?: ItemSize;
  /**
   * Before its data, in the parts shape: each part given empty waits as a quiet placeholder of its
   * own size (an ItemMedia with no icon its square, or the bare icon's box with `iconLook="inline"`, an ItemTitle its line, an ItemDescription its
   * line), so the row stands as tall as it will be. The row says it is busy.
   * @default false
   */
  loading?: boolean;
  /** @deprecated Use `layout`. */
  style?: ItemLayoutStyle;
  /** Layout only: margins, alignment and width. The look belongs to the item. */
  layout?: ItemLayoutStyle;
}

/**
 * An item that does things: its buttons at the end.
 */
interface WithActions {
  /** @deprecated Use `ItemActions`. */
  actions?: ReactNode;
  href?: never;
  render?: never;
  onPress?: never;
}

/**
 * An item that is one choice: the whole row is a button, as a provider's tile is ("Anthropic,
 * European Union"). Its name is the title alone; its description is said after it. No chevron: it
 * goes nowhere, it chooses.
 */
interface AsButton {
  /** Runs when the row is pressed, by pointer, Enter or Space. It holds no buttons of its own. */
  onPress: () => void;
  href?: never;
  render?: never;
  actions?: never;
}

/**
 * An item that is a link: the whole row goes there, with a chevron at its end.
 */
type AsLink = {
  /** Where the whole row leads. It is then one link, so it holds no buttons of its own. */
  href?: string;
  /**
   * The element the row is drawn as, for a router's link (`render={<Link to="/billing" />}`): it
   * takes the row's look, its words and `aria-current`, and keeps its own props. Without it, an
   * `<a href>`. Leave `href` out when the router's link carries the address.
   */
  render?: RenderProp;
  actions?: never;
  onPress?: never;
} & ({ href: string } | { render: RenderProp });

/** Every prop an Item takes. */
export type ItemProps = ItemBase & (WithActions | AsLink | AsButton);

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
  // The open one of a list: the selected fill (a border in forced colours, where fills drop).
  current: {
    backgroundColor: grasp.ghostFillPress,
    outlineStyle: { default: "none", [FORCED]: "solid" },
    outlineWidth: { default: null, [FORCED]: grasp.hairline },
  },
  // A row that is a button: no button's own box, the row's words and font.
  button: {
    appearance: "none",
    borderWidth: 0,
    fontSize: "inherit",
    lineHeight: "inherit",
  },
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
  // A mark (a logo, a tile, a face) in the middle of its row, on all the words, at its own height.
  mediaCentred: { alignSelf: "center", height: "auto" },
  // In the parts shape: centred when the row has no description, read from the row.
  leadAuto: {
    alignSelf: {
      default: "flex-start",
      [stylex.when.ancestor(
        ":not(:has([data-slot=item-description]))",
        itemMarker
      )]: "center",
    },
  },
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
      <span {...stylex.props(styles.mediaSlot, styles.mediaCentred)}>
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

// ---- The parts (release step 6) --------------------------------------------------------------------

/** Nothing to show: none, false, or empty words. */
const isBlank = (children: ReactNode) =>
  children === undefined ||
  children === null ||
  children === false ||
  children === "";

/** Every prop an ItemMedia takes: what stands before the words. Give an icon or a mark. */
export interface ItemMediaProps {
  /** An icon, when it says what kind of thing it is. From the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /**
   * How the icon stands: `square` in its 40px box (32px at `sm`), or `inline`, the bare icon in
   * line with the title, for a row that is dense or carries its kind in its words already.
   * @default "square"
   */
  iconLook?: "square" | "inline";
  /**
   * In place of an icon: an Avatar for a person (`xs` or `sm`), or a Brand icon for a provider.
   * Centred on the title's line, with the row's gap after it.
   */
  children?: ReactNode;
  /**
   * Where a mark stands. A logo, a tile or a face stands in the middle of its row, centred on all
   * the words however many lines they take (Ruben, 18 November: "a logo stands in the middle of its
   * row, not on the title's line"). `title` keeps it on the title's line instead.
   * @default "center"
   */
  align?: "title" | "center";
}

/** Every prop an ItemContent, ItemTitle, ItemDetail, ItemDescription or ItemActions takes. */
export interface ItemPartProps {
  /** What it holds. Left out in a `loading` row, an ItemTitle or ItemDescription waits as its line. */
  children?: ReactNode;
}

const waits = stylex.create({
  // The mark's square, at the row's size.
  media: { flexShrink: 0, width: grasp.controlMd, height: grasp.controlMd },
  mediaSm: { width: grasp.controlSm, height: grasp.controlSm },
  // The bare icon's box, in line with the title.
  icon: { flexShrink: 0, width: grasp.iconSm, height: grasp.iconSm },
  // The title's and the description's lines, as long as a short name and a short line.
  title: { width: "10rem", maxWidth: "100%" },
  description: { width: "14rem", maxWidth: "100%" },
});

// The row's size, for a mark's box and the words' gap.
const RowSize = createContext<ItemSize>("md");
// Whether the row waits for its data: an empty part then draws its placeholder.
const RowLoading = createContext(false);
// In a row that is a button: the ids its title and description take, so the button is named by the
// title alone and described by the description.
const PressIds = createContext<string | undefined>(undefined);
/** A part's id in a row that is a button, from the row's own: none in any other row. */
const pressId = (base: string | undefined, part: "title" | "description") =>
  base === undefined ? undefined : `${base}-${part}`;

/** What stands before the words: an icon in its square, the bare icon in line, or a mark. */
export const ItemMedia = ({
  icon,
  iconLook = "square",
  align,
  children,
}: ItemMediaProps) => {
  const size = useContext(RowSize);
  const waiting = useContext(RowLoading);
  if (waiting && !icon && (children === undefined || children === null)) {
    // The bare icon waits in line with the title; the square at the row's size.
    return iconLook === "inline" ? (
      <span
        aria-hidden="true"
        {...stylex.props(styles.mediaInline, styles.leadAuto)}
      >
        <Skeleton variant="block" layout={waits.icon} />
      </span>
    ) : (
      <Skeleton
        variant="block"
        layout={[waits.media, size !== "md" && waits.mediaSm]}
      />
    );
  }
  if (children !== undefined && children !== null) {
    return (
      <span
        {...stylex.props(
          styles.mediaSlot,
          styles.leadAuto,
          align !== "title" && styles.mediaCentred
        )}
      >
        {children}
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
          ? [styles.mediaInline, styles.leadAuto]
          : [styles.media, size !== "md" && styles.mediaSm]
      )}
    >
      <Icon icon={icon} />
    </span>
  );
};

/** The words: the title, and the line about it under it. */
export const ItemContent = ({ children }: ItemPartProps) => {
  const size = useContext(RowSize);
  return (
    <span {...stylex.props(styles.words, size === "xs" && styles.wordsXs)}>
      {children}
    </span>
  );
};

/** Its name, in a few words ("Spring launch"). */
export const ItemTitle = ({ children }: ItemPartProps) => (
  <span
    id={pressId(useContext(PressIds), "title")}
    {...stylex.props(styles.title)}
  >
    {useContext(RowLoading) && isBlank(children) ? (
      <Skeleton layout={waits.title} />
    ) : (
      children
    )}
  </span>
);

/**
 * A quieter word or two on the title's line, after the name: a role, "you", a count ("Admin"). In
 * the muted ink at the regular weight; it wraps with the title, never cut off. Put it in the ItemTitle.
 */
export const ItemDetail = ({ children }: ItemPartProps) =>
  children === undefined || children === null || children === false ? null : (
    <>
      {" "}
      <span data-slot="item-detail" {...stylex.props(styles.detail)}>
        {children}
      </span>
    </>
  );

/** The description's line, with the id a row that is a button describes itself by. */
const Described = ({ children }: { children: ReactNode }) => (
  <span
    id={pressId(useContext(PressIds), "description")}
    data-slot="item-description"
    {...stylex.props(styles.description)}
  >
    {children}
  </span>
);

/** One line about it: a date, a state, a count ("Updated 2 hours ago"). It wraps; never cut off. */
export const ItemDescription = ({ children }: ItemPartProps) => {
  const waiting = useContext(RowLoading);
  if (waiting && isBlank(children)) {
    return (
      <Described>
        <Skeleton layout={waits.description} />
      </Described>
    );
  }
  // With no words, nothing: the row then centres its mark on the title alone.
  return isBlank(children) ? null : <Described>{children}</Described>;
};

/** Buttons at the end of the row, most used last ("Manage"). Not in an Item with `href`. */
export const ItemActions = ({ children }: ItemPartProps) =>
  isBlank(children) ? null : (
    <span {...stylex.props(styles.actions, styles.actionsEnd)}>{children}</span>
  );

/** Children as a flat list: one child, or a list (as JSX writes several). */
const listOf = (children: ReactNode): ReactNode[] => [children].flat();
/** Whether the parts hold actions: then the row may wrap them under its words. */
const holdsActions = (children: ReactNode) =>
  listOf(children).some(
    (child) =>
      isValidElement<ItemPartProps>(child) &&
      child.type === ItemActions &&
      !isBlank(child.props.children)
  );

/** Whether the row is a link: an address, or a router's link of the caller's. */
const isLinked = (href: string | undefined, render: RenderProp | undefined) =>
  (href !== undefined && href !== "") || render !== undefined;

/** Whether a line under the title is there to show. */
const hasLine = (line: ReactNode) =>
  line !== undefined && line !== null && line !== false && line !== "";

/** The row as a link: an `<a href>`, or the caller's router link through `render`. */
const RowLink = ({
  href,
  render,
  current,
  className,
  children,
}: {
  href: string | undefined;
  render: RenderProp | undefined;
  current: boolean;
  className: string | undefined;
  children: ReactNode;
}) =>
  renderElement(
    "a",
    {
      href,
      "data-slot": "item",
      "aria-current": current ? "page" : undefined,
      className,
      children,
    },
    render
  );

/** A row in the parts shape that is one button: named by its title, described by its description. */
const PressRow = ({
  children,
  variant = "plain",
  size = "md",
  onPress,
  current = false,
  layout,
}: Pick<ItemProps, "children" | "variant" | "size" | "current" | "layout"> & {
  onPress: () => void;
}) => {
  const id = useId();
  return (
    <button
      type="button"
      data-slot="item"
      aria-labelledby={pressId(id, "title")}
      aria-describedby={pressId(id, "description")}
      aria-current={current ? "true" : undefined}
      onClick={onPress}
      {...stylex.props(
        itemMarker,
        styles.item,
        styles.button,
        styles[size],
        styles[variant],
        styles.link,
        linkLook[variant],
        current && styles.current,
        focus.ring,
        layout
      )}
    >
      <PressIds value={id}>
        <RowSize value={size}>{children}</RowSize>
      </PressIds>
    </button>
  );
};

/** A row in the parts shape: its parts, and a link's chevron at the end. */
const PartsRow = ({
  children,
  variant = "plain",
  size = "md",
  href,
  render,
  current = false,
  layout,
  onPress,
  loading = false,
}: Pick<
  ItemProps,
  | "children"
  | "variant"
  | "size"
  | "href"
  | "render"
  | "current"
  | "layout"
  | "onPress"
  | "loading"
>) => {
  if (onPress !== undefined) {
    return (
      <PressRow
        variant={variant}
        size={size}
        onPress={onPress}
        current={current}
        layout={layout}
      >
        {children}
      </PressRow>
    );
  }
  const linked = isLinked(href, render);
  const inside = (
    <RowSize value={size}>
      <RowLoading value={loading}>{children}</RowLoading>
      {linked && (
        <span aria-hidden="true" {...stylex.props(styles.chevron)}>
          <Icon icon={ChevronRight} />
        </span>
      )}
    </RowSize>
  );
  if (linked) {
    return (
      <RowLink
        href={href}
        render={render}
        current={current}
        className={
          stylex.props(
            itemMarker,
            styles.item,
            styles[size],
            styles[variant],
            styles.link,
            linkLook[variant],
            current && styles.current,
            focus.ring,
            layout
          ).className
        }
      >
        {inside}
      </RowLink>
    );
  }
  return (
    <div
      data-slot="item"
      aria-current={current ? "true" : undefined}
      aria-busy={loading || undefined}
      {...stylex.props(
        itemMarker,
        styles.item,
        styles[size],
        styles[variant],
        holdsActions(children) && styles.wraps,
        current && styles.current,
        layout
      )}
    >
      {inside}
    </div>
  );
};

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
  render,
  current = false,
  style: styleProp,
  layout,
}: ItemProps) => {
  const linked = isLinked(href, render);
  const acting = Boolean(actions);
  const inside = (
    <>
      <Lead
        icon={icon}
        iconLook={iconLook}
        media={mark}
        size={size}
        alone={!hasLine(description)}
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
      <RowLink
        href={href}
        render={render}
        current={current}
        className={
          stylex.props(
            styles.item,
            styles[size],
            styles[variant],
            styles.link,
            linkLook[variant],
            current && styles.current,
            focus.ring,
            layout ?? styleProp
          ).className
        }
      >
        {inside}
      </RowLink>
    );
  }
  return (
    <div
      data-slot="item"
      aria-current={current ? "true" : undefined}
      {...stylex.props(
        styles.item,
        styles[size],
        styles[variant],
        acting && styles.wraps,
        current && styles.current,
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
export const Item = ({ style: styleProp, layout, ...props }: ItemProps) => {
  const group = useContext(ItemGroupContext);
  const placed = layout ?? styleProp;
  // The parts shape when it has children; the older shape, drawn from its props, when not.
  const Row = props.children === undefined ? ItemRow : PartsRow;
  if (!group.grouped) {
    return <Row {...props} layout={placed} />;
  }
  // In an ItemGroup, a row of its list, with the hairline over it when the group is separated. The
  // list item is its root there, so the caller's layout is the list item's.
  return (
    <li
      {...stylex.props(
        rowStyles.row,
        itemRowMarker,
        group.separated && rowStyles.lined,
        placed
      )}
    >
      {group.separated && (
        <span {...stylex.props(rowStyles.line)}>
          <Separator decorative />
        </span>
      )}
      <Row {...props} />
    </li>
  );
};
