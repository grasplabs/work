// SourceList: the sources under an answer (sources.tsx). Folded, it is the pile (pile.tsx); open,
// a row per source (row.tsx), in order of relevance or grouped by kind, with a long list folded
// after a few rows. Opening carries each mark from the pile into its row in one short motion (a
// shared element, under 300ms); with reduced motion the list is simply there.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useLayoutEffect, useRef } from "react";

import { Button } from "../button";
import { focus } from "../focus/focus";
import { Toggle, ToggleGroup } from "../toggle";
import { useWords, withGiven } from "../words/words";
import { startList, useSources } from "./context";
import type { ListState, SourcesValue } from "./context";
import { SourcePile } from "./pile";
import { SourceRow } from "./row";
import { kindOf } from "./source";
import { sourceStyles as styles } from "./styles";
import type { Source, SourceKind } from "./types";
import { sourcesWords } from "./words";

/** Every prop a SourceList takes. */
export interface SourceListProps {
  /**
   * The words over the open list.
   * @default "Sources"
   */
  heading?: string;
  /**
   * The heading's level in the page's outline: one below the answer's own heading.
   * @default 3
   */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /**
   * Open at first, as a list; folded, it is the pile with the count and the kinds.
   * @default false
   */
  defaultOpen?: boolean;
  /**
   * How many rows show before "Show more" folds the rest.
   * @default 5
   */
  fold?: number;
}

type Order = ListState["order"];
interface Numbered {
  source: Source;
  n: number;
}

/** The rows, grouped by kind in the order each kind first appears. */
const groupsOf = (rows: readonly Numbered[]) => {
  const groups = new Map<SourceKind, Numbered[]>();
  for (const row of rows) {
    const kind = kindOf(row.source);
    groups.set(kind, [...(groups.get(kind) ?? []), row]);
  }
  return [...groups.entries()];
};

