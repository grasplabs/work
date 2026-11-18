// Multi-step form: a form of fixed height that works out its own pages by measuring its fields, as
// Palermo's. Nothing declares a step: each direct child is one block (a Field, a group), and the
// blocks are packed into pages that fit the height, so the frame never moves.
//
//   <MultiStepForm title="Brief" onSubmit={send}>
//     <Field key="brand">…</Field>
//     <Field key="keyword">…</Field>
//     <Field key="brief">…</Field>
//   </MultiStepForm>
//
// Every field stays mounted on or off its page, so going back never loses what was typed; fields
// off the page are moved out of flow and made inert. Next checks only the page it leaves; Send
// checks every page and goes back to the first that needs a fix. Without script it is one page
// that scrolls, and its Send sends the form. Where script runs, the server's drawing is already
// page one: the blocks wrap into columns as tall as the page and only the first shows, so nothing
// moves when the form comes alive. Every value is a token (src/tokens).
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import {
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  ReactElement,
  ReactNode,
  RefObject,
  SubmitEvent as FormSubmitEvent,
} from "react";

import { Button } from "../button/button";
import type { ActionState } from "../button/button";
import { visuallyHidden } from "../hidden/hidden";
import type { LayoutStyle } from "../layout/layout";
import { scroll } from "../scroll/scroll";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { multiStepFormWords } from "./words";

/** What a caller may style: where it sits and how wide it is. */
export type MultiStepFormLayoutStyle = LayoutStyle;

/** Every prop a MultiStepForm takes. */
export interface MultiStepFormProps {
  /** The blocks, in order: each direct child is one, never split. Give each a `key`; `canAdvance` receives them. */
  children: ReactNode;
  /** A few words over the form, which also name it ("Brief"). */
  title?: string;
  /**
   * The form's height, which never changes: pixels or any CSS length. The pages are whatever fits.
   * @default "min(28rem, 70vh)"
   */
  height?: number | string;
  /**
   * `fill` packs each page with as many blocks as fit; `uniform` puts the same number on every page.
   * @default "fill"
   */
  mode?: "fill" | "uniform";
  /**
   * The page shown, from 0. Pass it with `onStepChange` to control it. Pages change with the
   * width, so a controlled page is a number the caller keeps in step.
   */
  step?: number;
  /**
   * The page it starts on, when you do not control it.
   * @default 0
   */
  defaultStep?: number;
  /** Runs with the new page when Next or Back moves. */
  onStepChange?: (step: number) => void;
  /** Runs when the last page is sent and every field is valid. Return a promise to show it working. */
  onSubmit?: () => void | Promise<void>;
  /**
   * Whether Next may leave a page: it gets the page and the keys of the blocks on it. Check those
   * keys, never the page number, which changes with the width. A promise shows Next working.
   */
  canAdvance?: (step: number, keys: string[]) => boolean | Promise<boolean>;
  /**
   * The words on the button that goes back a step.
   * @default "Back"
   */
  backLabel?: string;
  /**
   * The words on the button that goes on to the next step.
   * @default "Next"
   */
  nextLabel?: string;
  /**
   * The words on the last step's button, which sends the form: a verb and what it sends ("Create project").
   * @default "Send"
   */
  submitLabel?: string;
  /**
   * What Send says when `onSubmit` failed. The form stays as it is, to try again.
   * @default "Could not send"
   */
  failedLabel?: string;
  /**
   * The word a screen reader hears before the counter ("Page 2 of 3"). Not shown.
   * @default "Page"
   */
  pageLabel?: string;
  /**
   * The counter as it is written, from the page and how many there are.
   * @default (page, total) => `${page} of ${total}`
   */
  counterLabel?: (page: number, total: number) => string;
  /**
   * How many pages you expect at first. The server cannot measure, so with this it draws the
   * counter and Next from the start; without it they stay unseen until the form has measured
   * itself. The fields of page one are drawn either way.
   */
  expectedPages?: number;
  /** Where the form is sent without script. */
  action?: string;
  /**
   * How it is sent without script: `post` keeps what was typed out of the address.
   * @default "post"
   */
  method?: "post" | "get";
  /** @deprecated Use `layout`. */
  style?: MultiStepFormLayoutStyle;
  /** Layout only: where it sits and how wide it is. */
  layout?: MultiStepFormLayoutStyle;
}

