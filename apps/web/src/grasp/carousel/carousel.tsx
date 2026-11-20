// Carousel: a set of slides shown a view at a time, from shadcn's (registry/bases/base/ui/
// carousel.tsx, on Embla), converted from Tailwind to StyleX and rebuilt on UI SDK's Carousel,
// which scrolls natively, so a swipe, a trackpad and the arrow keys all page through it. Palermo
// has no carousel; its look is Grasp's: Previous and Next are quiet Buttons with Hugeicons
// chevrons under the slides, and a row of small marks says which page you are on.
//
// Since release step 6 its slides and buttons are parts, as in shadcn's:
//
//   <Carousel aria-label="Featured stories">
//     <CarouselContent>
//       <CarouselItem><Story … /></CarouselItem>
//       <CarouselItem><Story … /></CarouselItem>
//     </CarouselContent>
//     <CarouselPrevious />
//     <CarouselNext />
//   </Carousel>
//
// Previous and Next stand under the slides at the end of the row, after the marks (`indicators`),
// wherever they are written. The older shape, each child a slide, keeps working until step 9:
//
//   <Carousel aria-label="Team photos" slidesPerPage={3} loop>…</Carousel>
//
// It never turns on its own: a person decides when to move on. Every value is a token.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  Carousel as CarouselPrimitive,
  CarouselContent as ContentPrimitive,
  CarouselIndicator,
  CarouselIndicatorGroup,
  CarouselItem as ItemPrimitive,
  CarouselNext as NextPrimitive,
  CarouselPrevious as PreviousPrimitive,
  CarouselViewport,
} from "@ui-sdk/react/carousel";
import type {
  CarouselIndicatorGroupState,
  CarouselIndicatorState,
} from "@ui-sdk/react/carousel";
import { createContext, isValidElement, useContext } from "react";
import type { ReactNode } from "react";

import { Button } from "../button";
import { focus } from "../focus/focus";
import { ChevronLeft, ChevronRight } from "../icons";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { carouselWords } from "./words";

/** What a caller may style: where the carousel sits and how wide it is. Never its look. */
export type CarouselLayoutStyle = LayoutStyle;

/** Every prop a Carousel takes. */
export interface CarouselProps {
  /**
   * Its CarouselContent, then CarouselPrevious and CarouselNext. In the older shape (until release
   * step 9) each child is a slide: write each in a CarouselItem, in a CarouselContent, instead.
   */
  children: ReactNode;
  /** What the slides are, said to a screen reader and an agent ("Featured stories"). */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /**
   * How many slides one view holds: Next moves this many. `auto` fits as many as there is room for.
   * @default 1
   */
  slidesPerPage?: 1 | 2 | 3 | 4 | "auto";
  /**
   * Goes round: Next on the last page comes back to the first.
   * @default false
   */
  loop?: boolean;
  /**
   * The row of marks, one per page, that says where you are and jumps to a page.
   * @default true
   */
  indicators?: boolean;
  /** The page it starts on, from 1. @default 1 */
  defaultPage?: number;
  /** Called with the page, from 1, once the slides come to rest on it. */
  onPageChange?: (page: number) => void;
  /**
   * What it says to a screen reader: its two buttons, the row of marks, from the carousel's label,
   * and each mark.
   * @default { previous: "Previous", next: "Next", pages: (label) => `Pages of ${label}`, page: (page) => `Page ${page}` }
   */
  labels?: Partial<CarouselLabels>;
  /** @deprecated Use `layout`. */
  style?: CarouselLayoutStyle;
  /** Layout only: margins, alignment and width. */
  layout?: CarouselLayoutStyle;
}

/** Every prop a CarouselContent or CarouselItem takes. */
export interface CarouselPartProps {
  /** A CarouselContent's CarouselItems, one per slide, in order; or a CarouselItem's slide. */
  children: ReactNode;
}

/** Every prop a CarouselPrevious or CarouselNext takes. */
export interface CarouselButtonProps {
  /** Its name, for this one carousel. The words the product gives (GraspWords) otherwise: "Previous", "Next". */
  "aria-label"?: string;
}

/** The words a Carousel says, so the product can say them in its own language. */
export interface CarouselLabels {
  /** The button that goes back a page. */
  previous: string;
  /** The button that goes on a page. */
  next: string;
  /** The row's name, from the carousel's `label`. */
  pages: (label: string) => string;
  /** One mark's name, from its page (from 1). */
  page: (page: number) => string;
}

