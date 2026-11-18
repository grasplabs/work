// Card: a surface that holds one thing and what belongs to it, from shadcn's
// (registry/bases/base/ui/card.tsx), converted from Tailwind to StyleX and made Grasp's on the
// proportions of Palermo's Card: a white surface with a hairline and a soft lift, the one corner,
// and room inside of 16 or 24px.
//
//   <Card>
//     <CardTitle>Quarterly review</CardTitle>
//     <CardDescription>Due on Friday. Three people are working on it.</CardDescription>
//   </Card>
//   <Card ground="soft" padding="lg" element="article">…</Card>
//   <Card fill>…</Card>                          the height of its grid cell, what does not fit clipped
//   <CardLink href="/knowledge/pricing">                 the whole card one link
//     <CardMedia><img src={drawing} alt="" /></CardMedia>  dims to 0.85 on hover and focus
//     <CardTitle>Pricing</CardTitle>                    underlined on hover and focus
//   </CardLink>
//
// A card has no behaviour of its own: it is a box, so it needs no primitive. Every value is a token
// (src/tokens). A caller may set layout and width only (the `style` prop).
/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import type { RenderProp } from "@ui-sdk/react/primitive";
import type { ReactNode } from "react";

import { focus } from "../focus/focus";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { cardLinkMarker } from "./markers.stylex";

/** What a caller may style: where the card sits and how wide it is. Never its look. */
export type CardLayoutStyle = LayoutStyle;

/** Every prop a Card takes. */
export interface CardProps {
  /** What it holds: a CardTitle and a CardDescription, then anything else that belongs to it. */
  children: ReactNode;
  /**
   * The surface: `raised`, the usual card, with its edge and lift; or `soft`, a quiet panel set
   * apart on a raised page, with its edge only.
   * @default "raised"
   */
  variant?: "raised" | "soft";
  /** @deprecated Use `variant`. */
  ground?: "raised" | "soft";
  /**
   * The room inside: `none` for a table or a picture that runs to the edge, `md` 16px, `lg` 24px.
   * @default "md"
   */
  padding?: "none" | "md" | "lg";
  /**
   * The element it is: `article` for something that stands alone (a post, a result), `section`
   * for a part of a page with a heading, `li` in a list of cards.
   * @default "div"
   */
  element?: "div" | "article" | "section" | "li";
  /** Its name for a screen reader, where no heading inside names it (a `section` with no title). */
  "aria-label"?: string;
  /** The id of what names it, a heading inside it. */
  "aria-labelledby"?: string;
  /**
   * The card takes the height it is given (a dashboard's fixed grid cell) and clips what does not
   * fit. A single child, a Section card's inside or a chart, stretches to fill it; several stand
   * from the top. Without it the card is as tall as what it holds.
   * @default false
   */
  fill?: boolean;
  /** @deprecated Use `layout`. */
  style?: CardLayoutStyle;
  /** Layout only: margins, alignment and width. */
  layout?: CardLayoutStyle;
}

/** Every prop a CardTitle takes. */
export interface CardTitleProps {
  /** Its words: what the card is, in a few words. */
  children: ReactNode;
  /**
   * The heading level it is in the page's outline, so levels never skip.
   * @default 3
   */
  headingLevel?: 2 | 3 | 4;
  /** @deprecated Use `headingLevel`. */
  level?: 2 | 3 | 4;
}

/** Every prop a CardDescription takes. */
export interface CardDescriptionProps {
  /** One or two sentences under the title. */
  children: ReactNode;
}