const styles = stylex.create({
  frame: {
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    margin: 0,
    overflow: "hidden",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.edge,
    outlineWidth: { default: 0, "@media (forced-colors: active)": 1 },
    outlineStyle: "solid",
    fontFamily: grasp.fontSans,
    color: grasp.ink,
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space4,
    flexShrink: 0,
    paddingBlockStart: grasp.space3,
    paddingBlockEnd: grasp.space2,
    paddingInline: grasp.space4,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
  title: {
    margin: 0,
    minWidth: 0,
    color: grasp.muted,
  },
  counter: {
    flexShrink: 0,
    color: grasp.quiet,
    fontVariantNumeric: "tabular-nums",
  },
  // The paged region: it takes what the header and footer leave, and scrolls only when one block is
  // taller than a page.
  content: {
    position: "relative",
    flexGrow: 1,
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "auto",
  },
  // Before the form has measured itself, where script runs: the blocks wrap into columns as tall
  // as the page, a block that does not fit starting the next, and the first column fills the view.
  // That is page one as `fill` packs it; the later pages lie beside it, reached by scrolling
  // sideways, with no bar drawn. Without script it stays one page that scrolls down.
  waiting: {
    display: { default: null, [media.script]: "flex" },
    flexDirection: { default: null, [media.script]: "column" },
    flexWrap: { default: null, [media.script]: "wrap" },
    alignContent: { default: null, [media.script]: "flex-start" },
    overflowX: { default: null, [media.script]: "auto" },
    overflowY: { default: "auto", [media.script]: "hidden" },
    scrollbarWidth: { default: null, [media.script]: "none" },
    scrollSnapType: { default: null, [media.script]: "x mandatory" },
  },
  waitingSlot: {
    scrollSnapAlign: { default: null, [media.script]: "start" },
    width: { default: null, [media.script]: "100%" },
    flexShrink: { default: null, [media.script]: 0 },
  },
  // What cannot be known before measuring (Next or Send) keeps its room and is not shown.
  unknown: {
    visibility: { default: null, [media.script]: "hidden" },
  },
  // Drawn from `expectedPages` before measuring: only where script runs. Without script the form
  // is one page, so it has no counter and its button is Send.
  shown: {
    display: "contents",
  },
  counterWithScript: {
    display: { default: "none", [media.script]: "inline" },
  },
  withScript: {
    display: { default: "none", [media.script]: "contents" },
  },
  withoutScript: {
    display: { default: "contents", [media.script]: "none" },
  },
  // A block on the page, in flow.
  slot: {},
  // A block off the page: still laid out at full width, so it can be measured, but unseen.
  parked: {
    position: "absolute",
    insetInline: 0,
    top: 0,
    height: 0,
    overflow: "hidden",
    visibility: "hidden",
    pointerEvents: "none",
  },
  // A block's fields keep the header's and footer's inline edge: the title, the counter, the fields
  // and Next all line up on both sides.
  item: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space4,
  },
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
    flexShrink: 0,
    paddingBlockStart: grasp.space2,
    // As much room under the buttons as beside them: the card's foot as even as its sides.
    paddingBlockEnd: grasp.space4,
    paddingInline: grasp.space4,
  },
  // Back is a ghost: its word, not its unseen fill, keeps the card's edge, so its padding hangs out
  // into the footer's, its fill still clear of the card's hairline.
  back: {
    display: "inline-flex",
    marginInlineStart: `calc(-1 * ${grasp.space3})`,
  },
  // With no Back beside it, Next or Send still sits at the end.
  alone: {
    justifyContent: "flex-end",
  },
});

const dynamic = stylex.create({
  // The height is the caller's, so it is set per form; everything inside follows from it.
  height: (height: string) => ({
    height,
  }),
});

const FIELDS = "input, select, textarea";
const FOCUSABLE = `${FIELDS}, button, a[href], [tabindex]`;

/** Whether a node is a list of nodes, as an array of children is. */
const isList = (node: ReactNode): node is readonly ReactNode[] =>
  Array.isArray(node);

/** The blocks as given, arrays flattened, each with the caller's own key (or its place). */
const blocksOf = (children: ReactNode): ReactElement[] => {
  const found: ReactElement[] = [];
  const walk = (node: ReactNode) => {
    if (isList(node)) {
      for (const child of node) {
        walk(child);
      }
    } else if (isValidElement(node)) {
      found.push(node);
    }
  };
  walk(children);
  return found;
};

/** Whether an element is switched off: a field, a button or a fieldset with `disabled` set. */
const isDisabled = (element: HTMLElement) =>
  "disabled" in element && element.disabled === true;

