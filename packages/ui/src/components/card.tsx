// Card: a surface that holds one thing and what belongs to it: a white surface with
// a hairline and a soft lift, the one corner, and room inside.
//
//   <Card>
//     <CardTitle>Quarterly review</CardTitle>
//     <CardDescription>Due on Friday. Three people are working on it.</CardDescription>
//   </Card>
//
// A card of parts: a header with its action, what it holds, and a footer row. With a CardContent
// the parts carry the room themselves (a section of a page on a card): the header and the footer
// stand apart from it, and a `flush` CardContent runs edge to edge under a hairline (a Table, a list
// of Items). `size="sm"` is the dense form, a settings card.
//
//   <Card asChild size="sm">
//     <section>
//       <CardHeader>
//         <CardTitle level={2}>Members</CardTitle>
//         <CardDescription>Who can open this workspace.</CardDescription>
//         <CardAction><Button size="sm">Invite</Button></CardAction>
//       </CardHeader>
//       <CardContent flush><Table … /></CardContent>
//       <CardFooter>3 of 25 seats used</CardFooter>
//     </section>
//   </Card>
//
//   <CardLink href="/knowledge/pricing">                 the whole card one link
//     <CardMedia><img src={drawing} alt="" /></CardMedia>  dims to 0.85 on hover and focus
//     <CardTitle>Pricing</CardTitle>                    underlined on hover and focus
//   </CardLink>
//
// A title over a group of cards is the page's: `<section><SectionHeader /><Card>…</Card></section>`.
// A card has no behaviour of its own: it is a box, so it needs no primitive. Every value is a
// token. A caller may set layout and width only (the `style` prop).
import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import {
  createContext,
  isValidElement,
  use,
  useEffect,
  useId,
  useState,
} from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

import { focusRing, hyphenate } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { className, slotProps } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { motionVars } from "../lib/vars.stylex";
import { cardLinkMarker, cardVars } from "./card.stylex";

