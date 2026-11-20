// The virtual viewport: only the rows near the screen are in the page. Built on UI SDK's
// virtualiser, which measures rows as they render, keeps the row with focus, and keeps rows that
// are not rendered findable by the browser's own find in page.
"use client";

import * as stylex from "@stylexjs/stylex";
import { createVirtualizer } from "@ui-sdk/core";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { HTMLAttributes, ReactNode, RefObject } from "react";

import type { RendererControl } from "./types";

const styles = stylex.create({
  box: (size: number) => ({
    position: "relative",
    width: "100%",
    height: size,
  }),
  row: (start: number) => ({
    position: "absolute",
    insetInlineStart: 0,
    insetBlockStart: 0,
    minWidth: "100%",
    transform: `translateY(${start}px)`,
  }),
  // A table's body, laid out as the box it is here: its rows are placed, not stacked.
  body: { display: "block" },
});

export interface VirtualRowsProps {
  scroller: HTMLElement;
  count: number;
  /** A row's height before it is measured. With `fixed`, its height: rows are never measured. */
  estimate: (index: number) => number;
  fixed?: boolean;
  /**
   * The text find in page should find in a row that is not rendered. Kept only up to
   * FINDABLE_ROWS rows: past that, its hidden copy of every row would make the page large again,
   * and the viewer's own find (Ctrl or Cmd F) searches every row instead.
   */
  findable?: (index: number) => string;
  /** Changes whenever every row's size changes (a zoom): measured sizes are forgotten. */
  version?: unknown;
  initialRow?: number;
  onRow?: (row: number) => void;
  control: RefObject<RendererControl | null>;
  renderRow: (index: number) => ReactNode;
  /** Rows rendered past each edge of the screen. Fewer for large rows, like a PDF's pages. */
  overscan?: number;
  /** The rows are a table's: the box is a `tbody` and each row a `tr`, for a list inside a `table`. */
  table?: boolean;
  /** Attributes of each row's own element, like a table row's index. */
  rowProps?: (
    index: number
  ) => HTMLAttributes<HTMLElement> & Record<`data-${string}`, string | number>;
  /** Styles of each row's own element, over its place: how a table row lays out its cells. */
  rowStyle?: (index: number) => stylex.StyleXStyles;
}

interface BoxProps {
  table: boolean;
  size: number;
  place?: (element: HTMLElement | null) => void;
  children: ReactNode;
}

// The box the rows sit in, as tall as all of them: a table's body inside a table.
const Box = ({ table, size, place, children }: BoxProps) =>
  table ? (
    <tbody ref={place} {...stylex.props(styles.box(size), styles.body)}>
      {children}
    </tbody>
  ) : (
    <div ref={place} {...stylex.props(styles.box(size))}>
      {children}
    </div>
  );

interface RowProps {
  table: boolean;
  index: number;
  start: number;
  attributes: ReturnType<NonNullable<VirtualRowsProps["rowProps"]>> | undefined;
  look: stylex.StyleXStyles | undefined;
  measure?: (element: HTMLElement | null) => void;
  children: ReactNode;
}

// One row, placed at its start: a table row inside a table.
const Row = ({
  table,
  index,
  start,
  attributes,
  look,
  measure,
  children,
}: RowProps) =>
  table ? (
    <tr
      {...attributes}
      data-row={index}
      ref={measure}
      {...stylex.props(styles.row(start), look)}
    >
      {children}
    </tr>
  ) : (
    <div
      {...attributes}
      data-row={index}
      ref={measure}
      {...stylex.props(styles.row(start), look)}
    >
      {children}
    </div>
  );

/** The most rows whose text find in page keeps. */
export const FINDABLE_ROWS = 2000;

// Scrolls a scroller to a place, outside a component, which may not change what it is given.
const scrollTopTo = (scroller: HTMLElement, top: number) => {
  scroller.scrollTop = top;
};

/** The most frames a link's row is aligned again while the rows above it are measured. */
const SETTLE_FRAMES = 90;
/** Frames in a row the row must stay put before it counts as settled. */
const SETTLED_AFTER = 4;

/**
 * Keeps a row at the top of the scroller while the rows above it are measured: each measure moves
 * it by the difference from its estimate, so it is aligned again once a frame until it has stayed
 * put for a few frames. A wheel, a touch, a key or a press in the scroller stops it at once: the
 * person's own scroll always wins.
 */
