// Carousel: a set of slides shown a view at a time, in StyleX on UI SDK's Carousel, which scrolls
// natively, so a swipe, a trackpad and the arrow keys all page through it. Previous and Next are
// outline Buttons with chevrons under the slides, and a row of small marks says which page you are
// on.
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
// Previous and Next stand under the slides at the end of the row, after the marks
// (`showIndicators`), wherever they are written. It never turns on its own: a person decides when
// to move on. With reduced motion a page change is immediate.
"use client";

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
import { createContext, isValidElement, use } from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  Icon,
} from "../lib/icons";
import { focusRing, focusRingOffset } from "../lib/styles";
import {
  colors,
  duration,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { className, listOf } from "../lib/utils";
import type { LayoutStyle, Orientation } from "../lib/utils";
import { motionVars, ringInsetMarker } from "../lib/vars.stylex";
import { Button } from "./button";

/** Every prop a Carousel takes. */
export interface CarouselProps {
  /** Its CarouselContent, then CarouselPrevious and CarouselNext. */
  children: ReactNode;
  /** What the slides are, said to a screen reader and an agent ("Featured stories"). */
  "aria-label"?: string;
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
  /** The page shown, from 1, when the page holds it; with `onPageChange`. */
  page?: number;
  /**
   * The page it starts on, from 1, when it holds its own page.
   * @default 1
   */
  defaultPage?: number;
  /** Called with the page, from 1, when a person or a part moves it to another. */
  onPageChange?: (page: number) => void;
  /**
   * The row of marks, one per page, that says where you are and jumps to a page.
   * @default true
   */
  showIndicators?: boolean;
  /**
   * Which way the slides run, and which arrow keys page them. Running down, give the content a height.
   * @default "horizontal"
   */
  orientation?: Orientation;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop a CarouselContent takes. */
export interface CarouselContentProps {
  /** Its CarouselItems, one per slide, in order. */
  children: ReactNode;
  /** Layout only: its height, when the slides run down. */
  style?: LayoutStyle;
}

/** Every prop a CarouselItem takes. */
export interface CarouselItemProps {
  /** The slide. */
  children: ReactNode;
  /** Its name, when "2 of 5" says too little ("Studio A"). */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a CarouselPrevious takes. */
export interface CarouselPreviousProps {
  /** Its name, for this one carousel, when "Previous" says too little. */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a CarouselNext takes. */
export interface CarouselNextProps {
  /** Its name, for this one carousel, when "Next" says too little. */
  "aria-label"?: string;
  /** Layout only. */
  style?: LayoutStyle;
}

const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
const SELECTED = ":is([data-selected])";

const styles = stylex.create({
  carousel: {
    display: "grid",
    gap: space["4"],
    width: "100%",
    minWidth: 0,
  },
  viewport: {
    overflow: "hidden",
    // UI SDK makes it scroll natively; the marks and buttons say where it is, not a scrollbar.
    scrollbarWidth: "none",
    // The slides' room for the focus ring, which follows the viewport's corner.
    borderRadius: radius.xl,
    cornerShape: radius.shape,
  },
  content: {
    display: "flex",
    gap: space.carouselGap,
  },
  // Running down, the viewport holds the height given to the content.
  contentDown: {
    flexDirection: "column",
    height: "100%",
  },
  item: {
    flexShrink: 0,
    minWidth: 0,
    minHeight: 0,
    boxSizing: "border-box",
  },
  // A slide's width (or height, running down): the view, less the gaps between the slides it holds,
  // shared out.
  one: { flexBasis: "100%" },
  two: { flexBasis: `calc((100% - ${space.carouselGap}) / 2)` },
  three: { flexBasis: `calc((100% - 2 * ${space.carouselGap}) / 3)` },
  four: { flexBasis: `calc((100% - 3 * ${space.carouselGap}) / 4)` },
  auto: { flexBasis: "auto" },
  controls: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
    // Each control's touch target reaches the middle of the gap to the next (tapTarget).
    "--tap-room-inline": `calc(${space["3"]} / 2)`,
    minWidth: 0,
  },
  steps: {
    display: "flex",
    gap: space["2"],
    marginInlineStart: "auto",
    "--tap-room-inline": `calc(${space["2"]} / 2)`,
  },
  dots: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    minWidth: 0,
  },
  // A page's mark: a small pill, wider and in ink for the current page, in a square a pointer can
  // press (44px on a touch screen). The current page's target is as much wider as its pill, so every
  // mark stands the same distance from the next, and its ring is a pill round a pill.
  dot: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: {
      default: size.carouselDotTarget,
      [SELECTED]: `calc(${size.carouselDotTarget} + ${size.carouselDotActive} - ${size.carouselDot})`,
      [COARSE]: {
        default: size.tapTarget,
        [SELECTED]: `calc(${size.tapTarget} + ${size.carouselDotActive} - ${size.carouselDot})`,
      },
    },
    transitionProperty: "width",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
    height: { default: size.carouselDotTarget, [COARSE]: size.tapTarget },
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.full,
    backgroundColor: "transparent",
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  mark: {
    display: "block",
    width: size.carouselDot,
    height: size.carouselDot,
    borderRadius: radius.full,
    backgroundColor: { default: colors.carouselDotBg, [FORCED]: "GrayText" },
    transitionProperty: "width, background-color",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  markActive: {
    width: size.carouselDotActive,
    backgroundColor: {
      default: colors.carouselDotBgActive,
      [FORCED]: "CanvasText",
    },
  },
});

const basis = {
  1: styles.one,
  2: styles.two,
  3: styles.three,
  4: styles.four,
  auto: styles.auto,
} as const;

const isPart = (child: ReactNode, part: unknown) =>
  isValidElement(child) && child.type === part;

/**
 * How many marks: one per page, never one per slide. The pages as the carousel measures them, and
 * before it has (the server's render), as many as the slides make a view at a time; with "auto"
 * widths, one per slide until then.
 */
const pagesOf = (
  measured: number | null,
  slides: number,
  perPage: NonNullable<CarouselProps["slidesPerPage"]>
) =>
  measured ??
  (typeof perPage === "number"
    ? Math.max(1, Math.ceil(slides / perPage))
    : slides);

// What the parts read from the root: a slide's share of the view, which way the slides run, and
// how many slides there are.
interface Shape {
  perPage: NonNullable<CarouselProps["slidesPerPage"]>;
  orientation: Orientation;
  slides: number;
}
const ShapeContext = createContext<Shape>({
  perPage: 1,
  orientation: "horizontal",
  slides: 0,
});
// A slide's place among the slides, from 0, for its name ("2 of 5").
const SlideIndex = createContext(0);

/** One slide, as wide (or tall) as a view holds slides (`slidesPerPage`). */
export const CarouselItem = ({
  children,
  "aria-label": label,
  style,
}: CarouselItemProps) => {
  const { perPage, slides } = use(ShapeContext);
  const words = useI18n().carousel;
  const index = use(SlideIndex);
  return (
    <ItemPrimitive
      // Given from the first render, so UI SDK leaves the name to us.
      aria-label={label ?? words.slideLabel(index + 1, slides)}
      // UI SDK's own role description is English and wins over a prop: set it last.
      render={(props: Record<string, unknown>) => (
        <div {...props} aria-roledescription={words.slide} />
      )}
      {...stylex.props(styles.item, basis[perPage], style)}
    >
      {children}
    </ItemPrimitive>
  );
};

/** The slides' window and their row: its CarouselItems, one per slide. */
export const CarouselContent = ({ children, style }: CarouselContentProps) => {
  const { orientation } = use(ShapeContext);
  return (
    // Its ring stands off the slides' own edges, never on a card's border.
    <CarouselViewport
      {...stylex.props(styles.viewport, focusRingOffset, style)}
    >
      <ContentPrimitive
        {...stylex.props(
          styles.content,
          orientation === "vertical" && styles.contentDown
        )}
      >
        {listOf(children)
          .filter((child) => isPart(child, CarouselItem))
          .map((child, index) => (
            <SlideIndex
              key={
                isValidElement(child) && child.key !== null ? child.key : index
              }
              value={index}
            >
              {child}
            </SlideIndex>
          ))}
      </ContentPrimitive>
    </CarouselViewport>
  );
};

/** The button that goes back a page: an outline Button with a chevron, under the slides. */
export const CarouselPrevious = ({
  "aria-label": label,
  style,
}: CarouselPreviousProps) => {
  const { orientation } = use(ShapeContext);
  const words = useI18n().carousel;
  return (
    <PreviousPrimitive
      render={
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={label ?? words.previous}
          style={style}
        >
          <Icon
            icon={orientation === "vertical" ? ChevronUpIcon : ChevronLeftIcon}
          />
        </Button>
      }
    />
  );
};

/** The button that goes on a page: an outline Button with a chevron, under the slides. */
export const CarouselNext = ({
  "aria-label": label,
  style,
}: CarouselNextProps) => {
  const { orientation } = use(ShapeContext);
  const words = useI18n().carousel;
  return (
    <NextPrimitive
      render={
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={label ?? words.next}
          style={style}
        >
          <Icon
            icon={
              orientation === "vertical" ? ChevronDownIcon : ChevronRightIcon
            }
          />
        </Button>
      }
    />
  );
};

const isStep = (child: ReactNode) =>
  isPart(child, CarouselPrevious) || isPart(child, CarouselNext);

/** The slides written in the CarouselContents among `children`: one per CarouselItem. */
const countSlides = (children: ReactNode[]) =>
  children
    .filter((child) => isPart(child, CarouselContent))
    .flatMap((child) =>
      listOf(
        isValidElement<CarouselContentProps>(child)
          ? child.props.children
          : null
      )
    )
    .filter((child) => isPart(child, CarouselItem)).length;

/** A set of slides shown a view at a time, with Previous, Next and a mark per page. */
export const Carousel = ({
  children,
  "aria-label": label = "",
  slidesPerPage = 1,
  loop = false,
  page,
  defaultPage,
  onPageChange,
  showIndicators = true,
  orientation = "horizontal",
  style,
}: CarouselProps) => {
  const words = useI18n().carousel;
  const parts = listOf(children);
  const slides = countSlides(parts);
  return (
    <CarouselPrimitive
      aria-label={label}
      // UI SDK's own role description is English and wins over a prop: set it last.
      render={(props: Record<string, unknown>) => (
        <div {...props} aria-roledescription={words.carousel} />
      )}
      slidesPerPage={slidesPerPage}
      loop={loop}
      page={page}
      defaultPage={defaultPage}
      onPageChange={onPageChange}
      orientation={orientation}
      {...stylex.props(styles.carousel, style)}
    >
      {/* oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled */}
      <ShapeContext value={{ perPage: slidesPerPage, orientation, slides }}>
        {parts.filter((child) => !isStep(child))}
        <div {...stylex.props(styles.controls)}>
          {showIndicators && (
            <CarouselIndicatorGroup
              aria-label={words.pages(label)}
              // The marks' targets touch: each ring is drawn inside its own (ringInsetMarker).
              {...stylex.props(styles.dots, ringInsetMarker)}
            >
              {(group: CarouselIndicatorGroupState) =>
                Array.from(
                  { length: pagesOf(group.pageCount, slides, slidesPerPage) },
                  (_, index) => (
                    <CarouselIndicator
                      key={index}
                      page={index + 1}
                      aria-label={words.page(index + 1)}
                      className={className(styles.dot, focusRing) ?? ""}
                    >
                      {(state: CarouselIndicatorState) => (
                        <span
                          aria-hidden="true"
                          {...stylex.props(
                            styles.mark,
                            state.selected && styles.markActive
                          )}
                        />
                      )}
                    </CarouselIndicator>
                  )
                )
              }
            </CarouselIndicatorGroup>
          )}
          <div {...stylex.props(styles.steps)}>{parts.filter(isStep)}</div>
        </div>
      </ShapeContext>
    </CarouselPrimitive>
  );
};
