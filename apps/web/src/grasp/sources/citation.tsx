// Citation: a marker in an answer (sources.tsx), a number or a named chip. Resting on it or focusing
// it shows its source's card (card.tsx) in Hover card's panel, from the marker, on a solid ground
// that never fades, since it opens over the answer's next line; pressing it
// goes to the source's row. The marker, its row and the words it backs (Claim) light each other.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  HoverCardContent as ContentPrimitive,
  HoverCard as HoverCardPrimitive,
  HoverCardTrigger as TriggerPrimitive,
} from "@ui-sdk/react/hover-card";
import { useEffect, useState } from "react";
import type { MouseEvent } from "react";

import { focus } from "../focus/focus";
import { hoverCardStyles } from "../hover-card/styles";
// UI SDK places a popup in pixels: popover-gap and popup-gutter, as the generator writes them.
import { popup } from "../tokens/tokens.values";
import { SourceCard } from "./card";
import { registerMark, useSources } from "./context";
import type { SourcesValue } from "./context";
import { accessOf } from "./source";
import { sourceStyles as styles } from "./styles";
import type { Source } from "./types";

/** Every prop a Citation takes. */
export interface CitationProps {
  /** The source's number: its place in the Sources' `items`, from 1. */
  n: number;
}

/** A word joiner: the marker stays on the line of the word before it. */
const join = "⁠";

/**
 * Where the open card is drawn: the block that holds the answer's paragraph, not the paragraph,
 * whose words cannot hold the card's rows, table or code. Still inside the answer, so it keeps the
 * answer's colour scheme (a night ground). Nothing until it opens, which is only in the browser.
 */
const layerFor = (element: HTMLElement | null, open: boolean) =>
  open && element !== null
    ? (element.closest("p")?.parentElement ??
      element.parentElement ??
      undefined)
    : undefined;

/**
 * The side the card opens on: under the marker, unless its row's title is in view below it, where
 * the card would hide the very row it lights (on a phone the list follows the answer closely). Then
 * it opens above, and Hover card flips it back under when there is no room above. Read as it opens,
 * so it never moves once shown.
 */
const sideFor = (
  marker: HTMLElement | null,
  rowId: string
): "top" | "bottom" => {
  const row =
    marker === null
      ? null
      : marker.ownerDocument.querySelector(`#${CSS.escape(rowId)}`);
  const title = row?.querySelector("[data-slot=source-title]") ?? row;
  if (
    marker === null ||
    title === null ||
    title === undefined ||
    title.getClientRects().length === 0
  ) {
    return "bottom";
  }
  const from = marker.getBoundingClientRect();
  const to = title.getBoundingClientRect();
  const view = marker.ownerDocument.documentElement.clientHeight;
  return to.top >= from.bottom && to.top < view ? "top" : "bottom";
};

/** The marker's name: the source and, for a second mention of it, which mention it is. */
const nameOf = (
  shared: SourcesValue,
  n: number,
  source: Source,
  element: HTMLElement | null
) => {
  const { index, count } = shared.place(n, element);
  const mention =
    count > 1 && index > 0 ? `, ${shared.labels.mention(index)}` : "";
  const access = accessOf(source);
  const said =
    access === "gone" ? shared.labels.goneInName : shared.labels.lockedInName;
  const closed = access === "open" ? "" : `, ${said}`;
  return `${shared.labels.source(n)}${mention}: ${source.title}${closed}`;
};

/**
 * The marker. Its name says the source ("Source 1: Churn report, Q3"); when the answer cites one
 * source more than once, each says which mention it is ("Source 1, second mention: ..."), so an
 * agent or a screen reader can tell them apart.
 */
/**
 * One Escape does one thing (the product's row 52): while a card is open, an Escape is heard first,
 * on the window as it starts down, closes the card and goes no further. Returns the cleanup.
 */
const escapeFirst = (close: () => void) => {
  const onKey = (event: globalThis.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };
  window.addEventListener("keydown", onKey, true);
  return () => {
    window.removeEventListener("keydown", onKey, true);
  };
};

export const Citation = ({ n }: CitationProps) => {
  const shared = useSources();
  const source = shared?.sources[n - 1];
  const [element, setElement] = useState<HTMLElement | null>(null);
  // The card is drawn only while open. It opens in the browser, where it goes to a layer of its
  // own, so its blocks (rows, a table, code) never stand inside the answer's paragraph.
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"top" | "bottom">("bottom");
  // The setter is the same on every render, so this runs only when the marker or its number changes.
  const setMarks = shared?.setMarks;
  useEffect(
    () =>
      element !== null && setMarks !== undefined
        ? registerMark(setMarks, n, element)
        : undefined,
    [element, setMarks, n]
  );
  // While the card is open, Escape closes it and goes no further, however the card was opened
  // (the pointer, the keys): no listener of the host's on the document hears it and closes more.
  const lightOff = shared?.setActive;
  useEffect(
    () =>
      open
        ? escapeFirst(() => {
            setOpen(false);
            lightOff?.(null, "hover");
          })
        : undefined,
    [open, lightOff]
  );
  if (shared === null || source === undefined) {
    // Outside a Sources, or a number past its list: still the number, so the answer reads the
    // same; it previews nothing.
    return (
      <>
        {join}
        <span {...stylex.props(styles.marker, styles.numberBox)}>{n}</span>
      </>
    );
  }
  const { active, setActive, rowId, labels, onOpen } = shared;
  return (
    <>
      {join}
      <HoverCardPrimitive
        open={open}
        delay={300}
        container={layerFor(element, open)}
        onOpenChange={(next: boolean) => {
          if (next) {
            setSide(sideFor(element, rowId(n)));
          }
          setOpen(next);
          setActive(next ? n : null, "hover");
        }}
      >
        <TriggerPrimitive
          href={`#${rowId(n)}`}
          ref={setElement}
          aria-label={nameOf(shared, n, source, element)}
          data-slot="citation"
          data-form="number"
          onClick={(event: MouseEvent<HTMLElement>) => {
            // A plain press goes to the source's row, wherever it is: the list opens if it is
            // folded into the pile, and unfolds if the row is past its fold. With a modifier the
            // browser does what it does with a link.
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            ) {
              return;
            }
            event.preventDefault();
            shared.setList((now) => ({
              ...now,
              opened: true,
              target: { n, turn: (now.target?.turn ?? 0) + 1 },
            }));
          }}
          onFocus={() => {
            setActive(n, "focus");
          }}
          onBlur={() => {
            setActive(null, "focus");
          }}
          {...stylex.props(
            styles.marker,
            styles.numberBox,
            active === n && styles.markerLit,
            focus.ring
          )}
        >
          <span aria-hidden="true" {...stylex.props(styles.markerTarget)} />
          {n}
        </TriggerPrimitive>
        {open ? (
          <ContentPrimitive
            side={side}
            align="start"
            sideOffset={popup.popoverGap}
            collisionPadding={popup.gutter}
            {...stylex.props(hoverCardStyles.panel, styles.cardGround)}
          >
            <SourceCard
              source={source}
              labels={labels}
              onOpen={
                onOpen === undefined
                  ? undefined
                  : () => {
                      onOpen(source, n - 1);
                    }
              }
            />
          </ContentPrimitive>
        ) : null}
      </HoverCardPrimitive>
    </>
  );
};
