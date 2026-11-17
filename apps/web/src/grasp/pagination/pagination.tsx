// Pagination: Previous and Next through a long list, and where in it you are, from shadcn's
// (registry/bases/base/ui/pagination.tsx), converted from Tailwind to StyleX and rebuilt on UI SDK's
// Pagination, then made Grasp's on Palermo's: two small raised steps, with the range shown
// ("Showing 21–30 of 100 items"), the page ("2 / 10"), or nothing beside them.
//
// Since release step 6 it is built from parts, as shadcn's:
//
//   <Pagination total={100} page={page} onPageChange={setPage}>
//     <PaginationRange />
//     <PaginationContent>
//       <PaginationItem><PaginationPrevious /></PaginationItem>
//       <PaginationItem><PaginationNext /></PaginationItem>
//     </PaginationContent>
//   </Pagination>
//
// PaginationPage ("2 / 10") stands between the steps in place of the range. The older shape below
// keeps working until step 9:
//
//   <Pagination total={100} page={page} onPageChange={setPage} />
//   <Pagination total={100} show="page" defaultPage={1} />
//   <Pagination total={100} show="none" getHref={(page) => `?page=${page}`} />
//
// A step at its end says it is disabled: a button stays focusable, a link leaves the tab order.
// While the next page loads, both steps do nothing and a spinner turns in the pressed step, in place
// of its chevron, so loading never looks like the end of the list and the row keeps its width. Every value is a token (src/tokens).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import type { ChangeDetails } from "@ui-sdk/core";
import {
  Pagination as PaginationPrimitive,
  PaginationItem as ItemPrimitive,
  PaginationList,
  PaginationNext as NextPrimitive,
  PaginationPrevious as PreviousPrimitive,
} from "@ui-sdk/react/pagination";
import { createContext, isValidElement, useContext, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { ChevronLeft, ChevronRight, Icon, Spinner } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, useWordsLocale } from "../words/words";
import { paginationWords } from "./words";
import type { PaginationWords } from "./words";

/** What a caller may style: where it sits. */
export type PaginationLayoutStyle = LayoutStyle;

/** Every prop a Pagination takes. */
export interface PaginationProps {
  /**
   * Its parts: a PaginationRange, then a PaginationContent holding the steps. Leave it out only in
   * the older shape, where `show` says what stands beside the steps.
   */
  children?: ReactNode;
  /** How many items there are in all. */
  total: number;
  /**
   * How many items fit on a page.
   * @default 10
   */
  pageSize?: number;
  /** The page shown, from 1. Pass it with `onPageChange` to control it. */
  page?: number;
  /**
   * The page it starts on, when you do not control it.
   * @default 1
   */
  defaultPage?: number;
  /** Runs with the new page when Previous or Next is pressed. */
  onPageChange?: (page: number) => void;
  /** @deprecated Use `PaginationRange`, `PaginationPage`, or neither, as parts. */
  show?: "range" | "page" | "none";
  /** The next page is loading: both steps do nothing until it has, and a spinner turns in the step last pressed (Next, if none was). */
  loading?: boolean;
  /** Said to a screen reader while it loads: what is loading, as the Writing page asks. @default "Loading the page" */
  loadingLabel?: string;
  /**
   * Each page's address. With it the steps are links, which work before the script loads; read the
   * page back from the address and pass it as `page`.
   */
  getHref?: (page: number) => string;
  /**
   * What the items are called, one and many, for the range.
   * @default { one: "item", other: "items" }
   */
  unit?: { one: string; other: string };
  /**
   * Its name, for a page with more than one.
   * @default "Pagination"
   */
  "aria-label"?: string;
  /** @deprecated Use `aria-label`. */
  label?: string;
  /** The name of the step back, for a screen reader. @default "Previous page" */
  previousLabel?: string;
  /** The name of the step on, for a screen reader. @default "Next page" */
  nextLabel?: string;
  /** @deprecated Use `layout`. */
  style?: PaginationLayoutStyle;
  /** Layout only: where it sits. */
  layout?: PaginationLayoutStyle;
}

/** What a list holds: its items, never a promise of them. */
type PaginationItems = Exclude<ReactNode, PromiseLike<unknown>>;

/** Every prop a PaginationContent takes: the list of the steps. */
export interface PaginationContentProps {
  /** Its items: a PaginationItem with a PaginationPrevious, a PaginationPage if you want one, then a PaginationItem with a PaginationNext. */
  children: PaginationItems;
}

