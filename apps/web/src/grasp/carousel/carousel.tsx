// Carousel: a set of slides shown a view at a time, from shadcn's (registry/bases/base/ui/
// carousel.tsx, on Embla), converted from Tailwind to StyleX and rebuilt on UI SDK's Carousel,
// which scrolls natively, so a swipe, a trackpad and the arrow keys all page through it. Palermo
// has no carousel; its look is Grasp's: Previous and Next are quiet Buttons with Hugeicons
// chevrons under the slides, and a row of small marks says which page you are on.
//
//   <Carousel label="Featured stories">
//     <Story … />
//     <Story … />
//   </Carousel>
//   <Carousel label="Team photos" slidesPerPage={3} loop>…</Carousel>
//
// It never turns on its own: a person decides when to move on. Every value is a token.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  Carousel as CarouselPrimitive,
  CarouselContent,
  CarouselIndicator,
  CarouselIndicatorGroup,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  CarouselViewport,
} from "@ui-sdk/react/carousel";
import type {
  CarouselIndicatorGroupState,
  CarouselIndicatorState,
} from "@ui-sdk/react/carousel";
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
  /** The slides, one child each, in order. */
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

/** The slides in order: nested arrays flattened; null, undefined and booleans dropped, as React renders nothing for them. */
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
  const slides = toSlides(children);
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
      {/* Its ring stands off the slides' own edges (the mark's offset), never on a card's border. */}
      <CarouselViewport {...stylex.props(styles.viewport, focus.mark)}>
        <CarouselContent {...stylex.props(styles.content)}>
          {slides.map((slide, index) => (
            <CarouselItem
              key={index}
              {...stylex.props(styles.item, basis[slidesPerPage])}
            >
              {slide}
            </CarouselItem>
          ))}
        </CarouselContent>
      </CarouselViewport>
      <div {...stylex.props(styles.controls)}>
        {indicators && (
          <CarouselIndicatorGroup
            aria-label={words.pages(label)}
            {...stylex.props(styles.dots)}
          >
            {(group: CarouselIndicatorGroupState) =>
              Array.from(
                {
                  length: pagesOf(
                    group.pageCount,
                    slides.length,
                    slidesPerPage
                  ),
                },
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
        <div {...stylex.props(styles.steps)}>
          <CarouselPrevious
            render={(props: Record<string, unknown>) => (
              <Button
                {...props}
                variant="quiet"
                size="sm"
                icon={ChevronLeft}
                aria-label={words.previous}
              />
            )}
          />
          <CarouselNext
            render={(props: Record<string, unknown>) => (
              <Button
                {...props}
                variant="quiet"
                size="sm"
                icon={ChevronRight}
                aria-label={words.next}
              />
            )}
          />
        </div>
      </div>
    </CarouselPrimitive>
  );
};
