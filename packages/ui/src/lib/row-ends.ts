/**
 * A row or a table that moves sideways inside itself, said honestly. There are no scrollbars
 * anywhere, so one cut at its edge would look like a mistake: the end with more behind it is
 * marked, for it to fade there, and whatever is open in a row is kept wholly in view.
 */

/** Where something is, from left to right. */
export interface Span {
  left: number;
  right: number;
}

/** How far a row is moved, how wide all of it is, and how much of that it shows. */
export interface RowScroll {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/** Which ends of a row have more of it out of sight. A pixel either way is rounding, not more. */
export const endsOf = (row: RowScroll): { start: boolean; end: boolean } => ({
  start: row.scrollLeft > 1,
  end: row.scrollWidth - row.clientWidth - row.scrollLeft > 1,
});

/**
 * How far a row has to move for one of its items to be wholly in view, `clear` of each end (where
 * the row may fade); 0 when it already is. An item with no room for all of it shows its start.
 */
export const moveToShow = (row: Span, item: Span, clear: number): number => {
  if (item.left < row.left + clear) {
    return item.left - (row.left + clear);
  }
  if (item.right > row.right - clear) {
    return item.right - (row.right - clear);
  }
  return 0;
};

/**
 * Keeps the ends of a box that moves sideways marked (`data-more-start`, `data-more-end`), for
 * as long as it is on the page: given as its `ref`, it returns how to stop. `onChange` hears of
 * every change inside it.
 */
export const watchEnds = (
  box: HTMLElement | null,
  onChange?: (records: MutationRecord[]) => void
): (() => void) | undefined => {
  if (!box) {
    return undefined;
  }

  const mark = () => {
    const ends = endsOf(box);
    box.toggleAttribute("data-more-start", ends.start);
    box.toggleAttribute("data-more-end", ends.end);
  };

  // The box's own size, and that of what is in it: a font that arrives or a count that goes
  // changes how wide the items are without changing the box.
  const sizes = new ResizeObserver(mark);
  const watchSizes = () => {
    sizes.observe(box);
    for (const item of box.children) {
      sizes.observe(item);
    }
  };
  const changes = new MutationObserver((records) => {
    watchSizes();
    mark();
    onChange?.(records);
  });

  watchSizes();
  changes.observe(box, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-selected"],
  });
  box.addEventListener("scroll", mark, { passive: true });
  mark();

  return () => {
    sizes.disconnect();
    changes.disconnect();
    box.removeEventListener("scroll", mark);
  };
};

/**
 * A row of tabs: its ends marked, and its open item, the one with `aria-selected`, kept in view.
 * Only the row moves, never the page around it, and it glides only when someone is at work in
 * it. What an item keeps clear of the ends is the row's own `scroll-padding`.
 */
export const watchRow = (row: HTMLElement | null): (() => void) | undefined => {
  if (!row) {
    return undefined;
  }

  const show = () => {
    const open = row.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!open) {
      return;
    }
    const padding = getComputedStyle(row).scrollPaddingLeft;
    // A length such as "24px": parseFloat reads its number, Number() would
    // give NaN.
    // oxlint-disable-next-line unicorn/prefer-number-coercion
    const clear = Number.parseFloat(padding) || 0;
    const left = moveToShow(
      row.getBoundingClientRect(),
      open.getBoundingClientRect(),
      clear
    );
    if (left === 0) {
      return;
    }
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollBy({
      left,
      behavior:
        !calm && row.contains(document.activeElement) ? "smooth" : "instant",
    });
  };

  const stop = watchEnds(row, (records) => {
    if (records.some((record) => record.type === "attributes")) {
      show();
    }
  });
  show();
  return stop;
};
