// InlineCitation: a source in the sentence it supports,
// built on HoverCard, Button, Carousel and Link.
// The chip is a small secondary Button naming where the source lives ("example.com +2"); resting
// on it, or tabbing to it, opens a card with the source's title, a line about it and a link to it,
// and pages through several sources when there are more.
//
//   <InlineCitation>
//     <InlineCitationText>Streaming sends the page in pieces.</InlineCitationText>
//     <InlineCitationCard>
//       <InlineCitationCardTrigger sources={[source.url]} />
//       <InlineCitationCardBody>
//         <InlineCitationSource title={source.title} url={source.url} description={source.description} />
//       </InlineCitationCardBody>
//     </InlineCitationCard>
//   </InlineCitation>
//
// Sources is the list under an answer; this is the chip inside its text. Every address comes from
// a model or a tool: it is checked (`safeHref`), the host shown is read from the checked address,
// and a source whose address leads nowhere safe is shown as its words, not a link. A touch screen
// has no hover, and a screen reader may never open the card: give the same sources in Sources
// under the answer. Every value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import { createContext, isValidElement, use, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { citedSource, listOf } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { motionVars, ringInsetMarker } from "../lib/vars.stylex";
import { Button } from "./button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "./carousel";
import {
  HoverCard,
  HoverCardContent,
  HoverCardDescription,
  HoverCardTitle,
  HoverCardTrigger,
} from "./hover-card";
import type { HoverCardProps } from "./hover-card";
import { Link } from "./link";