/** Every prop a PaginationItem takes: one place in the list. */
export interface PaginationItemProps {
  /** A PaginationPrevious or a PaginationNext. */
  children: ReactNode;
}

const HOVER = media.hover;
const COARSE = media.coarse;
const FORCED = media.forced;
const OFF = ":is([data-disabled], [data-loading])";
const REDUCED = media.reduced;

const spin = stylex.keyframes({
  from: { transform: "rotate(0turn)" },
  to: { transform: "rotate(1turn)" },
});

const styles = stylex.create({
  root: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: grasp.space3,
    rowGap: grasp.space2,
    minWidth: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    fontVariantNumeric: "tabular-nums",
  },
  // The steps sit at the end of the row, after the range.
  list: {
    display: "flex",
    alignItems: "center",
    // On a touch screen the steps stand apart, so their 44px targets meet and never overlap.
    columnGap: {
      default: grasp.space1,
      [COARSE]: `calc(${grasp.tap} - ${grasp.paginationStep})`,
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
    color: grasp.muted,
  },
  step: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    boxSizing: "border-box",
    width: grasp.paginationStep,
    height: grasp.paginationStep,
    padding: 0,
    margin: 0,
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    // Forced colours replace currentColor on a border, so the step names its system colour.
    borderColor: {
      default: "currentColor",
      [FORCED]: { default: "ButtonText", [OFF]: "GrayText" },
    },
    borderRadius: `min(${grasp.corner}, calc(${grasp.paginationStep} / 2))`,
    cornerShape: grasp.cornerShape,
    color: {
      default: grasp.ink,
      [OFF]: grasp.quiet,
      [FORCED]: { default: "ButtonText", [OFF]: "GrayText" },
    },
    // Raised like a quiet control; at its end, flat on a soft ground, as Palermo's.
    backgroundColor: {
      default: grasp.quietFill,
      // A step at its end does not answer the pointer: its hover keeps the soft ground (in dark the
      // hover fill lit it, so it looked pressable; eyes-b, B-navigation-01).
      ":hover": {
        default: null,
        [HOVER]: { default: grasp.quietFillHover, [OFF]: grasp.soft },
      },
      ":active": { default: grasp.quietFillPress, [OFF]: grasp.soft },
      [OFF]: grasp.soft,
    },
    boxShadow: { default: grasp.liftLow, [OFF]: "none" },
    transform: {
      default: null,
      ":active": { default: `scale(${grasp.pressScale})`, [OFF]: "none" },
    },
    transitionProperty: "transform, background-color",
    // With reduced motion the press still shows, at once, without travelling.
    transitionDuration: `${simply.hover}, ${grasp.durationHover}`,
    transitionTimingFunction: grasp.ease,
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
      [COARSE]: `calc((${grasp.paginationStep} - ${grasp.tap}) / 2)`,
    },
  },
  // The chevrons point the way the row runs: right to left the icon turns round (the icons entry (`@/components/grasp/icons`)).
  chevron: {
    display: "inline-flex",
  },
  indicator: {
    display: "inline-block",
    whiteSpace: "nowrap",
    paddingInline: grasp.space1,
    color: grasp.ink,
  },
  count: {
    color: grasp.quiet,
  },
  // While the next page loads: the spinner in the pressed step's own room, where its chevron was, so
  // the row keeps its width (the docs' Loading state drew 121px against 93px at rest).
  turning: {
    display: "inline-flex",
    color: { default: grasp.muted, [FORCED]: "GrayText" },
    animationName: { default: spin, [REDUCED]: "none" },
    animationDuration: grasp.durationSpin,
    animationTimingFunction: "linear",
    animationIterationCount: "infinite",
  },
});

/**
 * The words it shows and says: a caller's props first (until the breaking release's step 5), then
 * the product's GraspWords, then English. Numbers in the provider's locale, else en-GB, one way on
 * the server and in every browser, so the page hydrates cleanly.
 */