const COARSE = media.coarse;
const FORCED = media.forced;

const styles = stylex.create({
  carousel: {
    display: "grid",
    gap: grasp.space4,
    width: "100%",
    minWidth: 0,
  },
  viewport: {
    overflow: "hidden",
    // UI SDK makes it scroll natively; the marks and buttons say where it is, not a scrollbar.
    scrollbarWidth: "none",
    // The slides' room for the focus ring, which follows the viewport's corner.
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
  },
  content: {
    display: "flex",
    gap: grasp.carouselGap,
  },
  item: {
    flexShrink: 0,
    minWidth: 0,
    boxSizing: "border-box",
  },
  // A slide's width: the view, less the gaps between the slides it holds, shared out.
  one: { flexBasis: "100%" },
  two: { flexBasis: `calc((100% - ${grasp.carouselGap}) / 2)` },
  three: { flexBasis: `calc((100% - 2 * ${grasp.carouselGap}) / 3)` },
  four: { flexBasis: `calc((100% - 3 * ${grasp.carouselGap}) / 4)` },
  auto: { flexBasis: "auto" },
  controls: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space3,
    minWidth: 0,
  },
  steps: { display: "flex", gap: grasp.space2, marginInlineStart: "auto" },
  dots: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    minWidth: 0,
  },
  // A page's mark: a small pill, wider and in ink for the current page, in a square a pointer
  // can press (44px on a touch screen). The current page's target is as much wider as its pill, so
  // every mark stands the same distance from the next, and its ring is a pill round a pill.
  dot: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: {
      default: grasp.carouselDotTarget,
      ":is([data-selected])": `calc(${grasp.carouselDotTarget} + ${grasp.carouselDotCurrent} - ${grasp.carouselDot})`,
      [COARSE]: {
        default: grasp.tap,
        ":is([data-selected])": `calc(${grasp.tap} + ${grasp.carouselDotCurrent} - ${grasp.carouselDot})`,
      },
    },
    transitionProperty: "width",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
    height: { default: grasp.carouselDotTarget, [COARSE]: grasp.tap },
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerPill,
    backgroundColor: "transparent",
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  mark: {
    display: "block",
    width: grasp.carouselDot,
    height: grasp.carouselDot,
    borderRadius: grasp.cornerPill,
    backgroundColor: { default: grasp.carouselDotFill, [FORCED]: "GrayText" },
    transitionProperty: "width, background-color",
    transitionDuration: simply.ui,
    transitionTimingFunction: grasp.ease,
  },
  markCurrent: {
    width: grasp.carouselDotCurrent,
    backgroundColor: {
      default: grasp.carouselDotFillCurrent,
      [FORCED]: "CanvasText",
    },
  },
});

/** Children in order: nested arrays flattened; null, undefined and booleans dropped, as React renders nothing for them. */
const toSlides = (node: ReactNode): ReactNode[] => {
  if (Array.isArray(node)) {
    return node.flatMap((item: ReactNode) => toSlides(item));
  }
  if (node === null || node === undefined || typeof node === "boolean") {
    return [];
  }
  return [node];
};

const basis = {
  1: styles.one,
  2: styles.two,
  3: styles.three,
  4: styles.four,
  auto: styles.auto,
} as const;

/**
 * How many marks: one per page, never one per slide. The pages as the carousel measures them, and
 * before it has (the server's render), as many as the slides make a view at a time; with "auto"
 * widths, one per slide until then.
 */
const pagesOf = (
  measured: number | null,
  slides: number,
  perPage: CarouselProps["slidesPerPage"]
) =>
  measured ??
  (typeof perPage === "number"
    ? Math.max(1, Math.ceil(slides / perPage))
    : slides);

// What the parts read from the root: a slide's width, and the buttons' words.
const PerPage = createContext<NonNullable<CarouselProps["slidesPerPage"]>>(1);
const Words = createContext<CarouselLabels>(carouselWords);

// ---- The parts (release step 6) --------------------------------------------------------------------

/** The slides' window and their row: its CarouselItems, one per slide. */
export const CarouselContent = ({ children }: CarouselPartProps) => (
  // Its ring stands off the slides' own edges (the mark's offset), never on a card's border.
  <CarouselViewport {...stylex.props(styles.viewport, focus.mark)}>
    <ContentPrimitive {...stylex.props(styles.content)}>
      {children}
    </ContentPrimitive>
  </CarouselViewport>
);