/** Every prop an InlineCitation takes. */
export interface InlineCitationProps {
  /** Its InlineCitationText, then its InlineCitationCard. */
  children: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop an InlineCitationText takes. */
export interface InlineCitationTextProps {
  /** The words the source supports: lit while the pointer is on the citation or focus is in it. */
  children: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop an InlineCitationCard takes. */
export interface InlineCitationCardProps {
  /** Its InlineCitationCardTrigger, then its InlineCitationCardBody. */
  children: ReactNode;
  /** Open now. Pass it with `onOpenChange` to open and close it yourself. */
  open?: boolean;
  /**
   * Open when the page loads.
   * @default false
   */
  defaultOpen?: boolean;
  /** Runs when the card wants to open or close. */
  onOpenChange?: HoverCardProps["onOpenChange"];
  /**
   * How long the pointer rests on the chip, or focus stays on it, before the card opens, in
   * milliseconds: the chip is a control, so the card answers at once.
   * @default 10
   */
  openDelay?: number;
  /**
   * How long the card stays once the pointer leaves the chip and the card, in milliseconds.
   * @default 100
   */
  closeDelay?: number;
}

/** Every prop an InlineCitationCardTrigger takes. */
export interface InlineCitationCardTriggerProps {
  /**
   * The addresses of the sources it cites, in order: the chip shows the first one's host, and how
   * many more ("example.com +2"). An address that leads nowhere safe shows as "Source".
   */
  sources: string[];
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop an InlineCitationCardBody takes. */
export interface InlineCitationCardBodyProps {
  /** One InlineCitationSource, or an InlineCitationCarousel of several. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop an InlineCitationCarousel takes. */
export interface InlineCitationCarouselProps {
  /** Its InlineCitationCarouselHeader, then its InlineCitationCarouselContent. */
  children: ReactNode;
  /**
   * What the slides are, for a screen reader.
   * @default "Sources"
   */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop an InlineCitationCarouselContent takes. */
export interface InlineCitationCarouselContentProps {
  /** Its InlineCitationCarouselItems, one per source, in order. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop an InlineCitationCarouselItem takes. */
export interface InlineCitationCarouselItemProps {
  /** The slide: an InlineCitationSource, and an InlineCitationQuote from it if one helps. */
  children: ReactNode;
  /** Its name, when "2 of 3" says too little. */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop an InlineCitationCarouselHeader takes. */
export interface InlineCitationCarouselHeaderProps {
  /** InlineCitationCarouselPrev, InlineCitationCarouselNext and InlineCitationCarouselIndex. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop an InlineCitationCarouselIndex takes. */
export interface InlineCitationCarouselIndexProps {
  /** What it shows in place of which source of how many ("1/3"). */
  children?: ReactNode;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop an InlineCitationCarouselPrev takes. */
export interface InlineCitationCarouselPrevProps {
  /**
   * Its name, for a screen reader.
   * @default "Previous"
   */
  "aria-label"?: string;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop an InlineCitationCarouselNext takes. */
export interface InlineCitationCarouselNextProps {
  /**
   * Its name, for a screen reader.
   * @default "Next"
   */
  "aria-label"?: string;
  /** Where it sits. */
  style?: LayoutStyle;
}

/** Every prop an InlineCitationSource takes. */
export interface InlineCitationSourceProps {
  /** Its title, as the source calls itself ("Linking and navigating"). */
  title?: string;
  /**
   * Where it lives: an http, https or mailto address, linked by its host in a new tab. Any other
   * (`javascript:`, `data:`, a path) is shown as its words, not a link.
   */
  url?: string;
  /** A line or two about it. */
  description?: string;
  /** More after it: an InlineCitationQuote. */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop an InlineCitationQuote takes. */
export interface InlineCitationQuoteProps {
  /** The words quoted from the source. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

const HOVER = media.hover;

// How far a link's focus ring reaches past its words (focusRingText).
const RING = `calc(${size.ringOffsetText} - 1px + ${size.ringWidth})`;

const styles = stylex.create({
  citation: { display: "inline" },
  // The chip stands in a line of words: it gives back what it is taller than its own words' line,
  // so a line that holds one stands as far from its neighbours as any other.
  chip: {
    display: "inline-flex",
    marginBlock: `calc((1lh - ${size.controlXs}) / 2)`,
  },
  // Lit while the pointer is on the citation, or focus is on its chip.
  text: {
    borderRadius: radius.xs,
    backgroundColor: {
      default: "transparent",
      [stylex.when.ancestor(":focus-within")]: colors.accent,
      [HOVER]: {
        default: "transparent",
        [stylex.when.ancestor(":hover")]: colors.accent,
        [stylex.when.ancestor(":focus-within")]: colors.accent,
      },
    },
    transitionProperty: "background-color",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
  },
  // The empty row Carousel keeps under the slides (its marks are off, its buttons in the header)
  // is taken back, so the card ends at the slide.
  // It reaches RING past the card's column at each side, and its header and its slides stand RING
  // in: the slides' window clips at its edge, and a link at a slide's start keeps its whole ring.
  carousel: {
    display: "grid",
    marginBlockEnd: `calc(-1 * ${space["4"]})`,
    marginInline: `calc(-1 * ${RING})`,
  },
  inCarousel: { paddingInline: RING },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["2"],
    minWidth: 0,
  },
  index: {
    flexGrow: 1,
    textAlign: "end",
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
  },
  // A slide, or a source alone: its lines one under the other.
  stack: {
    display: "grid",
    rowGap: space["2"],
    minWidth: 0,
  },
  source: {
    display: "grid",
    rowGap: space["1"],
    minWidth: 0,
  },
  quote: {
    margin: 0,
    paddingInlineStart: space["3"],
    borderInlineStartWidth: size.codeBlockBarWidth,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: colors.border,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontStyle: "italic",
    color: colors.mutedForeground,
  },
});

/** A citation: the words it supports and the chip after them. */
export const InlineCitation = ({ children, style }: InlineCitationProps) => (
  <span
    data-slot="inline-citation"
    {...stylex.props(styles.citation, stylex.defaultMarker(), style)}
  >
    {children}
  </span>
);

/** The words the source supports, lit while the citation is pointed at or focused. */
export const InlineCitationText = ({
  children,
  style,
}: InlineCitationTextProps) => (
  <span data-slot="inline-citation-text" {...stylex.props(styles.text, style)}>
    {children}
  </span>
);

/** The root of the chip and its card: renders nothing of its own. */
export const InlineCitationCard = ({
  children,
  openDelay = 10,
  closeDelay = 100,
  ...card
}: InlineCitationCardProps) => (
  <HoverCard {...card} openDelay={openDelay} closeDelay={closeDelay}>
    {children}
  </HoverCard>
);

/** The chip: a small secondary Button with the first source's host, and how many more. */
export const InlineCitationCardTrigger = ({
  sources,
  style,
}: InlineCitationCardTriggerProps) => {
  const words = useI18n().inlineCitation;
  const first = citedSource(sources[0]);
  return (
    <span {...stylex.props(styles.chip, ringInsetMarker, style)}>
      <HoverCardTrigger variant="default" asChild>
        <Button variant="secondary" size="xs">
          {words.trigger(
            first?.host ?? words.unknown,
            Math.max(0, sources.length - 1)
          )}
        </Button>
      </HoverCardTrigger>
    </span>
  );
};

/** The card: one source, or a carousel of several. */
export const InlineCitationCardBody = ({
  children,
  style,
}: InlineCitationCardBodyProps) => (
  <HoverCardContent style={style}>{children}</HoverCardContent>
);

// Which source the carousel shows, from 1, and how many there are: its index reads them.
const PlaceContext = createContext({ page: 1, count: 0 });

const isPart = <Props,>(
  child: ReactNode,
  part: unknown
): child is ReactElement<Props> => isValidElement(child) && child.type === part;

/** One source's slide: its lines one under the other. */
export const InlineCitationCarouselItem = ({
  children,
  style,
}: InlineCitationCarouselItemProps) => (
  <div
    data-slot="inline-citation-carousel-item"
    {...stylex.props(styles.stack, styles.inCarousel, style)}
  >
    {children}
  </div>
);

/** The slides: one CarouselItem for each InlineCitationCarouselItem. */
export const InlineCitationCarouselContent = ({
  children,
  style,
}: InlineCitationCarouselContentProps) => {
  const words = useI18n().carousel;
  const items = listOf(children).filter((child) =>
    isPart<InlineCitationCarouselItemProps>(child, InlineCitationCarouselItem)
  );
  return (
    <CarouselContent style={style}>
      {items.map((item, index) => (
        <CarouselItem
          key={item.key ?? index}
          aria-label={
            item.props["aria-label"] ??
            words.slideLabel(index + 1, items.length)
          }
        >
          {item}
        </CarouselItem>
      ))}
    </CarouselContent>
  );
};

/** A carousel's slides: the items of its InlineCitationCarouselContent. */
const itemsOf = (children: ReactNode) =>
  listOf(children)
    .filter((child) =>
      isPart<InlineCitationCarouselContentProps>(
        child,
        InlineCitationCarouselContent
      )
    )
    .flatMap((content) => listOf(content.props.children))
    .filter((child) => isPart(child, InlineCitationCarouselItem));

/** Several sources, one at a time: Carousel, its place said in the header. */
export const InlineCitationCarousel = ({
  children,
  "aria-label": label,
  style,
}: InlineCitationCarouselProps) => {
  const words = useI18n().inlineCitation;
  const [page, setPage] = useState(1);
  const count = itemsOf(children).length;
  return (
    <div {...stylex.props(styles.carousel)}>
      <Carousel
        aria-label={label ?? words.sources}
        page={page}
        onPageChange={setPage}
        showIndicators={false}
        style={style}
      >
        {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled */}
        <PlaceContext value={{ page, count }}>{children}</PlaceContext>
      </Carousel>
    </div>
  );
};

/** The row over the slides: previous, next, and which source of how many. */
export const InlineCitationCarouselHeader = ({
  children,
  style,
}: InlineCitationCarouselHeaderProps) => (
  <div
    data-slot="inline-citation-carousel-header"
    {...stylex.props(styles.header, styles.inCarousel, style)}
  >
    {children}
  </div>
);

/** Which source of how many ("1/3"). */
export const InlineCitationCarouselIndex = ({
  children,
  style,
}: InlineCitationCarouselIndexProps) => {
  const { page, count } = use(PlaceContext);
  const words = useI18n().inlineCitation;
  return (
    <span
      data-slot="inline-citation-carousel-index"
      {...stylex.props(styles.index, style)}
    >
      {children ?? words.index(page, count)}
    </span>
  );
};

/** The button to the source before: Carousel's own. */
export const InlineCitationCarouselPrev = (
  props: InlineCitationCarouselPrevProps
) => <CarouselPrevious {...props} />;

/** The button to the next source: Carousel's own. */
export const InlineCitationCarouselNext = (
  props: InlineCitationCarouselNextProps
) => <CarouselNext {...props} />;

/** One source: its title, a line about it, and a link to it by its host, in a new tab. */
export const InlineCitationSource = ({
  title,
  url,
  description,
  children,
  style,
}: InlineCitationSourceProps) => {
  const cited = citedSource(url);
  return (
    <div
      data-slot="inline-citation-source"
      {...stylex.props(styles.source, style)}
    >
      {title === undefined || title === "" ? null : (
        <HoverCardTitle>{title}</HoverCardTitle>
      )}
      {description === undefined || description === "" ? null : (
        <HoverCardDescription>{description}</HoverCardDescription>
      )}
      {url === undefined || url === "" ? null : (
        <HoverCardDescription variant="muted">
          {cited === null ? (
            url
          ) : (
            <Link href={cited.href} external>
              {cited.host}
            </Link>
          )}
        </HoverCardDescription>
      )}
      {children}
    </div>
  );
};

/** Words quoted from the source, set off by a bar at the start. */
export const InlineCitationQuote = ({
  children,
  style,
}: InlineCitationQuoteProps) => (
  <blockquote
    data-slot="inline-citation-quote"
    {...stylex.props(styles.quote, style)}
  >
    {children}
  </blockquote>
);