const wordsOf = (
  words: PaginationWords,
  locale: string | undefined,
  given: Pick<
    PaginationProps,
    "loadingLabel" | "unit" | "previousLabel" | "nextLabel"
  >,
  name?: string
) => {
  const number = new Intl.NumberFormat(locale ?? "en-GB");
  const plural = new Intl.PluralRules(locale ?? "en-GB");
  const unit: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string } =
    given.unit ?? words.unit;
  const unitFor = (count: number) => unit[plural.select(count)] ?? unit.other;
  return {
    format: (value: number) => number.format(value),
    name: name ?? words.name,
    previous: given.previousLabel ?? words.previous,
    next: given.nextLabel ?? words.next,
    loading: given.loadingLabel ?? words.loading,
    range: (first: number, last: number, total: number) =>
      total === 0
        ? words.none(unit.other)
        : words.range(
            number.format(first),
            number.format(last),
            number.format(total),
            unitFor(total)
          ),
    page: (current: number, count: number, total: number) =>
      total === 0
        ? words.none(unit.other)
        : words.page(number.format(current), number.format(count)),
  };
};
// ---- The parts (release step 6) --------------------------------------------------------------------

// What the root hands its parts, one plain value each (a context's value is never built in render):
// where the list stands, what the caller said, and whether the next page loads.
const At = createContext(1);
const Of = createContext(1);
const Total = createContext(0);
const Size = createContext(10);
const Loading = createContext(false);
const Went = createContext<"previous" | "next">("next");
// Outside a Pagination there is no step to remember.
const stay: Dispatch<SetStateAction<"previous" | "next">> = () => {
  // Nothing to keep.
};
const Turn = createContext(stay);
const Unit = createContext<PaginationProps["unit"]>(undefined);
const PreviousWords = createContext<string | undefined>(undefined);
const NextWords = createContext<string | undefined>(undefined);
const LoadingWords = createContext<string | undefined>(undefined);

/** What a part reads: the words (the provider's, the caller's where given) and where the list stands. */
const usePagination = () => {
  const current = useContext(At);
  const pageCount = useContext(Of);
  const total = useContext(Total);
  const size = useContext(Size);
  const said = wordsOf(
    useWords("pagination", paginationWords),
    useWordsLocale(),
    {
      unit: useContext(Unit),
      previousLabel: useContext(PreviousWords),
      nextLabel: useContext(NextWords),
      loadingLabel: useContext(LoadingWords),
    }
  );
  return {
    said,
    current,
    pageCount,
    range: said.range(
      (current - 1) * size + 1,
      Math.min(current * size, total),
      total
    ),
    where: said.page(current, pageCount, total),
    loading: useContext(Loading),
    went: useContext(Went),
    setWent: useContext(Turn),
  };
};

/** The items shown and the total, beside the steps ("Showing 21 – 30 of 100 items"). Said when it changes. */
export const PaginationRange = () => {
  const { range, loading, said } = usePagination();
  return (
    <p
      aria-live="polite"
      data-slot="pagination-range"
      {...stylex.props(styles.range)}
    >
      {range}
      {loading && (
        <span {...stylex.props(visuallyHidden)}>, {said.loading}</span>
      )}
    </p>
  );
};

/** Where it stands, said to a screen reader when it changes, with no range shown. */
const Where = () => {
  const { where, loading, said } = usePagination();
  return (
    <span aria-live="polite" {...stylex.props(visuallyHidden)}>
      {where}
      {loading && `, ${said.loading}`}
    </span>
  );
};

/** The list of the steps. */
export const PaginationContent = ({ children }: PaginationContentProps) => (
  <PaginationList {...stylex.props(styles.list)}>
    {() => children}
  </PaginationList>
);

/** One place in the list. */
export const PaginationItem = ({ children }: PaginationItemProps) => (
  <ItemPrimitive {...stylex.props(styles.item)}>{children}</ItemPrimitive>
);