/** The first element in a block that can take focus: not hidden, not disabled, not taken out. */
const firstFocusable = (root: HTMLElement | null | undefined) =>
  [...(root?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].find(
    (element) =>
      !isDisabled(element) &&
      !(element instanceof HTMLInputElement && element.type === "hidden") &&
      element.getAttribute("tabindex") !== "-1"
  );

/** Packs block heights into pages that fit `room`. Returns each page's block indexes. */
export const paginate = (
  heights: number[],
  room: number,
  mode: "fill" | "uniform"
): number[][] => {
  if (heights.length === 0) {
    return [[]];
  }
  if (mode === "uniform") {
    const tallest = Math.max(...heights);
    const per = Math.max(1, Math.floor(room / Math.max(1, tallest)));
    const count = Math.ceil(heights.length / per);
    // Spread evenly: seven at three a page come out 3, 2, 2, not 3, 3, 1.
    const base = Math.floor(heights.length / count);
    const extra = heights.length % count;
    const pages: number[][] = [];
    let next = 0;
    for (let page = 0; page < count; page += 1) {
      const size = base + (page < extra ? 1 : 0);
      const start = next;
      pages.push(Array.from({ length: size }, (_, index) => start + index));
      next += size;
    }
    return pages;
  }
  let current: number[] = [];
  const pages: number[][] = [current];
  let used = 0;
  for (const [index, height] of heights.entries()) {
    // A block that does not fit starts a new page; one taller than a page gets a page of its own.
    if (current.length > 0 && used + height > room + 0.5) {
      current = [index];
      pages.push(current);
      used = height;
    } else {
      current.push(index);
      used += height;
    }
  }
  return pages;
};

/** Waits for a gate's answer, pending meanwhile. */
const whilePending = async (
  gate: Promise<boolean>,
  setPending: (pending: boolean) => void
) => {
  setPending(true);
  try {
    return await gate;
  } finally {
    setPending(false);
  }
};

/** Submits, pending meanwhile; a failure is reported before the form stops being pending. */
const submitWith = async (
  onSubmit: (() => void | Promise<void>) | undefined,
  setPending: (pending: boolean) => void,
  onFailed: () => void
) => {
  setPending(true);
  try {
    await onSubmit?.();
  } catch {
    onFailed();
  } finally {
    setPending(false);
  }
};

/** Where Send is: working while it sends or the gate thinks, failed after a failed send. */
const stateOf = (pending: boolean, failed: boolean): ActionState => {
  if (pending) {
    return "working";
  }
  if (failed) {
    return "failed";
  }
  return "idle";
};

/** The page shown: the caller's, else the one holding the anchor block, else the first asked for. */
const pageShown = (
  step: number | undefined,
  anchor: number | null,
  defaultStep: number,
  pages: number[][]
) => {
  const last = pages.length - 1;
  const clamp = (value: number) => Math.min(Math.max(value, 0), last);
  if (step !== undefined) {
    return clamp(step);
  }
  if (anchor === null) {
    return clamp(defaultStep);
  }
  return Math.max(
    0,
    pages.findIndex((indexes) => indexes.includes(anchor))
  );
};

/** The heights a set of blocks had, kept with the blocks they were measured for. */
interface Measured {
  keySet: string;
  heights: number[];
}

/**
 * Measures the room and every block, and again whenever any of them changes size, or the blocks
 * themselves change. Heights are null until the blocks shown now have been measured.
 */
const useMeasure = (
  content: RefObject<HTMLDivElement | null>,
  items: RefObject<(HTMLDivElement | null)[]>,
  count: number,
  keySet: string
) => {
  const [measured, setMeasured] = useState<Measured | null>(null);
  const [room, setRoom] = useState(0);

  useLayoutEffect(() => {
    const measure = () => {
      const area = content.current;
      if (area === null) {
        return;
      }
      setRoom(area.clientHeight);
      setMeasured({
        keySet,
        heights: items.current
          .slice(0, count)
          .map((item) => item?.getBoundingClientRect().height ?? 0),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (content.current !== null) {
      observer.observe(content.current);
    }
    for (const item of items.current.slice(0, count)) {
      if (item !== null) {
        observer.observe(item);
      }
    }
    return () => {
      observer.disconnect();
    };
  }, [content, items, count, keySet]);

  // New blocks are never paged by the old ones' heights.
  const heights = measured?.keySet === keySet ? measured.heights : null;
  return { heights, room };
};

interface HeaderProps {
  /** Not measured yet: the counter is the caller's guess, for where script runs. */
  guessed: boolean;
  title: string | undefined;
  titleId: string;
  page: number;
  total: number;
  pageLabel: string;
  counterLabel: (page: number, total: number) => string;
}

/** The title, and which page this is when there are more. */
const Header = ({
  guessed,
  title,
  titleId,
  page,
  total,
  pageLabel,
  counterLabel,
}: HeaderProps) => {
  const named = title !== undefined && title !== "";
  const many = total > 1;
  if (!named && !many) {
    return null;
  }
  return (
    <div {...stylex.props(styles.header)}>
      {named ? (
        <p id={titleId} {...stylex.props(styles.title)}>
          {title}
        </p>
      ) : (
        <span />
      )}
      {many && (
        <span
          aria-live="polite"
          data-slot="multi-step-counter"
          {...stylex.props(styles.counter, guessed && styles.counterWithScript)}
        >
          <span {...stylex.props(visuallyHidden)}>{`${pageLabel} `}</span>
          {counterLabel(page + 1, total)}
        </span>
      )}
    </div>
  );
};

interface FooterProps {
  /** Not measured yet, and more pages expected: Next where script runs, Send where it does not. */
  guessed: boolean;
  unknown: boolean;
  back: boolean;
  final: boolean;
  pending: boolean;
  state: ActionState;
  onBack: () => void;
  backLabel: string;
  nextLabel: string;
  submitLabel: string;
  failedLabel: string;
}

/** Back, when there is a page behind, and Next or, on the last page, Send. */
const Footer = ({
  guessed,
  unknown,
  back,
  final,
  pending,
  state,
  onBack,
  backLabel,
  nextLabel,
  submitLabel,
  failedLabel,
}: FooterProps) => {
  const label = final ? submitLabel : nextLabel;
  return (
    <div
      {...stylex.props(
        styles.footer,
        !back && styles.alone,
        unknown && styles.unknown
      )}
    >
      {back && (
        <span {...stylex.props(styles.back)}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={onBack}
          >
            {backLabel}
          </Button>
        </span>
      )}
      <span {...stylex.props(guessed ? styles.withScript : styles.shown)}>
        <Button
          type="submit"
          variant="ink"
          size="sm"
          status={state}
          doneLabel={label}
          failedLabel={failedLabel}
        >
          {label}
        </Button>
      </span>
      {guessed && (
        <span {...stylex.props(styles.withoutScript)}>
          <Button type="submit" variant="ink" size="sm">
            {submitLabel}
          </Button>
        </span>
      )}
    </div>
  );
};

/** How tall the form stands until the caller says: a value, not words. */
const HEIGHT = "min(28rem, 70vh)";

export const MultiStepForm = ({
  children,
  title,
  height = HEIGHT,
  mode = "fill",
  step,
  defaultStep = 0,
  onStepChange,
  onSubmit,
  canAdvance,
  backLabel: backGiven,
  nextLabel: nextGiven,
  submitLabel: submitGiven,
  failedLabel: failedGiven,
  pageLabel: pageGiven,
  counterLabel: counterGiven,
  expectedPages,
  action,
  method = "post",
  style: styleProp,
  layout,
}: MultiStepFormProps) => {
  // Its words: the product's, by its catalogue, else English; the caller's props still win.
  const {
    back: backLabel,
    next: nextLabel,
    submit: submitLabel,
    failed: failedLabel,
    page: pageLabel,
    counter: counterLabel,
  } = withGiven(useWords("multiStepForm", multiStepFormWords), {
    back: backGiven,
    next: nextGiven,
    submit: submitGiven,
    failed: failedGiven,
    page: pageGiven,
    counter: counterGiven,
  });
  const blocks = blocksOf(children);
  // The caller's own keys, as they wrote them; a block without one is known by its place.
  const keys = blocks.map((block, index) => block.key ?? String(index));
  const keySet = keys.join("\u0000");

  const titleId = useId();
  const content = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLDivElement | null)[]>([]);
  const { heights, room } = useMeasure(content, items, blocks.length, keySet);
  // The page is held by its first block, not its number: when the pages change with the width or
  // a taller error, the person stays with the fields they were on.
  const [anchor, setAnchor] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const focusAfter = useRef(false);

  // Until it is measured (and without script) every block is on one page; where script runs, that
  // page is drawn as page one, and the counter and Next come from `expectedPages` if given.
  const alive = heights !== null && room > 0;
  const pages = alive
    ? paginate(heights, room, mode)
    : [blocks.map((_, index) => index)];
  const total = alive ? pages.length : Math.max(1, expectedPages ?? 1);
  const last = pages.length - 1;
  const page = pageShown(step, anchor, defaultStep, pages);
  const shown = pages[page] ?? [];
  const [firstShown] = shown;

  // Goes to the page that holds a block.
  const goToBlock = (index: number) => {
    const next = Math.max(
      0,
      pages.findIndex((indexes) => indexes.includes(index))
    );
    if (next === page) {
      focusAfter.current = false;
      return;
    }
    focusAfter.current = true;
    if (step === undefined) {
      setAnchor(pages[next]?.[0] ?? 0);
    }
    if (content.current !== null) {
      content.current.scrollTop = 0;
    }
    onStepChange?.(next);
  };
  const back = () => {
    goToBlock(pages[Math.max(page - 1, 0)]?.[0] ?? 0);
  };

  // After a move, the first field of the new page takes focus, so typing goes on where it should.
  useEffect(() => {
    if (!focusAfter.current) {
      return;
    }
    focusAfter.current = false;
    if (firstShown !== undefined) {
      firstFocusable(items.current[firstShown])?.focus();
    }
  }, [firstShown]);

  const fieldsOn = (indexes: number[]) =>
    indexes.flatMap((index) => [
      ...(items.current[index]?.querySelectorAll<HTMLInputElement>(FIELDS) ??
        []),
    ]);

  // Asks the gate about a page's blocks; true when it may go on.
  const gateFor = async (indexes: number[]) => {
    const gate =
      canAdvance?.(
        page,
        keys.filter((_, index) => indexes.includes(index))
      ) ?? true;
    if (gate instanceof Promise) {
      return await whilePending(gate, setPending);
    }
    return gate;
  };

  const send = async () => {
    setFailed(false);
    // This page's fields first: a field the person has not reached yet is not an error.
    const here = fieldsOn(shown).find((field) => !field.checkValidity());
    if (here !== undefined) {
      here.reportValidity();
      return;
    }
    // Every page's blocks go through the gate, the last one too, so it never depends on the width.
    if (!(await gateFor(shown))) {
      return;
    }
    if (page < last) {
      // By block, not by number: the pages may have changed while the gate was thinking.
      goToBlock((shown.at(-1) ?? 0) + 1);
      return;
    }
    // The last page: every field, and back to the first page that needs a fix.
    const all = blocks.map((_, index) => index);
    const wrong = fieldsOn(all).find((field) => !field.checkValidity());
    if (wrong !== undefined) {
      const index = items.current.findIndex(
        (item) => item?.contains(wrong) === true
      );
      goToBlock(index);
      requestAnimationFrame(() => {
        wrong.reportValidity();
      });
      return;
    }
    // Kept as it is on a failure, to try again; the button says so, and a screen reader hears it.
    await submitWith(onSubmit, setPending, () => {
      setFailed(true);
    });
  };

  const onFormSubmit = (event: FormSubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pending) {
      void send();
    }
  };

  return (
    <form
      data-slot="multi-step-form"
      noValidate={heights !== null}
      action={action}
      method={method}
      aria-labelledby={
        title !== undefined && title !== "" ? titleId : undefined
      }
      onSubmit={onFormSubmit}
      {...stylex.props(
        styles.frame,
        dynamic.height(typeof height === "number" ? `${height}px` : height),
        layout ?? styleProp
      )}
    >
      <Header
        guessed={!alive && total > 1}
        title={title}
        titleId={titleId}
        page={page}
        total={total}
        pageLabel={pageLabel}
        counterLabel={counterLabel}
      />
      <div
        ref={content}
        {...stylex.props(styles.content, scroll.bar, !alive && styles.waiting)}
      >
        {blocks.map((block, index) => {
          const here = shown.includes(index);
          return (
            <div
              key={block.key ?? index}
              data-slot="multi-step-block"
              inert={!here || undefined}
              aria-hidden={!here || undefined}
              {...stylex.props(
                here ? styles.slot : styles.parked,
                !alive && styles.waitingSlot
              )}
            >
              <div
                ref={(element) => {
                  items.current[index] = element;
                }}
                {...stylex.props(styles.item)}
              >
                {block}
              </div>
            </div>
          );
        })}
      </div>
      <Footer
        guessed={!alive && total > 1}
        unknown={!alive && expectedPages === undefined}
        back={pages.length > 1 && page > 0}
        final={alive ? page >= last : total <= 1}
        pending={pending}
        state={stateOf(pending, failed)}
        onBack={back}
        backLabel={backLabel}
        nextLabel={nextLabel}
        submitLabel={submitLabel}
        failedLabel={failedLabel}
      />
    </form>
  );
};