/** Carries each mark from where it stood in the pile to its row's tile: a shared element. */
const carry = (from: Map<number, DOMRect>, list: HTMLElement) => {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  for (const tile of list.querySelectorAll<HTMLElement>("[data-source-tile]")) {
    const start = from.get(Number(tile.dataset.sourceTile));
    if (start === undefined) {
      continue;
    }
    const end = tile.getBoundingClientRect();
    const scale = start.width / Math.max(end.width, 1);
    tile.animate(
      [
        {
          transform: `translate(${start.left - end.left}px, ${start.top - end.top}px) scale(${scale})`,
          transformOrigin: "top left",
        },
        { transform: "none", transformOrigin: "top left" },
      ],
      { duration: 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
  }
};

/** Where each of the pile's marks stands now, by its source's number. */
const marksIn = (pile: HTMLElement) =>
  new Map(
    [...pile.querySelectorAll<HTMLElement>("[data-pile-mark]")].map(
      (mark) =>
        [Number(mark.dataset.pileMark), mark.getBoundingClientRect()] as const
    )
  );

/** The rows, in order or grouped, folded after `fold`. */
const Rows = ({
  shared,
  order,
  fold,
  all,
}: {
  shared: SourcesValue;
  order: Order;
  fold: number;
  all: boolean;
}) => {
  const numbered = shared.sources.map((source, index) => ({
    source,
    n: index + 1,
  }));
  const shown = all ? numbered : numbered.slice(0, fold);
  if (order === "relevance") {
    return (
      <ol {...stylex.props(styles.list)}>
        {shown.map(({ source, n }) => (
          <SourceRow
            key={`${n}-${source.title}`}
            source={source}
            n={n}
            shared={shared}
          />
        ))}
      </ol>
    );
  }
  // Grouped, every source shows: a fold would hide whole kinds and make a group's count ("4 files")
  // disagree with the rows under it.
  return (
    <div {...stylex.props(styles.list)}>
      {groupsOf(numbered).map(([kind, rows]) => {
        const name = shared.labels.kind(kind, rows.length);
        return (
          <div key={kind} {...stylex.props(styles.group)}>
            {/* Seen, not said: the list under it carries the same words as its name, once. */}
            <p aria-hidden="true" {...stylex.props(styles.groupName)}>
              {name}
            </p>
            <ul aria-label={name} {...stylex.props(styles.list)}>
              {rows.map(({ source, n }) => (
                <SourceRow
                  key={`${n}-${source.title}`}
                  source={source}
                  n={n}
                  shared={shared}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
};

/** Where focus goes after the list changes: its heading, the pile, or a row. */
type Wanted = "heading" | "pile" | { row: string } | null;

/** An element by its id; ids from useId hold characters a selector must escape. */
const byId = (id: string) =>
  id === "" ? null : document.querySelector<HTMLElement>(`#${CSS.escape(id)}`);

/** Puts focus on a row: on its title where that is a link or a button, else on the row itself. */
const focusRow = (row: HTMLElement | null) => {
  if (row === null) {
    return;
  }
  (
    row.querySelector<HTMLElement>(
      ':is(a, button)[data-slot="source-title"]'
    ) ?? row
  ).focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
};

interface OpenListProps {
  shared: SourcesValue;
  heading: string;
  headingLevel: 2 | 3 | 4 | 5 | 6;
  headingId: string;
  fold: number;
  all: boolean;
  /** "Show more" or "Show fewer" was pressed. */
  onFold: () => void;
  /** "Fold them away" was pressed. */
  onClose: () => void;
}

/** The open list: its heading and order switch, its rows, and what folds it. */
const OpenList = ({
  shared,
  heading,
  headingLevel,
  headingId,
  fold,
  all,
  onFold,
  onClose,
}: OpenListProps) => {
  // The order is the list's shared state, so it is still the person's choice after a fold.
  const { sources, labels, setList } = shared;
  const { order } = shared.list;
  const Heading = `h${headingLevel}` as const;
  const rest = sources.length - fold;
  return (
    <>
      <div {...stylex.props(styles.head, styles.openHead)}>
        {/* The count as a figure: "Sources · 12", not the word said twice. */}
        <Heading
          id={headingId}
          tabIndex={-1}
          {...stylex.props(styles.heading, styles.headHeading, focus.inside)}
        >
          {heading} · {sources.length}
        </Heading>
        {/* The order, then the close, at the head's end. Narrow, the close stays on the heading's
            line and the order takes its own line under it, so nothing stands alone. */}
        <div {...stylex.props(styles.order)}>
          <ToggleGroup
            aria-label={labels.order}
            size="sm"
            value={[order]}
            onValueChange={(values: string[]) => {
              const [next] = values;
              if (next === "relevance" || next === "kind") {
                setList((now) => ({ ...now, order: next }));
              }
            }}
          >
            <Toggle value="relevance">{labels.byRelevance}</Toggle>
            <Toggle value="kind">{labels.byKind}</Toggle>
          </ToggleGroup>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {labels.close}
        </Button>
      </div>
      <Rows shared={shared} order={order} fold={fold} all={all} />
      {/* The foot is there only for "Show more" or "Show fewer": never an empty row. */}
      {rest > 0 && order === "relevance" && (
        <div {...stylex.props(styles.foot)}>
          <Button variant="ghost" size="sm" onClick={onFold}>
            {all ? labels.showFewer : labels.showMore(rest)}
          </Button>
        </div>
      )}
    </>
  );
};

/** The list of sources, numbered as their markers are: the pile, or the open list. */
export const SourceList = ({
  heading: headingGiven,
  headingLevel = 3,
  defaultOpen = false,
  fold = 5,
}: SourceListProps) => {
  const { heading } = withGiven(useWords("sources", sourcesWords), {
    heading: headingGiven,
  });
  const shared = useSources();
  const state = shared?.list ?? startList;
  const open = state.opened ?? defaultOpen;
  // A marker pressed for a row past the fold unfolds the list, so its row is there to go to.
  const all = state.all || (state.target !== null && state.target.n > fold);
  // Where the pile's marks stood when it was pressed: read once, in the layout effect after it opens.
  const from = useRef<Map<number, DOMRect> | null>(null);
  const list = useRef<HTMLElement>(null);
  // Where focus goes once the change a press asked for is drawn: set by the press, read after it.
  const wanted = useRef<Wanted>(null);
  const baseId = shared?.rowId(0) ?? "";
  const headingId = `${baseId}-heading`;
  const pileId = `${baseId}-pile`;
  const turn = state.target?.turn ?? 0;
  const targetId =
    state.target === null || shared === null
      ? ""
      : shared.rowId(state.target.n);
  useLayoutEffect(() => {
    if (!open || from.current === null || list.current === null) {
      return;
    }
    carry(from.current, list.current);
    from.current = null;
  }, [open]);
  // Focus never falls back to the page: opening puts it on the list's heading, folding on the
  // pile, and "Show more" on the first row it brought.
  useEffect(() => {
    const want = wanted.current;
    wanted.current = null;
    if (want === "heading") {
      byId(headingId)?.focus({ preventScroll: true });
    } else if (want === "pile") {
      byId(pileId)?.focus({ preventScroll: true });
    } else if (want !== null) {
      focusRow(byId(want.row));
    }
    // After every draw: what a press asked for is there only once the list has changed.
  });
  // A marker's press: once the list is open and unfolded far enough, focus goes to its row.
  useEffect(() => {
    if (turn > 0) {
      focusRow(byId(targetId));
      // The address says which row, as the marker's link would have: a link to it comes back here.
      window.history.replaceState(window.history.state, "", `#${targetId}`);
    }
  }, [turn, targetId]);
  if (shared === null) {
    return null;
  }
  const { setList, rowId } = shared;
  if (!open) {
    return (
      <SourcePile
        shared={shared}
        id={pileId}
        onOpen={(pile) => {
          from.current = marksIn(pile);
          wanted.current = "heading";
          setList((now) => ({ ...now, opened: true }));
        }}
      />
    );
  }
  return (
    <section
      ref={list}
      aria-labelledby={headingId}
      data-slot="source-list"
      {...stylex.props(styles.section)}
    >
      <OpenList
        shared={shared}
        heading={heading}
        headingLevel={headingLevel}
        headingId={headingId}
        fold={fold}
        all={all}
        onFold={() => {
          // More: focus goes to the first row it brings. Fewer: the button stays where focus is.
          wanted.current = all ? null : { row: rowId(fold + 1) };
          setList((now) => ({ ...now, all: !all, target: null }));
        }}
        onClose={() => {
          wanted.current = "pile";
          setList((now) => ({ ...now, opened: false }));
        }}
      />
    </section>
  );
};