/** Every prop a Card takes. */
export interface CardProps {
  /** What it holds: a CardTitle and a CardDescription, or a CardHeader, a CardContent and a CardFooter. */
  children: ReactNode;
  /**
   * `sm` for a dense card, a settings card: the header's title and sentence at text-sm, and less
   * room round its parts. It sets the room of a card of parts (with a CardContent).
   * @default "default"
   */
  size?: "default" | "sm";
  /**
   * The surface: `default`, the usual card, with its edge and lift; or `outline`, a quiet panel set
   * apart on a raised page, with its edge only.
   * @default "default"
   */
  variant?: "default" | "outline";
  /**
   * The room inside a card that holds its words itself: `none` for a picture that runs to the
   * edge, `default` 16px, `lg` 24px. A card with a CardContent leaves the room to its parts.
   * @default "default"
   */
  padding?: "none" | "default" | "lg";
  /**
   * Draw the card as its one child element: an `article` for something that stands alone, a
   * `section` for a part of a page (a landmark); either is named by its CardTitle. An `li` in a list.
   * @default false
   */
  asChild?: boolean;
  /**
   * The card takes the height it is given (a dashboard's fixed grid cell) and clips what does not
   * fit: a single child, or a CardContent, stretches to fill it. Without it the card is as tall as
   * what it holds.
   * @default false
   */
  fullHeight?: boolean;
  /** Its name for a screen reader, where no title inside names it (a `section` with no title). */
  "aria-label"?: string;
  /** The id of what names it, when it is not its CardTitle. */
  "aria-labelledby"?: string;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop a CardHeader takes. */
export interface CardHeaderProps {
  /** A CardTitle and a CardDescription, and a CardAction at its end. */
  children: ReactNode;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop a CardTitle takes. */
export interface CardTitleProps {
  /** Its words: what the card is, in a few words. */
  children: ReactNode;
  /**
   * The heading level it is in the page's outline, so levels never skip.
   * @default 3
   */
  level?: 2 | 3 | 4;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop a CardDescription takes. */
export interface CardDescriptionProps {
  /** One or two sentences under the title. */
  children: ReactNode;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop a CardAction takes. */
export interface CardActionProps {
  /** The card's own buttons or menu, at the header's end: one or two small controls. */
  children: ReactNode;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop a CardContent takes. */
export interface CardContentProps {
  /** What the card holds. */
  children: ReactNode;
  /**
   * It runs edge to edge under a hairline, with no room of its own: a Table, a list of Items. The
   * header and the footer then line up with a table's first column.
   * @default false
   */
  flush?: boolean;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop a CardFooter takes. */
export interface CardFooterProps {
  /** What closes the card: its buttons, a total, when it was last updated, a link to all. */
  children: ReactNode;
  /**
   * Where its parts stand in the row: from the start, at the end, or the first at the start and
   * the last at the end.
   * @default "start"
   */
  justify?: "start" | "end" | "between";
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop a CardMedia takes. */
export interface CardMediaProps {
  /** A drawing or a picture: an `<img alt="">` or an inline SVG, at the card's width. */
  children: ReactNode;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop a CardLink takes. */
export interface CardLinkProps {
  /** A CardMedia, a CardTitle and a CardDescription. Hold no other link or button in it. */
  children: ReactNode;
  /** Where it goes: the whole card is this one link. */
  href?: string;
  /**
   * Draw the link as its one child element, the link a router draws (`<Link to="…">`), which
   * takes the card's look and its children.
   * @default false
   */
  asChild?: boolean;
  /**
   * The surface, as a Card's.
   * @default "default"
   */
  variant?: "default" | "outline";
  /**
   * The room inside, as a Card's.
   * @default "default"
   */
  padding?: "none" | "default" | "lg";
  /** Its name, when its title and words do not say where it goes. */
  "aria-label"?: string;
  /** The ids of what describes it beyond its name, said after the name. */
  "aria-describedby"?: string;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

// A card of parts: one that holds a CardContent. Its parts then carry the room themselves.
const PARTS = ":has(> [data-slot=card-content])";
// A header or a footer in a card of parts, and in one whose CardContent runs edge to edge.
const BEFORE_CONTENT = ":has(~ [data-slot=card-content])";
const BEFORE_FLUSH = ":has(~ [data-slot=card-content][data-flush])";
const AFTER_CONTENT = ":is([data-slot=card-content] ~ *)";
const AFTER_FLUSH = ":is([data-slot=card-content][data-flush] ~ *)";

const styles = stylex.create({
  card: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignContent: "start",
    // A title and its line stand 4px apart; a card with a CardHeader parts its pieces by 16px; a
    // card of parts sets its pieces' room itself.
    rowGap: {
      default: space[1],
      ":has(> [data-slot=card-header]):not(:has(> [data-slot=card-content]))":
        space[4],
      [PARTS]: 0,
    },
    boxSizing: "border-box",
    minWidth: 0,
    margin: 0,
    listStyle: "none",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    // The edge and the lift together, from the system: a hairline that adds no size.
    boxShadow: shadow.md,
    // In forced colours the shadow is dropped, so a real border draws the edge there.
    borderWidth: { default: 0, [media.forcedColors]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    color: colors.bodyForeground,
    fontFamily: font.sans,
    overflowWrap: "anywhere",
  },
  default: { backgroundColor: colors.card },
  // A panel lies in the page: its edge, no lift.
  outline: { backgroundColor: colors.muted, boxShadow: sizes.borderStrong },
  // As tall as its cell: one child stretches to it, several stand from the top, and what runs past
  // the foot is clipped (the card's own lift is drawn outside it, so it stays). A card of parts
  // gives the room to its CardContent.
  fullHeight: {
    display: { default: "grid", [PARTS]: "flex" },
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    alignContent: { default: "start", ":has(> :only-child)": "stretch" },
  },
  none: { padding: 0, [cardVars.inset]: "0px" },
  paddingDefault: {
    padding: { default: space[4], [PARTS]: 0 },
    [cardVars.inset]: space[4],
  },
  lg: {
    padding: { default: space[6], [PARTS]: 0 },
    [cardVars.inset]: space[6],
  },
  // The title and body: their type is the card's, or a section's in a card of parts (the header
  // sets it). Its own tracking, so a host page's heading rules never reach it.
  title: {
    margin: 0,
    minWidth: 0,
    // A heading never hyphenates: a long word wraps whole, or breaks only where it must.
    hyphens: "manual",
    fontFamily: font.sans,
    fontSize: cardVars.titleSize,
    lineHeight: cardVars.titleLine,
    fontWeight: font.weightMedium,
    letterSpacing: cardVars.titleTracking,
    color: colors.foreground,
  },
  // The title of a linked card: underlined while the card is hovered or focused by the keys.
  titleLinked: {
    textDecorationLine: {
      default: "none",
      [stylex.when.ancestor(":hover", cardLinkMarker)]: {
        default: "none",
        [media.hover]: "underline",
      },
      [stylex.when.ancestor(":focus-visible", cardLinkMarker)]: "underline",
    },
    textUnderlineOffset: "0.2em",
    textDecorationThickness: sizes.hairline,
  },
  description: {
    margin: 0,
    fontSize: cardVars.descriptionSize,
    lineHeight: cardVars.descriptionLine,
    letterSpacing: font.trackingUi,
    color: colors.mutedForeground,
    // Its lines break as the browser breaks them, as the original's: a "pretty" wrap moved a word
    // to the next line where the original's did not.
  },
  // A card that is one link: the card's own look, no underline of its own, the card's focus ring.
  // It answers a pointer through its parts (the media dims, the title is underlined): no lift, no
  // movement.
  link: {
    color: colors.bodyForeground,
    textDecorationLine: "none",
    cursor: "pointer",
  },
  // A drawing or picture at the card's top: on the linked card's hover or keyboard focus it dims to
  // 0.85 on the house curve; with reduced motion at once.
  media: {
    display: "block",
    overflow: "hidden",
    // Concentric with the card: the card's corner less its padding, and never under the smallest
    // corner.
    borderRadius: `max(${radius.sm}, calc(${radius.xl} - ${cardVars.inset}))`,
    cornerShape: radius.shape,
    opacity: {
      default: 1,
      [stylex.when.ancestor(":hover", cardLinkMarker)]: {
        default: 1,
        [media.hover]: 0.85,
      },
      [stylex.when.ancestor(":focus-visible", cardLinkMarker)]: 0.85,
    },
    transitionProperty: "opacity",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  // The header: the title and the line under it in one column, the action at its end beside both;
  // when the card is too narrow for both, the action goes under the words. In a card of parts it
  // has its own room, and a section's type.
  header: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    justifyContent: "space-between",
    columnGap: space[4],
    rowGap: space[3],
    minWidth: 0,
    paddingBlock: { default: 0, [BEFORE_CONTENT]: space[5] },
    paddingInline: {
      default: 0,
      [BEFORE_CONTENT]: space[5],
      [BEFORE_FLUSH]: space.tableCellInline,
    },
    [cardVars.titleSize]: {
      default: font.headingXs,
      [BEFORE_CONTENT]: font.textLg,
    },
    [cardVars.titleLine]: {
      default: font.headingXsLine,
      [BEFORE_CONTENT]: font.textLgLine,
    },
    [cardVars.titleTracking]: {
      default: font.trackingUiTitle,
      [BEFORE_CONTENT]: font.trackingUi,
    },
    [cardVars.descriptionLine]: {
      default: font.textBaseTightLine,
      [BEFORE_CONTENT]: font.textBaseLine,
    },
  },
  // The dense header: its title and sentence at text-sm, the sentence right under the title, on
  // the title's line when there is no sentence.
  headerSm: {
    alignItems: {
      default: "flex-start",
      ":not(:has([data-slot=card-description]))": "center",
    },
    paddingBlock: { default: 0, [BEFORE_CONTENT]: space[3] },
    paddingInline: {
      default: 0,
      [BEFORE_CONTENT]: space[4],
      [BEFORE_FLUSH]: space.tableCellInline,
    },
    [cardVars.titleSize]: {
      default: font.headingXs,
      [BEFORE_CONTENT]: font.textSm,
    },
    [cardVars.titleLine]: {
      default: font.headingXsLine,
      [BEFORE_CONTENT]: font.textSmLine,
    },
    [cardVars.descriptionSize]: {
      default: font.textBase,
      [BEFORE_CONTENT]: font.textSm,
    },
    [cardVars.descriptionLine]: {
      default: font.textBaseTightLine,
      [BEFORE_CONTENT]: font.textSmLine,
    },
  },
  headerFullHeight: { flexShrink: 0 },
  words: {
    display: "grid",
    rowGap: space[1],
    flexGrow: 1,
    flexBasis: 0,
    minWidth: { default: 0, ":has(> [data-slot=card-description])": "10rem" },
  },
  // The dense header's sentence stands right under its title.
  wordsSm: { rowGap: 0 },
  action: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[2],
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    maxWidth: "100%",
  },
  content: {
    minWidth: 0,
    paddingInline: space[5],
    paddingBlockEnd: space[5],
    // With no header, the room over what it holds is the room at its sides.
    paddingBlockStart: { default: 0, ":first-child": space[5] },
  },
  contentSm: {
    paddingInline: space[4],
    paddingBlockEnd: space[4],
    paddingBlockStart: { default: 0, ":first-child": space[4] },
  },
  // Edge to edge, under a hairline when something stands above it.
  flush: {
    minWidth: 0,
    padding: 0,
    borderBlockStartWidth: { default: sizes.hairline, ":first-child": 0 },
    borderBlockStartStyle: "solid",
    borderBlockStartColor: {
      default: colors.border,
      [media.forcedColors]: "CanvasText",
    },
  },
  // Filling the card's height: it takes what the header and the footer leave, and clips.
  contentFullHeight: {
    flexGrow: 1,
    flexBasis: 0,
    minHeight: 0,
    overflow: "hidden",
  },
  // The footer: its parts in a row, on their middle. In a card of parts, a line at the foot under
  // a hairline, in the muted small type.
  footer: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space[2],
    minWidth: 0,
    flexShrink: 0,
    paddingBlock: { default: 0, [AFTER_CONTENT]: space[3] },
    paddingInline: {
      default: 0,
      [AFTER_CONTENT]: space[5],
      [AFTER_FLUSH]: space.tableCellInline,
    },
    borderBlockStartWidth: { default: null, [AFTER_CONTENT]: sizes.hairline },
    borderBlockStartStyle: { default: null, [AFTER_CONTENT]: "solid" },
    borderBlockStartColor: {
      default: null,
      [AFTER_CONTENT]: {
        default: colors.border,
        [media.forcedColors]: "CanvasText",
      },
    },
    color: { default: null, [AFTER_CONTENT]: colors.mutedForeground },
    fontSize: { default: null, [AFTER_CONTENT]: font.textSm },
    lineHeight: { default: null, [AFTER_CONTENT]: font.textSmLine },
  },
  footerSm: {
    paddingInline: {
      default: 0,
      [AFTER_CONTENT]: space[4],
      [AFTER_FLUSH]: space.tableCellInline,
    },
  },
  start: { justifyContent: "flex-start" },
  end: { justifyContent: "flex-end" },
  between: { justifyContent: "space-between" },
});

/**
 * What a card hands its parts: its size, its fill, the id its title takes, and how its title says
 * it is there, so the card is named by a title only when it has one.
 */
const CardSize = createContext<"default" | "sm">("default");
const CardFullHeight = createContext(false);
const CardTitleId = createContext<string | undefined>(undefined);
const CardTitled = createContext<Dispatch<SetStateAction<boolean>> | undefined>(
  undefined
);

const paddingOf = (padding: NonNullable<CardProps["padding"]>) => {
  if (padding === "none") {
    return styles.none;
  }
  return padding === "lg" ? styles.lg : styles.paddingDefault;
};

export const Card = ({
  children,
  size = "default",
  variant = "default",
  padding = "default",
  asChild = false,
  fullHeight = false,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  style,
}: CardProps) => {
  const titleId = useId();
  const [titled, setTitled] = useState(false);
  const slot = slotProps(asChild, children);
  // Drawn as a section (a landmark) or an article, it is named by its title unless it is named
  // otherwise.
  const landmark =
    isValidElement(slot.render) &&
    (slot.render.type === "section" || slot.render.type === "article");
  const named = landmark && ariaLabel === undefined;
  return (
    <CardSize value={size}>
      <CardFullHeight value={fullHeight}>
        <CardTitleId
          value={named && labelledBy === undefined ? titleId : undefined}
        >
          <CardTitled value={setTitled}>
            {renderElement(
              "div",
              {
                "data-slot": "card",
                "data-size": size,
                "aria-label": ariaLabel,
                "aria-labelledby":
                  labelledBy ?? (named && titled ? titleId : undefined),
                ...stylex.props(
                  styles.card,
                  hyphenate,
                  variant === "outline" ? styles.outline : styles.default,
                  paddingOf(padding),
                  fullHeight && styles.fullHeight,
                  style
                ),
                children: slot.children,
              },
              slot.render
            )}
          </CardTitled>
        </CardTitleId>
      </CardFullHeight>
    </CardSize>
  );
};

/** The card's title: a heading, so a screen reader can move from card to card. */
export const CardTitle = ({ children, level = 3, style }: CardTitleProps) => {
  const Heading = `h${level}` as const;
  const setTitled = use(CardTitled);
  // The card is named by its title only while the title is there.
  useEffect(() => {
    setTitled?.(true);
    return () => {
      setTitled?.(false);
    };
  }, [setTitled]);
  return (
    <Heading
      id={use(CardTitleId)}
      data-slot="card-title"
      {...stylex.props(styles.title, styles.titleLinked, style)}
    >
      {children}
    </Heading>
  );
};

/** One or two sentences under the title, in muted. */
export const CardDescription = ({ children, style }: CardDescriptionProps) => (
  <p data-slot="card-description" {...stylex.props(styles.description, style)}>
    {children}
  </p>
);

/** The card's own buttons or menu, at the end of its header beside the title and its line. */
export const CardAction = ({ children, style }: CardActionProps) => (
  <div data-slot="card-action" {...stylex.props(styles.action, style)}>
    {children}
  </div>
);

const isAction = (child: ReactNode) =>
  isValidElement(child) && child.type === CardAction;

/** The card's header: its title and the line under it, and a CardAction at its end. */
export const CardHeader = ({ children, style }: CardHeaderProps) => {
  const sm = use(CardSize) === "sm";
  const fullHeight = use(CardFullHeight);
  // Its children as a list (one child, or the list JSX writes for several): the action apart.
  const all = [children].flat();
  return (
    <div
      data-slot="card-header"
      {...stylex.props(
        styles.header,
        sm && styles.headerSm,
        fullHeight && styles.headerFullHeight,
        style
      )}
    >
      <div {...stylex.props(styles.words, sm && styles.wordsSm)}>
        {all.filter((child) => !isAction(child))}
      </div>
      {all.filter(isAction)}
    </div>
  );
};

/** What the card holds, with the card's room round it, or edge to edge under a hairline. */
export const CardContent = ({
  children,
  flush = false,
  style,
}: CardContentProps) => {
  const sm = use(CardSize) === "sm";
  const fullHeight = use(CardFullHeight);
  return (
    <div
      data-slot="card-content"
      data-flush={flush ? "" : undefined}
      {...stylex.props(
        flush ? styles.flush : [styles.content, sm && styles.contentSm],
        fullHeight && styles.contentFullHeight,
        style
      )}
    >
      {children}
    </div>
  );
};

const justifyOf = (justify: NonNullable<CardFooterProps["justify"]>) => {
  if (justify === "end") {
    return styles.end;
  }
  return justify === "between" ? styles.between : styles.start;
};

/** The card's footer: its buttons, a total or a link, in a row at its foot. */
export const CardFooter = ({
  children,
  justify = "start",
  style,
}: CardFooterProps) => {
  const sm = use(CardSize) === "sm";
  return (
    <div
      data-slot="card-footer"
      {...stylex.props(
        styles.footer,
        sm && styles.footerSm,
        justifyOf(justify),
        style
      )}
    >
      {children}
    </div>
  );
};

/** A drawing or picture at the top of a card; in a CardLink it dims on hover and focus. */
export const CardMedia = ({ children, style }: CardMediaProps) => (
  <span data-slot="card-media" {...stylex.props(styles.media, style)}>
    {children}
  </span>
);

/**
 * A card that is one link: the whole card goes where `href` (or its child link) goes, with the
 * card's focus ring. Hovered or focused by the keys, a CardMedia in it dims to 0.85 and its
 * CardTitle is underlined; nothing lifts or moves. Hold no other link or button in it.
 */
export const CardLink = ({
  children,
  href,
  asChild = false,
  variant = "default",
  padding = "default",
  style,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
}: CardLinkProps) => {
  const slot = slotProps(asChild, children);
  return renderElement(
    "a",
    {
      href,
      "data-slot": "card-link",
      "aria-label": ariaLabel,
      "aria-describedby": describedBy,
      className: className(
        cardLinkMarker,
        styles.card,
        hyphenate,
        variant === "outline" ? styles.outline : styles.default,
        paddingOf(padding),
        styles.link,
        focusRing,
        style
      ),
      children: slot.children,
    },
    slot.render
  );
};