/** One slide, as wide as a view holds slides (`slidesPerPage`). */
export const CarouselItem = ({ children }: CarouselPartProps) => {
  const perPage = useContext(PerPage);
  return (
    <ItemPrimitive {...stylex.props(styles.item, basis[perPage])}>
      {children}
    </ItemPrimitive>
  );
};

/** The button that goes back a page: a quiet Button with a chevron, under the slides. */
export const CarouselPrevious = ({
  "aria-label": label,
}: CarouselButtonProps) => {
  const words = useContext(Words);
  return (
    <PreviousPrimitive
      render={(props: Record<string, unknown>) => (
        <Button
          {...props}
          variant="quiet"
          size="sm"
          icon={ChevronLeft}
          aria-label={label ?? words.previous}
        />
      )}
    />
  );
};

/** The button that goes on a page: a quiet Button with a chevron, under the slides. */
export const CarouselNext = ({ "aria-label": label }: CarouselButtonProps) => {
  const words = useContext(Words);
  return (
    <NextPrimitive
      render={(props: Record<string, unknown>) => (
        <Button
          {...props}
          variant="quiet"
          size="sm"
          icon={ChevronRight}
          aria-label={label ?? words.next}
        />
      )}
    />
  );
};

const isPart = (child: ReactNode, part: unknown) =>
  isValidElement(child) && child.type === part;
const isButton = (child: ReactNode) =>
  isPart(child, CarouselPrevious) || isPart(child, CarouselNext);

/** The slides written in the CarouselContents among `children`: one per CarouselItem. */
const countSlides = (children: ReactNode[]) =>
  children
    .filter((child) => isPart(child, CarouselContent))
    .flatMap((child) =>
      toSlides(
        isValidElement<CarouselPartProps>(child) ? child.props.children : null
      )
    )
    .filter((child) => isPart(child, CarouselItem)).length;

/** The older shape's children, each a slide, as the parts (until release step 9). */
const asParts = (slides: ReactNode[]) => [
  <CarouselContent key="content">
    {slides.map((slide, index) => (
      <CarouselItem key={index}>{slide}</CarouselItem>
    ))}
  </CarouselContent>,
  <CarouselPrevious key="previous" />,
  <CarouselNext key="next" />,
];

/** A set of slides shown a view at a time, with Previous, Next and a mark per page. */
export const Carousel = ({
  children,
  label: labelDeprecated,
  "aria-label": label = labelDeprecated ?? "",
  slidesPerPage = 1,
  loop = false,
  indicators = true,
  defaultPage,
  onPageChange,
  labels: given,
  style: styleProp,
  layout,
}: CarouselProps) => {
  const written = toSlides(children);
  const parts = written.some((child) => isPart(child, CarouselContent))
    ? written
    : asParts(written);
  const slides = parts === written ? countSlides(written) : written.length;
  const words = withGiven(useWords("carousel", carouselWords), given ?? {});
  return (
    <CarouselPrimitive
      aria-label={label}
      slidesPerPage={slidesPerPage}
      loop={loop}
      defaultPage={defaultPage}
      onPageChangeComplete={onPageChange}
      {...stylex.props(styles.carousel, layout ?? styleProp)}
    >
      <PerPage value={slidesPerPage}>
        <Words value={words}>
          {parts.filter((child) => !isButton(child))}
          <div {...stylex.props(styles.controls)}>
            {indicators && (
              <CarouselIndicatorGroup
                aria-label={words.pages(label)}
                {...stylex.props(styles.dots)}
              >
                {(group: CarouselIndicatorGroupState) =>
                  Array.from(
                    { length: pagesOf(group.pageCount, slides, slidesPerPage) },
                    (_, index) => (
                      <CarouselIndicator
                        key={index}
                        page={index + 1}
                        aria-label={words.page(index + 1)}
                        className={
                          stylex.props(styles.dot, focus.ring).className ?? ""
                        }
                      >
                        {(state: CarouselIndicatorState) => (
                          <span
                            aria-hidden="true"
                            {...stylex.props(
                              styles.mark,
                              state.selected && styles.markCurrent
                            )}
                          />
                        )}
                      </CarouselIndicator>
                    )
                  )
                }
              </CarouselIndicatorGroup>
            )}
            <div {...stylex.props(styles.steps)}>{parts.filter(isButton)}</div>
          </div>
        </Words>
      </PerPage>
    </CarouselPrimitive>
  );
};