const settleAt = (
  scroller: HTMLElement,
  align: () => void,
  startOf: () => number | undefined
) => {
  let stopped = false;
  let still = 0;
  let last: number | undefined;
  let left = SETTLE_FRAMES;
  let frame = 0;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    for (const type of [
      "wheel",
      "touchstart",
      "keydown",
      "pointerdown",
    ] as const) {
      scroller.removeEventListener(type, stop);
    }
  };
  for (const type of [
    "wheel",
    "touchstart",
    "keydown",
    "pointerdown",
  ] as const) {
    scroller.addEventListener(type, stop, { passive: true });
  }
  const step = () => {
    if (stopped) {
      return;
    }
    align();
    const now = startOf();
    still = now !== undefined && now === last ? still + 1 : 0;
    last = now;
    left -= 1;
    if (still >= SETTLED_AFTER || left <= 0) {
      stop();
      return;
    }
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return stop;
};

// Rows of one height, by arithmetic: what is rendered is worked out from the scroll position alone.
const FixedRows = ({
  scroller,
  count,
  estimate,
  initialRow,
  onRow,
  control,
  renderRow,
  overscan = 8,
  table = false,
  rowProps,
  rowStyle,
}: VirtualRowsProps) => {
  const box = useRef<HTMLElement | null>(null);
  const placeBox = (element: HTMLElement | null) => {
    box.current = element;
  };
  const height = Math.max(1, estimate(0));
  const [range, setRange] = useState<[number, number]>([0, 0]);

  // Which rows are near the screen: the box's own place in the scroller is read each time, as the
  // rows above it (a page's padding, a table's head) may change.
  const readFor = useEffectEvent((rowCount: number, rowHeight: number) => {
    const top = box.current
      ? box.current.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top
      : 0;
    const from = Math.max(0, Math.floor(-top / rowHeight) - overscan);
    const to = Math.min(
      rowCount,
      Math.ceil((scroller.clientHeight - top) / rowHeight) + overscan
    );
    setRange((was) => (was[0] === from && was[1] === to ? was : [from, to]));
  });
  const read = useEffectEvent(() => {
    readFor(count, height);
  });
  const report = useEffectEvent((row: number) => {
    onRow?.(row);
  });
  const topRow = useEffectEvent(() =>
    Math.min(count - 1, Math.floor((scroller.scrollTop + 1) / height))
  );

  useEffect(() => {
    let frame = 0;
    const scrolled = () => {
      if (frame) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        read();
        report(topRow());
      });
    };
    read();
    scroller.addEventListener("scroll", scrolled, { passive: true });
    const watcher = new ResizeObserver(() => {
      read();
    });
    watcher.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", scrolled);
      watcher.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scroller]);
  useEffect(() => {
    readFor(count, height);
  }, [count, height]);

  // A zoom: the row at the top stays at the top.
  const was = useRef(height);
  useEffect(() => {
    if (was.current === height) {
      return;
    }
    const top = Math.floor((scroller.scrollTop + 1) / was.current);
    was.current = height;
    scrollTopTo(scroller, top * height);
    report(top);
  }, [height, scroller]);

  // Open at the row a link names, once, the first time the rows are known.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || count === 0) {
      return;
    }
    opened.current = true;
    if (initialRow !== undefined && initialRow > 0 && initialRow < count) {
      scrollTopTo(scroller, initialRow * height);
    }
  }, [count, initialRow, height, scroller]);

  useImperativeHandle(
    control,
    () => ({
      scrollToRow: (row: number) => {
        scrollTopTo(scroller, Math.max(0, Math.min(count - 1, row)) * height);
      },
    }),
    [scroller, count, height]
  );

  const rows: ReactNode[] = [];
  const [from, to] = range;
  for (let index = from; index < to; index += 1) {
    rows.push(
      <Row
        key={index}
        table={table}
        index={index}
        start={index * height}
        attributes={rowProps?.(index)}
        look={rowStyle?.(index)}
      >
        {renderRow(index)}
      </Row>
    );
  }
  return (
    <Box table={table} size={count * height} place={placeBox}>
      {rows}
    </Box>
  );
};

type List = Pick<VirtualRowsProps, "count" | "estimate" | "findable">;
type Rows = ReturnType<typeof createVirtualizer>;

/** Brings a row to the top and keeps it there while the rows above it are measured. */
const bringRow = (
  rows: Rows,
  scroller: HTMLElement,
  count: number,
  settling: RefObject<(() => void) | null>,
  row: number
) => {
  settling.current?.();
  const index = Math.max(0, Math.min(count - 1, row));
  rows.scrollToIndex(index, { align: "start" });
  settling.current = settleAt(
    scroller,
    () => {
      rows.scrollToIndex(index, { align: "start" });
    },
    () => rows.items().find((item) => item.index === index)?.start
  );
};

const makeRows = (list: List, overscan: number) => ({
  list,
  rows: createVirtualizer({
    count: () => list.count,
    estimate: (index) => list.estimate(index),
    overscan,
    ...(list.findable === undefined
      ? {}
      : { findable: (index: number) => list.findable?.(index) ?? "" }),
  }),
});
// The virtualiser and its list, made once: nothing ever replaces them.
const keepRows = (made: ReturnType<typeof makeRows>) => made;
// The list the virtualiser reads, brought up to date by the component that draws it.
const keepList = (list: List, now: List) => {
  Object.assign(list, now);
};

