// Pagination: the way through a long list, page by page, and where in it you are,
// in StyleX, built on UI SDK's
// Pagination: two small outlined steps, with the range shown ("Showing 21 – 30 of 100 items"), the
// page ("2 / 10"), numbered page links, or nothing beside them.
// Adapted from shadcn/ui (MIT), see THIRD_PARTY_NOTICES.md.
//
//   <Pagination total={100} pageSize={10} page={page} onPageChange={setPage} aria-label="Projects">
//     <PaginationRange />
//     <PaginationContent>
//       <PaginationItem><PaginationPrevious /></PaginationItem>
//       <PaginationItem><PaginationNext /></PaginationItem>
//     </PaginationContent>
//   </Pagination>
//
// PaginationPage ("2 / 10") stands between the steps in place of the range; PaginationContent's
// children may be a function of the pages to show, for a PaginationLink per page and a
// PaginationEllipsis for each gap. With `getPageUrl` the steps and links are links, which work
// before the script loads; with `asChild` they are the router's own link.
//
// A step at its end says it is disabled and stays focusable. While the next page loads, both steps
// do nothing and a spinner turns in the pressed step, in place of its chevron, so loading never
// looks like the end of the list and the row keeps its width.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ChangeDetails } from "@ui-sdk/core";
import {
  PaginationEllipsis as EllipsisPrimitive,
  PaginationItem as ItemPrimitive,
  PaginationLink as LinkPrimitive,
  PaginationList,
  PaginationNext as NextPrimitive,
  Pagination as PaginationPrimitive,
  PaginationPrevious as PreviousPrimitive,
} from "@ui-sdk/react/pagination";
import type {
  PaginationLinkState,
  PaginationState,
} from "@ui-sdk/react/pagination";
import { createContext, isValidElement, use, useState } from "react";
import type { ReactNode } from "react";