const styles = stylex.create({
  card: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignContent: "start",
    rowGap: grasp.space1,
    boxSizing: "border-box",
    minWidth: 0,
    margin: 0,
    listStyle: "none",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    // The edge and the lift together, from the system: a hairline that adds no size.
    boxShadow: grasp.liftMedium,
    // In forced colours the shadow is dropped, so a real border draws the edge there.
    borderWidth: { default: 0, [media.forced]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    color: grasp.text,
    fontFamily: grasp.fontSans,
    overflowWrap: "anywhere",
    hyphens: "auto",
  },
  raised: { backgroundColor: grasp.raised },
  // A panel lies in the page: its edge, no lift.
  soft: { backgroundColor: grasp.soft, boxShadow: grasp.edge },
  // As tall as its cell: one child stretches to it, several stand from the top, and what runs past
  // the foot is clipped (the card's own lift is drawn outside it, so it stays).
  fill: {
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    alignContent: { default: "start", ":has(> :only-child)": "stretch" },
  },
  none: { padding: 0 },
  md: { padding: grasp.space4 },
  lg: { padding: grasp.space6 },
  // Palermo's title and body: 18 on 24, then 15 on 20 right under it. Its own tracking, so a
  // host page's heading rules never reach it; it wraps as words do, not balanced.
  title: {
    margin: 0,
    // A heading never hyphenates: a long word wraps whole, or breaks only where it must.
    hyphens: "manual",
    fontFamily: grasp.fontSans,
    fontSize: grasp.titleUi,
    lineHeight: grasp.titleUiLine,
    fontWeight: grasp.weightMedium,
    letterSpacing: grasp.trackingUiTitle,
    color: grasp.ink,
  },
  // A card that is one link: the card's own look, no underline of its own, the card's focus ring.
  // It answers a pointer through its parts (the media dims, the title is underlined): no lift, no
  // movement.
  link: {
    color: grasp.text,
    textDecorationLine: "none",
    cursor: "pointer",
  },
  // A drawing or picture at the card's top: on the linked card's hover or keyboard focus it dims to
  // 0.85 on the house curve; with reduced motion at once.
  media: {
    display: "block",
    overflow: "hidden",
    borderRadius: `calc(${grasp.corner} - ${grasp.space2})`,
    cornerShape: grasp.cornerShape,
    opacity: {
      default: 1,
      [stylex.when.ancestor(":hover", cardLinkMarker)]: {
        default: 1,
        [media.hover]: 0.85,
      },
      [stylex.when.ancestor(":focus-visible", cardLinkMarker)]: 0.85,
    },
    transitionProperty: "opacity",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
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
    textDecorationThickness: grasp.hairline,
  },
  description: {
    margin: 0,
    fontSize: grasp.textMd,
    lineHeight: grasp.textMdTightLine,
    letterSpacing: grasp.trackingUi,
    color: grasp.muted,
  },
});

export const Card = ({
  children,
  ground: groundDeprecated,
  variant: ground = groundDeprecated ?? "raised",
  padding = "md",
  element = "div",
  fill = false,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  style: styleProp,
  layout,
}: CardProps) => {
  const Element = element;
  return (
    <Element
      data-slot="card"
      data-fill={fill || undefined}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      {...stylex.props(
        styles.card,
        styles[ground],
        styles[padding],
        fill && styles.fill,
        layout ?? styleProp
      )}
    >
      {children}
    </Element>
  );
};

/** The card's title: a heading, so a screen reader can move from card to card. */
export const CardTitle = ({
  children,
  level: levelDeprecated,
  headingLevel: level = levelDeprecated ?? 3,
}: CardTitleProps) => {
  const Heading = `h${level}` as const;
  return (
    <Heading
      data-slot="card-title"
      {...stylex.props(styles.title, styles.titleLinked)}
    >
      {children}
    </Heading>
  );
};

/** One or two sentences under the title, in muted. */
export const CardDescription = ({ children }: CardDescriptionProps) => (
  <p data-slot="card-description" {...stylex.props(styles.description)}>
    {children}
  </p>
);

/** Every prop a CardLink takes. */
export type CardLinkProps = Pick<
  CardProps,
  "children" | "variant" | "padding" | "layout"
> & {
  /** Where it goes: the whole card is this one link. */
  href?: string;
  /** The link a router draws (`<Link to="…" />`): it takes the card's look and its children. */
  render?: RenderProp;
  /** Its name, when its title and words do not say where it goes. */
  "aria-label"?: string;
};

/**
 * A card that is one link: the whole card goes where `href` (or `render`'s link) goes, with the
 * card's focus ring. Hovered or focused by the keys, a CardMedia in it dims to 0.85 and its
 * CardTitle is underlined; nothing lifts or moves. Hold no other link or button in it.
 */
export const CardLink = ({
  children,
  href,
  render,
  variant = "raised",
  padding = "md",
  layout,
  "aria-label": ariaLabel,
}: CardLinkProps) =>
  renderElement(
    "a",
    {
      href,
      "data-slot": "card",
      "data-card-link": "",
      "aria-label": ariaLabel,
      className: stylex.props(
        cardLinkMarker,
        styles.card,
        styles[variant],
        styles[padding],
        styles.link,
        focus.ring,
        layout
      ).className,
      children,
    },
    render
  );

/** Every prop a CardMedia takes. */
export interface CardMediaProps {
  /** A drawing or a picture: an `<img alt="">` or an inline SVG, at the card's width. */
  children: ReactNode;
}

/** A drawing or picture at the top of a card; in a CardLink it dims on hover and focus. */
export const CardMedia = ({ children }: CardMediaProps) => (
  <span data-slot="card-media" {...stylex.props(styles.media)}>
    {children}
  </span>
);