/** The page and the count between the steps ("2 / 10"). A list item of its own: put it straight in PaginationContent. */
export const PaginationPage = () => {
  const { said, current, pageCount } = usePagination();
  return (
    <ItemPrimitive aria-hidden="true" {...stylex.props(styles.item)}>
      <span
        data-slot="pagination-page"
        dir="ltr"
        {...stylex.props(styles.indicator)}
      >
        <span>{said.format(current)}</span>{" "}
        <span {...stylex.props(styles.count)}>/ {said.format(pageCount)}</span>
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
    <Icon icon={Spinner} />
  </span>
);

/** The step back. While the next page loads it does nothing, and turns if it was pressed last. */
export const PaginationPrevious = () => {
  const { said, loading, went, setWent } = usePagination();
  const off = loading ? { "data-loading": "", "aria-disabled": true } : {};
  const wentBack = () => {
    setWent("previous");
  };
  return (
    <PreviousPrimitive
      {...off}
      onClick={wentBack}
      {...stylex.props(styles.step, focus.ring)}
    >
      <span aria-hidden="true" {...stylex.props(styles.target)} />
      {loading && went === "previous" ? (
        <Turning />
      ) : (
        <span {...stylex.props(styles.chevron)}>
          <Icon icon={ChevronLeft} />
        </span>
      )}
      <span {...stylex.props(visuallyHidden)}>{said.previous}</span>
    </PreviousPrimitive>
  );
};

/** The step on. While the next page loads it does nothing, and turns if it was pressed last (or none was). */
export const PaginationNext = () => {
  const { said, loading, went, setWent } = usePagination();
  const off = loading ? { "data-loading": "", "aria-disabled": true } : {};
  const wentOn = () => {
    setWent("next");
  };
  return (
    <NextPrimitive
      {...off}
      onClick={wentOn}
      {...stylex.props(styles.step, focus.ring)}
    >
      <span aria-hidden="true" {...stylex.props(styles.target)} />
      {loading && went === "next" ? (
        <Turning />
      ) : (
        <span {...stylex.props(styles.chevron)}>
          <Icon icon={ChevronRight} />
        </span>
      )}
      <span {...stylex.props(visuallyHidden)}>{said.next}</span>
    </NextPrimitive>
  );
};

/** Children as a flat list: one child, or a list (as JSX writes several). */
const listOf = (children: ReactNode): ReactNode[] => [children].flat();
/** Whether the parts include a range: without one, where it stands is said in a hidden line. */
const holdsRange = (children: ReactNode) =>
  listOf(children).some(
    (child) => isValidElement(child) && child.type === PaginationRange
  );

/** The older shape's parts, from `show` (until release step 9). */
const Older = ({ show }: { show: "range" | "page" | "none" }) => (
  <>
    {show === "range" && <PaginationRange />}
    <PaginationContent>
      <PaginationItem>
        <PaginationPrevious />
      </PaginationItem>
      {show === "page" && <PaginationPage />}
      <PaginationItem>
        <PaginationNext />
      </PaginationItem>
    </PaginationContent>
  </>
);

export const Pagination = ({
  children,
  total,
  pageSize = 10,
  page,
  defaultPage,
  onPageChange,
  show = "range",
  loading = false,
  loadingLabel,
  getHref,
  unit,
  label: labelDeprecated,
  "aria-label": named,
  previousLabel,
  nextLabel,
  style: styleProp,
  layout,
}: PaginationProps) => {
  const said = wordsOf(
    useWords("pagination", paginationWords),
    useWordsLocale(),
    { loadingLabel, unit, previousLabel, nextLabel },
    named ?? labelDeprecated
  );
  const change = (next: number, details: ChangeDetails) => {
    // While the next page loads, a press does nothing, and a link is not followed.
    if (loading) {
      details.cancel();
      return;
    }
    onPageChange?.(next);
  };
  // The step last pressed: while the page it asked for loads, its spinner turns there.
  const [went, setWent] = useState<"previous" | "next">("next");
  const ranged =
    children === undefined ? show === "range" : holdsRange(children);
  const size = Math.max(1, pageSize);

  return (
    <PaginationPrimitive
      data-slot="pagination"
      aria-label={said.name}
      total={total}
      pageSize={size}
      page={page}
      defaultPage={defaultPage}
      onPageChange={change}
      getHref={getHref}
      {...stylex.props(styles.root, layout ?? styleProp)}
    >
      {({ page: current, pageCount }) => (
        <At value={current}>
          <Of value={pageCount}>
            <Total value={total}>
              <Size value={size}>
                <Loading value={loading}>
                  <Went value={went}>
                    <Turn value={setWent}>
                      <Unit value={unit}>
                        <PreviousWords value={previousLabel}>
                          <NextWords value={nextLabel}>
                            <LoadingWords value={loadingLabel}>
                              {/* Said when it changes, so a step is heard to have moved. */}
                              {!ranged && <Where />}
                              {children ?? <Older show={show} />}
                            </LoadingWords>
                          </NextWords>
                        </PreviousWords>
                      </Unit>
                    </Turn>
                  </Went>
                </Loading>
              </Size>
            </Total>
          </Of>
        </At>
      )}
    </PaginationPrimitive>
  );
};