import { useI18n, useLocale } from "../lib/i18n";
import type { I18nCatalog } from "../lib/i18n";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  Icon,
  LoaderIcon,
} from "../lib/icons";
import { focusRing, visuallyHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import { className, listOf, slotted } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";
import { buttonVariants } from "./button";

/** Every prop a Pagination takes. */
export interface PaginationProps {
  /** Its parts: a PaginationRange if you want one, then a PaginationContent holding the steps. */
  children: ReactNode;
  /** How many items there are in all. */
  total: number;
  /** How many items fit on a page. */
  pageSize: number;
  /** The page shown, from 1. Pass it with `onPageChange` to control it. */
  page?: number;
  /**
   * The page it starts on, when you do not control it.
   * @default 1
   */
  defaultPage?: number;
  /** Runs with the new page when a step or a page link is pressed. */
  onPageChange?: (page: number) => void;
  /**
   * Each page's address. With it the steps and page links are links, which work before the script
   * loads; read the page back from the address and pass it as `page`.
   */
  getPageUrl?: (page: number) => string;
  /**
   * The next page is loading: both steps do nothing until it has, and a spinner turns in the step
   * last pressed (Next, if none was).
   * @default false
   */
  loading?: boolean;
  /**
   * What the items are called, by plural form, in place of the catalogue's word ("reports").
   * @default the I18nProvider's `pagination.unit` ("items")
   */
  unit?: { one: string; other: string };
  /**
   * Its name, for a page with more than one.
   * @default "Pagination"
   */
  "aria-label"?: string;
  /** Layout only: where it sits. */
  style?: LayoutStyle;
}

/** Every prop a PaginationContent takes: the list of the steps. */
export interface PaginationContentProps {
  /**
   * Its items: a PaginationItem with a PaginationPrevious, a PaginationPage or page links if you
   * want them, then a PaginationItem with a PaginationNext. A function gets the pages to show
   * (`items`, each a page or a gap), the page and the count.
   */
  children: ReactNode | ((state: PaginationState) => ReactNode);
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PaginationItem takes: one place in the list. */
export interface PaginationItemProps {
  /** A PaginationPrevious, a PaginationNext, a PaginationLink or a PaginationEllipsis. */
  children: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PaginationLink takes. */
export interface PaginationLinkProps {
  /** The page it goes to, from 1. */
  page: number;
  /** Its words: the page's number when left out. */
  children?: ReactNode;
  /**
   * Drawn as the current page. By default it is the page the Pagination stands on.
   */
  isActive?: boolean;
  /**
   * Draws the one element given as the child (a router's link) as the page link, with its look.
   * @default false
   */
  asChild?: boolean;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PaginationPrevious takes. */
export interface PaginationPreviousProps {
  /**
   * Draws the one element given as the child (a router's link, with no words) as the step, with
   * the step's look and its chevron.
   * @default false
   */
  asChild?: boolean;
  /** The one element it is drawn as, with `asChild`. */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PaginationNext takes. */
export interface PaginationNextProps {
  /**
   * Draws the one element given as the child (a router's link, with no words) as the step, with
   * the step's look and its chevron.
   * @default false
   */
  asChild?: boolean;
  /** The one element it is drawn as, with `asChild`. */
  children?: ReactNode;
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PaginationEllipsis takes. */
export interface PaginationEllipsisProps {
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PaginationRange takes. */
export interface PaginationRangeProps {
  /** Layout only. */
  style?: LayoutStyle;
}

/** Every prop a PaginationPage takes. */
export interface PaginationPageProps {
  /** Layout only. */
  style?: LayoutStyle;
}

const HOVER = media.hover;
const COARSE = media.pointerCoarse;
const FORCED = media.forcedColors;
const OFF = ":is([data-disabled], [data-loading])";
const REDUCED = media.reducedMotion;

const spin = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});

const styles = stylex.create({
  root: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: space[3],
    rowGap: space[2],
    minWidth: 0,
    fontFamily: font.sans,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    fontVariantNumeric: "tabular-nums",
  },
  // The steps sit at the end of the row, after the range.
  list: {
    display: "flex",
    alignItems: "center",
    // On a touch screen the steps stand apart, so their 44px targets meet and never overlap.
    columnGap: {
      default: space[1],
      [COARSE]: `calc(${size.tapTarget} - ${size.paginationStep})`,
    },
    marginInlineStart: "auto",
    padding: 0,
    margin: 0,
    listStyle: "none",
  },
  item: {
    display: "flex",
  },
  range: {
    margin: 0,
    color: colors.mutedForeground,
  },
  step: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    width: size.paginationStep,
    height: size.paginationStep,
    padding: 0,
    margin: 0,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    // Forced colours replace currentColor on a border, so the step names its system colour.
    borderColor: {
      default: "currentColor",
      [FORCED]: { default: "ButtonText", [OFF]: "GrayText" },
    },
    borderRadius: `min(${radius.base}, calc(${size.paginationStep} / 2))`,
    cornerShape: radius.shape,
    color: {
      default: colors.foreground,
      [OFF]: colors.subtleForeground,
      [FORCED]: { default: "ButtonText", [OFF]: "GrayText" },
    },
    // Drawn as the quiet button is: its fill and a low lift. A step at its end does not answer the
    // pointer: it lies flat on the soft ground, without the lift.
    backgroundColor: {
      default: colors.control,
      ":hover": {
        default: null,
        [HOVER]: { default: colors.controlHover, [OFF]: colors.muted },
      },
      ":active": { default: colors.controlActive, [OFF]: colors.muted },
      [OFF]: colors.muted,
    },
    boxShadow: { default: shadow.sm, [OFF]: "none" },
    transform: {
      default: null,
      ":active": { default: `scale(${size.buttonPressScale})`, [OFF]: "none" },
    },
    transitionProperty: "transform, background-color",
    // With reduced motion the press still shows, at once, without travelling.
    transitionDuration: `${motionVars.hover}, ${duration.hover}`,
    transitionTimingFunction: duration.ease,
    textDecorationLine: "none",
    cursor: { default: "pointer", [OFF]: "not-allowed" },
    userSelect: "none",
    touchAction: "manipulation",
    WebkitTapHighlightColor: "transparent",
  },
  // A finger needs 44px: on a touch screen an invisible area makes up the difference.
  target: {
    position: "absolute",
    inset: {
      default: 0,
      [COARSE]: `calc((${size.paginationStep} - ${size.tapTarget}) / 2)`,
    },
  },
  // The chevrons point the way the row runs: right to left the icon turns round.
  chevron: {
    display: "inline-flex",
  },
  indicator: {
    display: "inline-block",
    whiteSpace: "nowrap",
    paddingInline: space[1],
    color: colors.foreground,
  },
  count: {
    color: colors.subtleForeground,
  },
  // A gap between page links: as wide as one, an ellipsis in it.
  ellipsis: {
    [iconVars.size]: size.iconSm,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: size.controlXs,
    height: size.controlXs,
    color: colors.mutedForeground,
  },
  // While the next page loads: the spinner in the pressed step's own room, where its chevron was, so
  // the row keeps its width.
  turning: {
    display: "inline-flex",
    color: { default: colors.mutedForeground, [FORCED]: "GrayText" },
    animationName: { default: spin, [REDUCED]: "none" },
    animationDuration: duration.spin,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
});

// UI SDK names its parts after its own primitive; each part here carries Pagination's own name
// (slotted). A step or a page link is a link when the root has addresses (`getPageUrl`), else a
// button, as UI SDK draws it.

/** Where the list stands, and what the root was told, for its parts. */
interface Standing {
  current: number;
  pageCount: number;
  total: number;
  size: number;
  loading: boolean;
  /** Whether the pages have addresses, so the steps and links are links. */
  linked: boolean;
  /** Numbers and plurals in the provider's locale, made once for every part. */
  number: Intl.NumberFormat;
  plural: Intl.PluralRules;
  /** What the items are called: the root's `unit`, else the catalogue's. */
  unit: I18nCatalog["pagination"]["unit"];
  went: "previous" | "next";
  setWent: (step: "previous" | "next") => void;
}

const StandingContext = createContext<Standing>({
  current: 1,
  pageCount: 1,
  total: 0,
  size: 10,
  loading: false,
  linked: false,
  number: new Intl.NumberFormat("en-GB"),
  plural: new Intl.PluralRules("en-GB"),
  unit: { other: "" },
  went: "next",
  setWent: () => {
    // Outside a Pagination there is no step to remember.
  },
});

/** The words it shows and says: the I18nProvider's, else English, numbers as the root formats them. */
const useWords = () => {
  const { pagination: words } = useI18n();
  const standing = use(StandingContext);
  const { unit } = standing;
  const format = (value: number) => standing.number.format(value);
  const { current, pageCount, total } = standing;
  const first = (current - 1) * standing.size + 1;
  const last = Math.min(current * standing.size, total);
  return {
    words,
    standing,
    format,
    range:
      total === 0
        ? words.none(unit.other)
        : words.range(
            format(first),
            format(last),
            format(total),
            unit[standing.plural.select(total)] ?? unit.other
          ),
    where:
      total === 0
        ? words.none(unit.other)
        : words.page(format(current), format(pageCount)),
  };
};

/** The items shown and the total, beside the steps ("Showing 21 – 30 of 100 items"). Said when it changes. */
export const PaginationRange = ({ style }: PaginationRangeProps) => {
  const { range, words, standing } = useWords();
  return (
    <p
      aria-live="polite"
      data-slot="pagination-range"
      {...stylex.props(styles.range, style)}
    >
      {range}
      {standing.loading && (
        <span {...stylex.props(visuallyHidden)}>, {words.loading}</span>
      )}
    </p>
  );
};

/** Where it stands, said to a screen reader when it changes, with no range shown. */
const Where = () => {
  const { where, words, standing } = useWords();
  return (
    <span aria-live="polite" {...stylex.props(visuallyHidden)}>
      {where}
      {standing.loading && `, ${words.loading}`}
    </span>
  );
};

/** The list of the steps. */
export const PaginationContent = ({
  children,
  style,
}: PaginationContentProps) => (
  <PaginationList
    render={slotted("ul", "pagination-content")}
    {...stylex.props(styles.list, style)}
  >
    {(state: PaginationState): ReactNode =>
      typeof children === "function" ? children(state) : children
    }
  </PaginationList>
);

/** One place in the list. */
export const PaginationItem = ({ children, style }: PaginationItemProps) => (
  <ItemPrimitive
    render={slotted("li", "pagination-item")}
    {...stylex.props(styles.item, style)}
  >
    {children}
  </ItemPrimitive>
);

/**
 * A link to one page; the current one says so (`aria-current="page"`) and is drawn `outline`
 * among `ghost` pages.
 */
export const PaginationLink = ({
  page,
  children,
  isActive,
  asChild = false,
  style,
}: PaginationLinkProps) => {
  const standing = use(StandingContext);
  const element =
    asChild && isValidElement<Record<string, unknown>>(children)
      ? children
      : undefined;
  return (
    <LinkPrimitive
      page={page}
      aria-current={isActive === true ? "page" : undefined}
      render={slotted(
        standing.linked ? "a" : "button",
        "pagination-link",
        element
      )}
      className={(state: PaginationLinkState) =>
        className(
          buttonVariants({
            variant: (isActive ?? state.current) ? "outline" : "ghost",
            size: "icon-xs",
          }),
          style
        )
      }
    >
      {element === undefined ? children : undefined}
    </LinkPrimitive>
  );
};

/** A gap between page links. Hidden from screen readers: the links around it say which pages there are. */
export const PaginationEllipsis = ({ style }: PaginationEllipsisProps) => (
  <EllipsisPrimitive
    render={slotted("span", "pagination-ellipsis")}
    {...stylex.props(styles.ellipsis, style)}
  >
    <Icon icon={EllipsisIcon} />
  </EllipsisPrimitive>
);

/** The page and the count between the steps ("2 / 10"). A list item of its own: put it straight in PaginationContent. */
export const PaginationPage = ({ style }: PaginationPageProps) => {
  const { format, standing } = useWords();
  return (
    <ItemPrimitive
      aria-hidden="true"
      render={slotted("li", "pagination-item")}
      {...stylex.props(styles.item)}
    >
      <span
        data-slot="pagination-page"
        dir="ltr"
        {...stylex.props(styles.indicator, style)}
      >
        <span>{format(standing.current)}</span>{" "}
        <span {...stylex.props(styles.count)}>
          / {format(standing.pageCount)}
        </span>
      </span>
    </ItemPrimitive>
  );
};

// While the page it asked for loads, a spinner turns in the step last pressed.
const Turning = () => (
  <span
    data-slot="pagination-loading"
    aria-hidden="true"
    {...stylex.props(styles.turning)}
  >
    <Icon icon={LoaderIcon} />
  </span>
);

/** A step's inside: its touch target, its chevron or the spinner, and its name. */
const Step = ({ way, name }: { way: "previous" | "next"; name: string }) => {
  const { standing } = useWords();
  return (
    <>
      <span aria-hidden="true" {...stylex.props(styles.target)} />
      {standing.loading && standing.went === way ? (
        <Turning />
      ) : (
        <span {...stylex.props(styles.chevron)}>
          <Icon
            icon={way === "previous" ? ChevronLeftIcon : ChevronRightIcon}
          />
        </span>
      )}
      <span {...stylex.props(visuallyHidden)}>{name}</span>
    </>
  );
};

/** The element a step is drawn as, with `asChild`. */
const stepElement = (asChild: boolean, children: ReactNode) =>
  asChild && isValidElement<Record<string, unknown>>(children)
    ? children
    : undefined;

/** The step back. While the next page loads it does nothing, and turns if it was pressed last. */
export const PaginationPrevious = ({
  asChild = false,
  children,
  style,
}: PaginationPreviousProps) => {
  const { words, standing } = useWords();
  const off = standing.loading
    ? { "data-loading": "", "aria-disabled": true }
    : {};
  return (
    <PreviousPrimitive
      {...off}
      onClick={() => {
        standing.setWent("previous");
      }}
      render={slotted(
        standing.linked ? "a" : "button",
        "pagination-previous",
        stepElement(asChild, children)
      )}
      {...stylex.props(styles.step, focusRing, style)}
    >
      <Step way="previous" name={words.previous} />
    </PreviousPrimitive>
  );
};

/** The step on. While the next page loads it does nothing, and turns if it was pressed last (or none was). */
export const PaginationNext = ({
  asChild = false,
  children,
  style,
}: PaginationNextProps) => {
  const { words, standing } = useWords();
  const off = standing.loading
    ? { "data-loading": "", "aria-disabled": true }
    : {};
  return (
    <NextPrimitive
      {...off}
      onClick={() => {
        standing.setWent("next");
      }}
      render={slotted(
        standing.linked ? "a" : "button",
        "pagination-next",
        stepElement(asChild, children)
      )}
      {...stylex.props(styles.step, focusRing, style)}
    >
      <Step way="next" name={words.next} />
    </NextPrimitive>
  );
};

/** Whether the parts include a range: without one, where it stands is said in a hidden line. */
const holdsRange = (children: ReactNode) =>
  listOf(children).some(
    (child) => isValidElement(child) && child.type === PaginationRange
  );

/** The root: a navigation landmark round its parts. */
export const Pagination = ({
  children,
  total,
  pageSize,
  page,
  defaultPage,
  onPageChange,
  getPageUrl,
  loading = false,
  unit,
  "aria-label": ariaLabel,
  style,
}: PaginationProps) => {
  const { pagination: words } = useI18n();
  // Numbers in the provider's locale, else en-GB, one way on the server and in every browser, so
  // the page hydrates cleanly.
  const locale = useLocale() ?? "en-GB";
  const number = new Intl.NumberFormat(locale);
  const plural = new Intl.PluralRules(locale);
  // The step last pressed: while the page it asked for loads, its spinner turns there.
  const [went, setWent] = useState<"previous" | "next">("next");
  const change = (next: number, details: ChangeDetails) => {
    // While the next page loads, a press does nothing, and a link is not followed.
    if (loading) {
      details.cancel();
      return;
    }
    onPageChange?.(next);
  };
  const perPage = Math.max(1, pageSize);
  return (
    <PaginationPrimitive
      aria-label={ariaLabel ?? words.name}
      total={total}
      pageSize={perPage}
      page={page}
      defaultPage={defaultPage}
      onPageChange={change}
      getHref={getPageUrl}
      render={slotted("nav", "pagination")}
      {...stylex.props(styles.root, style)}
    >
      {({ page: current, pageCount }: PaginationState) => (
        <StandingContext
          // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
          value={{
            current,
            pageCount,
            total,
            size: perPage,
            loading,
            linked: getPageUrl !== undefined,
            number,
            plural,
            unit: unit ?? words.unit,
            went,
            setWent,
          }}
        >
          {/* Said when it changes, so a step is heard to have moved. */}
          {!holdsRange(children) && <Where />}
          {children}
        </StandingContext>
      )}
    </PaginationPrimitive>
  );
};