const MeasuredRows = ({
  scroller,
  count,
  estimate,
  fixed = false,
  findable: findableProp,
  version,
  initialRow,
  onRow,
  control,
  renderRow,
  overscan = 8,
  table = false,
  rowProps,
  rowStyle,
}: VirtualRowsProps) => {
  const findable = count > FINDABLE_ROWS ? undefined : findableProp;
  // A virtualiser per list, made once: it reads the list through `list`, kept current below.
  const [{ rows, list }] = useReducer(keepRows, null, () =>
    makeRows({ count, estimate, findable }, overscan)
  );
  // The list as it is now, for the virtualiser, before the rows are drawn; a new count is read again.
  useLayoutEffect(() => {
    keepList(list, { count, estimate, findable });
  });
  const counted = useRef(count);
  useLayoutEffect(() => {
    if (counted.current === count) {
      return;
    }
    counted.current = count;
    rows.refresh();
  }, [rows, count]);
  const items = useSyncExternalStore(
    (listener) => rows.subscribe(listener),
    () => rows.items(),
    () => rows.items()
  );

  useEffect(
    () => rows.connect(scroller, { findable: findable !== undefined }),
    [rows, scroller, findable]
  );

  // The row at the top, as last read while scrolling. Not read again from the rows when the sizes
  // change: by then the rows not yet measured already have their new estimate, so the old scroll
  // position would name another row (a page wider by a scrollbar's width moved a link from page
  // 320 to 327 in WebKit).
  const atTop = useRef(initialRow ?? 0);
  const report = useEffectEvent((row: number) => {
    onRow?.(row);
  });

  // Brings a row to the top and keeps it there while the rows above it are measured.
  const settling = useRef<(() => void) | null>(null);
  const bring = useEffectEvent((row: number) => {
    bringRow(rows, scroller, count, settling, row);
  });
  useEffect(
    () => () => {
      settling.current?.();
    },
    []
  );

  // A zoom or a new list: every size changes. The row at the top stays at the top: scrolled back to
  // once the old sizes are forgotten.
  const sized = useRef({ version, count });
  useEffect(() => {
    if (
      Object.is(sized.current.version, version) &&
      sized.current.count === count
    ) {
      return;
    }
    sized.current = { version, count };
    const top = atTop.current;
    rows.reset();
    rows.refresh();
    if (top > 0) {
      bring(top);
      report(top);
    }
  }, [rows, version, count]);

  // Open at the row a link names, once, the first time the rows are known.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || count === 0) {
      return;
    }
    opened.current = true;
    if (initialRow !== undefined && initialRow > 0 && initialRow < count) {
      bring(initialRow);
    }
  }, [count, initialRow]);

  useImperativeHandle(
    control,
    () => ({
      scrollToRow: (row: number) => {
        bringRow(rows, scroller, count, settling, row);
      },
    }),
    [rows, scroller, count]
  );

  // The row at the top, as the viewport scrolls, at most once a frame.
  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      // A row with a few pixels left on screen is not the one at the top: measuring a row can
      // move the scroll by a pixel, rounded, and the link would name the row before.
      const top = scroller.scrollTop;
      const at = rows.items().find((item) => item.start + item.size > top + 4);
      if (!at) {
        return;
      }
      atTop.current = at.index;
      report(at.index);
    };
    const scrolled = () => {
      if (!frame) {
        frame = requestAnimationFrame(read);
      }
    };
    scroller.addEventListener("scroll", scrolled, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", scrolled);
      cancelAnimationFrame(frame);
    };
  }, [rows, scroller]);

  return (
    <Box table={table} size={rows.size()}>
      {items.map((item) => (
        <Row
          key={item.key}
          table={table}
          index={item.index}
          start={item.start}
          attributes={rowProps?.(item.index)}
          look={rowStyle?.(item.index)}
          measure={
            fixed ? undefined : (element) => rows.measure(item.index, element)
          }
        >
          {renderRow(item.index)}
        </Row>
      ))}
    </Box>
  );
};

/**
 * The rows. Fixed rows past FINDABLE_ROWS are placed by arithmetic (a row's start is its index
 * times its height), so a hundred thousand rows cost nothing to lay out; every other list uses UI
 * SDK's virtualiser, which measures rows and keeps them findable.
 */
export const VirtualRows = (props: VirtualRowsProps) =>
  props.fixed === true && props.count > FINDABLE_ROWS ? (
    <FixedRows {...props} />
  ) : (
    <MeasuredRows {...props} />
  );
