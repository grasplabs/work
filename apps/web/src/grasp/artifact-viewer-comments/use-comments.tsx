// Comments, for the shell: where each thread's words are now, the tint on them, a selection becoming
// a comment, the jumps from one comment to the next, and the panel. The format decides what a
// comment holds on to (anchor.ts); the page's runs of words (dom.ts) connect a selection to the text
// and the text back to the page.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { RefObject } from "react";

import {
  decodeAnchor,
  encodeAnchor,
  pdfAnchor,
  resolveCell,
  textAnchor,
} from "../artifact-viewer/anchor";
import type { Anchor, Found, TableShape } from "../artifact-viewer/anchor";
import {
  centreIn,
  domRangesOf,
  eachFrameUntil,
  runsIn,
  setHighlight,
  textPointAt,
  textRangeOf,
} from "../artifact-viewer/dom";
import type {
  AnchorKind,
  CommentsApi,
  CommentsOptions,
  PlacedThread,
} from "../artifact-viewer/extras";
import type {
  ArtifactViewerLabels,
  DrawnNote,
  RendererControl,
} from "../artifact-viewer/types";
import { runTask } from "../artifact-viewer/worker/client";
import { Button } from "../button/button";
import { useAction } from "../button/use-action";
import { CommentAdd, Link } from "../icons";
import { grasp } from "../tokens/tokens.stylex";
import { CommentsPanel } from "./comments";

const styles = stylex.create({
  // The small bar by a selection: Comment, and Copy link. Over the document, on the medium lift.
  // Placed by the selection's own place on the screen, so from the physical top left; it moves by
  // its transform, set as the document scrolls, without drawing the viewer again.
  floating: {
    position: "absolute",
    left: 0,
    top: 0,
    zIndex: 4,
    display: "flex",
    gap: grasp.space1,
    padding: grasp.space1,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    boxShadow: grasp.liftMedium,
  },
  note: {
    margin: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.muted,
  },
});

const quoteOfAnchor = (anchor: Anchor, labels: ArtifactViewerLabels) => {
  if (anchor.kind === "text" || anchor.kind === "pdf") {
    return anchor.quote.exact;
  }
  if (anchor.kind === "cell") {
    return (
      anchor.quote ??
      labels.cellQuote(anchor.row, anchor.column + 1, anchor.header)
    );
  }
  return labels.boxQuote;
};

const compare = (a: number[], b: number[]) => {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) {
      return difference;
    }
  }
  return 0;
};

// A text anchor, as a key: the same words in the same place are the same anchor.
const keyOf = (anchor: {
  quote: { prefix: string; exact: string; suffix: string };
  position: { start: number; end: number };
}) =>
  `${anchor.position.start}:${anchor.position.end}:${anchor.quote.prefix}\u0001${anchor.quote.exact}\u0001${anchor.quote.suffix}`;

type Entry = PlacedThread & {
  part: number;
  start: number;
  end: number;
  row: number;
  column: number;
  pending: boolean;
};

// In the order of the file; orphans last.
const byOrder = (a: Entry, b: Entry) => {
  if (a.order !== null && b.order !== null) {
    return compare(a.order, b.order);
  }
  if (a.order !== null) {
    return -1;
  }
  if (b.order !== null) {
    return 1;
  }
  return 0;
};

const isElement = (node: Node): node is Element =>
  node.nodeType === Node.ELEMENT_NODE;
// The element a node is, or is in.
const elementAt = (node: Node) => (isElement(node) ? node : node.parentElement);

// Where a thread's place is on the page, once drawn: its cell, its box, or its words.
const targetOf = (scroller: HTMLElement, entry: Entry) => {
  const { anchor } = entry.thread;
  if (anchor.kind === "cell") {
    return scroller.querySelector(
      `[data-key="${CSS.escape(anchor.row)}"] [data-column="${entry.column}"]`
    );
  }
  if (anchor.kind === "rect") {
    return scroller.querySelector(
      `[data-thread="${CSS.escape(entry.thread.id)}"]`
    );
  }
  return domRangesOf(runsIn(scroller), entry.part, entry.start, entry.end)[0]
    ?.startContainer.parentElement;
};

// Whether the file and its words are there to select a place in (a web page's preview has none).
const readyFor = (
  kind: AnchorKind,
  source: string | undefined,
  table: TableShape | null
) =>
  kind !== "none" &&
  !(kind === "text" && source === undefined) &&
  !(kind === "cell" && table === null);

// A place a link names, as an entry to bring into view.
const linkedEntry = (anchor: Anchor, table: TableShape | null): Entry => ({
  thread: { id: "", anchor, items: [] },
  quote: "",
  order: [0],
  part: anchor.kind === "pdf" ? anchor.page : 0,
  start:
    anchor.kind === "text" || anchor.kind === "pdf" ? anchor.position.start : 0,
  end:
    anchor.kind === "text" || anchor.kind === "pdf" ? anchor.position.end : 0,
  row:
    anchor.kind === "cell" && table !== null
      ? table.keys.indexOf(anchor.row)
      : -1,
  column: anchor.kind === "cell" ? anchor.column : -1,
  pending: false,
});

// Selects a place's words, once they are drawn: false until they are.
const selectWords = (scroller: HTMLElement, entry: Entry) => {
  const { anchor } = entry.thread;
  const ranges =
    anchor.kind === "text" || anchor.kind === "pdf"
      ? domRangesOf(runsIn(scroller), entry.part, entry.start, entry.end)
      : [];
  const [first] = ranges;
  const last = ranges.at(-1);
  if (first === undefined || last === undefined) {
    return false;
  }
  const whole = document.createRange();
  whole.setStart(first.startContainer, first.startOffset);
  whole.setEnd(last.endContainer, last.endOffset);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(whole);
  return true;
};

// The next frame, once the link has been written into the address.
const nextFrame = async () => {
  // oxlint-disable-next-line promise/avoid-new -- a frame has no promise of its own
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
};

// The clean-up of an effect that started nothing.
const idle = () => {
  // Nothing to stop.
};

// An answer that comes later: a promise, or anything with a then.
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" && value !== null && "then" in value;

// A place a link names, or null when it does not read. Outside the hook: the compiler takes no
// try in a component or hook.
const readAnchor = (
  code: string,
  against: Parameters<typeof decodeAnchor>[1]
): Anchor | null => {
  try {
    return decodeAnchor(code, against);
  } catch {
    return null;
  }
};

// What a ref given in the hook's options holds now, read outside render: the viewer's root and the
// renderer's control are refs the caller owns.
const elementOf = (ref: RefObject<HTMLElement | null>) => ref.current;
const scrollRowOf = (
  control: RefObject<RendererControl | null>,
  row: number
) => {
  control.current?.scrollToRow(row);
};

/** The answers the Worker gave: where a thread's words are in a version of the text. */
type Answers = ReadonlyMap<string, { text: string; place: Found | null }>;

// Where each thread is now, in order, and the threads whose words must be looked for, by part.
const placeThreads = (
  {
    threads,
    kind,
    source,
    pages,
    table,
    labels,
  }: Pick<
    CommentsOptions,
    "threads" | "kind" | "source" | "pages" | "table" | "labels"
  >,
  found: Answers
) => {
  const wanted = new Map<
    number,
    {
      text: string;
      anchors: Map<string, { quote: Anchor & { kind: "text" | "pdf" } }>;
    }
  >();
  if (!threads) {
    const none: Entry[] = [];
    return { placed: none, missing: wanted };
  }
  const list = threads.map((thread): Entry => {
    const { anchor } = thread;
    const base: Entry = {
      thread,
      quote: quoteOfAnchor(anchor, labels),
      order: null,
      part: 0,
      start: -1,
      end: -1,
      row: -1,
      column: -1,
      pending: false,
    };
    if (
      (anchor.kind === "text" && (kind === "text" || kind === "none")) ||
      (anchor.kind === "pdf" && kind === "pdf")
    ) {
      const part = anchor.kind === "pdf" ? anchor.page : 0;
      const words = anchor.kind === "pdf" ? pages[part] : source;
      // A PDF page not read yet, or words being looked for: listed in their old place, not marked.
      const waiting = {
        ...base,
        part,
        order: [part, anchor.position.start],
        pending: true,
      };
      if (words === undefined) {
        return waiting;
      }
      const { position, quote } = anchor;
      if (words.slice(position.start, position.end) === quote.exact) {
        return {
          ...base,
          part,
          order: [part, position.start],
          start: position.start,
          end: position.end,
        };
      }
      const key = `${part}\u0000${keyOf(anchor)}`;
      const answer = found.get(key);
      if (answer?.text !== words) {
        const group = wanted.get(part) ?? { text: words, anchors: new Map() };
        group.anchors.set(key, { quote: anchor });
        wanted.set(part, group);
        return waiting;
      }
      const { place } = answer;
      return place
        ? {
            ...base,
            part,
            quote: words.slice(place.start, place.end),
            order: [part, place.start],
            start: place.start,
            end: place.end,
          }
        : base;
    }
    if (anchor.kind === "cell" && kind === "cell" && table) {
      const place = resolveCell(anchor, table);
      return place
        ? {
            ...base,
            order: [place.row, place.column],
            row: place.row,
            column: place.column,
          }
        : base;
    }
    if (anchor.kind === "rect" && kind === "rect") {
      return { ...base, order: [anchor.y, anchor.x] };
    }
    return base;
  });
  list.sort(byOrder);
  return { placed: list, missing: wanted };
};

// The threads whose words are tinted in the text: those placed, in a file of words.
const markedOf = (visible: readonly Entry[], kind: CommentsOptions["kind"]) =>
  kind === "text" || kind === "pdf"
    ? visible.filter(
        (entry) =>
          entry.order !== null && entry.start >= 0 && entry.end > entry.start
      )
    : [];

export const useComments = (options: CommentsOptions): CommentsApi => {
  const {
    threads,
    kind,
    source,
    pages,
    table,
    scroller,
    root,
    control,
    active,
    setActive,
    open,
    setOpen,
  } = options;
  const on = threads !== undefined;
  const [showResolved, setShowResolved] = useState(false);
  const [draft, setDraft] = useState<{
    anchor: Anchor;
    quote: string;
    from: Element | null;
  } | null>(null);
  const [chosen, setChosen] = useState<Anchor | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const { say, onDelete, onShowCode, labels } = options;

  // Where each thread is now. Its old place is checked here, at once; a thread whose words moved is
  // looked for in the Worker, all such threads in one task, and remembered for this version of the
  // text, so a reply or a resolve does not search again. Until it is found it waits in its old place.
  // Each answer is kept with the text it was found in: a new version of the text asks again.
  const [found, setFound] = useState<Answers>(() => new Map());
  const { placed, missing } = placeThreads(
    { threads, kind, source, pages, table, labels },
    found
  );

  // The threads looked for, as one key: the Worker is asked once for each new set, not on every
  // drawing of the list.
  const missingKey = [...missing]
    .map(
      ([part, group]) =>
        `${part}:${group.text.length}:${[...group.anchors.keys()].join("\u0002")}`
    )
    .join("\u0003");
  const askWorker = useEffectEvent(() => missing);
  useEffect(() => {
    // Nothing to look for.
    if (missingKey === "") {
      return idle;
    }
    const run = { live: true };
    for (const [, group] of askWorker()) {
      const keys = [...group.anchors.keys()];
      const anchors = [...group.anchors.values()].map(({ quote }) => ({
        quote: quote.quote,
        position: quote.position,
      }));
      void (async () => {
        const results = await runTask({
          kind: "resolve",
          text: group.text,
          anchors,
        });
        if (!run.live) {
          return;
        }
        setFound((was) => {
          const next = new Map(was);
          for (const [index, key] of keys.entries()) {
            next.set(key, { text: group.text, place: results[index] ?? null });
          }
          return next;
        });
      })();
    }
    return () => {
      run.live = false;
    };
  }, [missingKey]);

  const visible = placed.filter(
    (entry) => showResolved || entry.thread.resolved !== true
  );

  // The tint on every thread's words in rows near the screen, drawn again as rows come and go.
  const marked = markedOf(visible, kind);
  useEffect(() => {
    if (!scroller || !on) {
      return idle;
    }
    let frame = 0;
    const draw = () => {
      frame = 0;
      const runs = runsIn(scroller);
      const normal: Range[] = [];
      const strong: Range[] = [];
      for (const entry of marked) {
        (entry.thread.id === active ? strong : normal).push(
          ...domRangesOf(runs, entry.part, entry.start, entry.end)
        );
      }
      setHighlight("viewer-comment", options.viewer, normal);
      setHighlight("viewer-comment-active", options.viewer, strong);
    };
    const later = () => {
      if (!frame) {
        frame = requestAnimationFrame(draw);
      }
    };
    draw();
    const watcher = new MutationObserver(later);
    watcher.observe(scroller, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      watcher.disconnect();
      cancelAnimationFrame(frame);
      setHighlight("viewer-comment", options.viewer, []);
      setHighlight("viewer-comment-active", options.viewer, []);
    };
  }, [scroller, marked, active, on, options.viewer]);

  // The table's cells and the image's boxes, which their renderers mark themselves.
  const notes: DrawnNote[] =
    kind === "cell" || kind === "rect"
      ? visible
          .filter((entry) => entry.order)
          .map((entry) => ({
            id: entry.thread.id,
            anchor: entry.thread.anchor,
            active: entry.thread.id === active,
          }))
      : [];

  // Where the selection began, in the text, while its start was in the file's words: a long
  // selection keeps its start when the row it began in leaves the page as the document scrolls.
  const began = useRef<{ node: Node; part: number; start: number } | null>(
    null
  );

  // An anchor from a range on the page: a cell's, or a piece of the text.
  const anchorOf = (range: Range): Anchor | null => {
    if (!scroller) {
      return null;
    }
    if (kind === "cell") {
      const cell = elementAt(range.startContainer)?.closest<HTMLElement>(
        "[data-column]"
      );
      const key = cell?.closest<HTMLElement>("[data-key]")?.dataset.key;
      if (!cell || key === undefined || !scroller.contains(cell)) {
        return null;
      }
      return {
        kind: "cell",
        row: key,
        column: Number(cell.dataset.column),
        header: cell.dataset.header,
        quote: cell.textContent ?? "",
      };
    }
    const place = textRangeOf(range, scroller, began.current);
    if (!place) {
      return null;
    }
    if (kind === "text" && source !== undefined) {
      return textAnchor(source, place.start, place.end);
    }
    const words = pages[place.part];
    if (kind === "pdf" && words !== undefined) {
      return pdfAnchor(place.part, words, place.start, place.end);
    }
    return null;
  };

  // A selection in the file: the bar with Comment and Copy link appears by it. Its place is set on
  // the bar itself as the document scrolls; only showing or hiding it draws the viewer again.
  const place = useEffectEvent(() => {
    const element = bar.current;
    const chosenNow = document.getSelection();
    const box = elementOf(root)?.getBoundingClientRect();
    if (!element || !box || chosenNow === null || chosenNow.rangeCount === 0) {
      return;
    }
    const rects = chosenNow.getRangeAt(0).getClientRects();
    const last = [...rects].at(-1);
    if (!last) {
      return;
    }
    // By the end of the selection, kept inside the viewer: the bar is about 230px wide.
    const x = Math.max(
      4,
      Math.min(box.width - 236, last.right - box.left - 40)
    );
    const y = Math.min(box.height - 48, last.bottom - box.top + 6);
    element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    element.style.pointerEvents = "";
  });
  // The anchor of a range, for what hears the selection: with the words as they are now.
  const anchorNow = useEffectEvent(anchorOf);
  useEffect(() => {
    if (!on || !scroller || kind === "rect" || kind === "none") {
      return idle;
    }
    let frame = 0;
    const read = () => {
      frame = 0;
      const selection = document.getSelection();
      const range =
        selection && selection.rangeCount && !selection.isCollapsed
          ? selection.getRangeAt(0)
          : null;
      if (!range || !scroller.contains(range.commonAncestorContainer)) {
        began.current = null;
        setChosen(null);
        return;
      }
      // Where it began, while that is still in the file's words.
      const start = range.startContainer;
      const inWords = elementAt(start)?.closest("[data-offset]");
      if (inWords && scroller.contains(inWords)) {
        const at = textRangeOf(range, scroller, null);
        if (at) {
          began.current = { node: start, part: at.part, start: at.start };
        }
      }
      const anchor = anchorNow(range);
      setChosen((was) =>
        anchor && was && encodeAnchor(was) === encodeAnchor(anchor)
          ? was
          : anchor
      );
      place();
    };
    const changed = () => {
      if (!frame) {
        frame = requestAnimationFrame(read);
      }
    };
    const moved = () => {
      place();
    };
    // A new selection begins: the bar of the last one lets the pointer through at once, and goes.
    // WebKit says the selection changed late, and a drag that ended over the old bar took it into
    // the selection, so the words chosen were not the file's alone.
    const pressed = () => {
      if (bar.current) {
        bar.current.style.pointerEvents = "none";
      }
      setChosen(null);
    };
    document.addEventListener("selectionchange", changed);
    scroller.addEventListener("scroll", moved, { passive: true });
    scroller.addEventListener("pointerdown", pressed);
    return () => {
      document.removeEventListener("selectionchange", changed);
      scroller.removeEventListener("scroll", moved);
      scroller.removeEventListener("pointerdown", pressed);
      cancelAnimationFrame(frame);
    };
  }, [on, scroller, kind]);
  useEffect(() => {
    if (chosen) {
      place();
    }
  }, [chosen]);
  // The selection gone: the place it gave the link goes too. (Only once it has been selected: a
  // place from a link is selected a moment after the viewer opens.)
  const shared = useRef(false);
  const held = useRef(false);
  useEffect(() => {
    if (chosen) {
      held.current = true;
    } else if (shared.current && held.current) {
      shared.current = false;
      held.current = false;
      options.setLinked(undefined);
    }
  }, [chosen, options]);

  const startDraft = (anchor: Anchor) => {
    const inside =
      document.activeElement !== null &&
      elementOf(root)?.contains(document.activeElement) === true;
    const from = inside ? document.activeElement : scroller;
    setDraft({ anchor, quote: quoteOfAnchor(anchor, labels), from });
    setOpen(true);
    setChosen(null);
  };

  /** `c`: the selection, or else the match find is on. */
  const commentHere = () => {
    if (!on || !scroller) {
      return;
    }
    // The selection as it is now: the one kept in state is read a frame after the browser says it
    // changed, and WebKit says so late, so a quick c after a drag found nothing chosen yet.
    const selection = document.getSelection();
    const live =
      selection && selection.rangeCount && !selection.isCollapsed
        ? selection.getRangeAt(0)
        : null;
    const now =
      live && scroller.contains(live.commonAncestorContainer)
        ? anchorOf(live)
        : null;
    const target = now ?? chosen;
    if (target !== null) {
      startDraft(target);
      return;
    }
    // On an image with nothing drawn: the whole image.
    if (kind === "rect") {
      startDraft({ kind: "rect", x: 0, y: 0, w: 1, h: 1 });
      return;
    }
    const mark = options.findOpen
      ? scroller.querySelector('mark[data-match="current"]')
      : null;
    if (mark) {
      const range = document.createRange();
      range.selectNodeContents(mark);
      const anchor = anchorOf(range);
      if (anchor) {
        startDraft(anchor);
        return;
      }
    }
    setOpen(true);
    say(kind === "none" ? labels.commentsInCode : labels.selectToComment);
  };

  // Brings a thread's place into view. Its row first, then (once drawn) its words.
  const { rowOf } = options;
  const reveal = (entry: Entry) => {
    if (!scroller || !entry.order) {
      return;
    }
    const { anchor } = entry.thread;
    if (anchor.kind === "cell" && entry.row >= 0) {
      scrollRowOf(control, Math.max(0, entry.row - 2));
    } else if (anchor.kind === "pdf") {
      scrollRowOf(control, anchor.page);
    } else if (anchor.kind === "text" && rowOf && entry.start >= 0) {
      scrollRowOf(control, Math.max(0, rowOf(0, entry.start) - 1));
    }
    const settle = () => {
      const target = targetOf(scroller, entry);
      if (!target) {
        return false;
      }
      centreIn(scroller, target);
      return true;
    };
    eachFrameUntil(settle, 40);
  };

  // The thread whose words were last brought into view: a thread opened by a link, or by Back and
  // Forward, is brought into view too, once its words are known.
  const revealed = useRef<string | null>(null);
  const openThread = (id: string, how: "push" | "replace" = "push") => {
    const entry = placed.find((candidate) => candidate.thread.id === id);
    setActive(id, how);
    setOpen(true);
    if (entry && !entry.pending) {
      revealed.current = id;
      reveal(entry);
    }
  };
  // The same two, for effects: as they are now, and no reason of their own to run one again.
  const revealNow = useEffectEvent(reveal);
  const openNow = useEffectEvent((id: string) => {
    openThread(id);
  });
  useEffect(() => {
    if (
      !on ||
      active === null ||
      active === "" ||
      revealed.current === active
    ) {
      return;
    }
    const entry = placed.find((candidate) => candidate.thread.id === active);
    // Not a thread here (a stale link): it is let go, quietly, and the link forgets it.
    if (!entry) {
      if (threads.length > 0) {
        setActive(null, "replace");
      }
      return;
    }
    if (entry.pending) {
      return;
    }
    revealed.current = active;
    setOpen(true);
    revealNow(entry);
  }, [on, active, placed, setOpen, setActive, threads]);

  // ] and [: the next and previous comment in the file, its words brought into view.
  const step = (direction: 1 | -1) => {
    const list = visible.filter((entry) => entry.order);
    if (!list.length) {
      say(labels.noCommentsToGo);
      return;
    }
    const at = list.findIndex((entry) => entry.thread.id === active);
    const first = direction > 0 ? 0 : list.length - 1;
    const next =
      list[at === -1 ? first : (at + direction + list.length) % list.length];
    if (next === undefined) {
      return;
    }
    openThread(next.thread.id);
    say(labels.commentAt(list.indexOf(next) + 1, list.length, next.quote));
  };

  // A click on tinted words opens their thread: the shortest of those under it, when they overlap.
  useEffect(() => {
    if (!on || !scroller || (kind !== "text" && kind !== "pdf")) {
      return idle;
    }
    const clicked = (event: MouseEvent) => {
      if (document.getSelection()?.isCollapsed !== true) {
        return;
      }
      const point = textPointAt(event.clientX, event.clientY, scroller);
      if (!point) {
        return;
      }
      const hits = marked.filter(
        (entry) =>
          entry.part === point.part &&
          entry.start <= point.offset &&
          point.offset < entry.end
      );
      const [hit] = hits.toSorted(
        (a, b) => a.end - a.start - (b.end - b.start)
      );
      if (hit) {
        openNow(hit.thread.id);
      }
    };
    scroller.addEventListener("click", clicked);
    return () => {
      scroller.removeEventListener("click", clicked);
    };
  }, [on, scroller, kind, marked]);

  // A link that names a place selects it, once, as the viewer opens and the file's words are known.
  // A link that does not read is let go, quietly, and the link forgets it.
  const linkedDone = useRef(false);
  useEffect(() => {
    const code = options.initialLinked;
    if (linkedDone.current || code === undefined || code === "" || !scroller) {
      return;
    }
    // Not before the file and its words are there (a web page's preview has none to select).
    if (!readyFor(kind, source, table)) {
      return;
    }
    const anchor = readAnchor(code, {
      text: source,
      pageText: (page) => pages[page],
      head: table?.head,
    });
    if (anchor && anchor.kind === "pdf" && pages[anchor.page] === undefined) {
      return;
    }
    linkedDone.current = true;
    if (!anchor) {
      options.setLinked(undefined);
      return;
    }
    const entry = linkedEntry(anchor, table);
    revealNow(entry);
    shared.current = true;
    held.current = false;
    // Selected, once its words are drawn: the bar to comment on it appears.
    eachFrameUntil(() => selectWords(scroller, entry), 40);
  }, [options, kind, scroller, source, pages, table]);

  // Copy link is the library's one copy action (button/use-action, as button/copy): the same tick
  // for the same hold, its words said once. The link is written into the address on the next frame,
  // then copied; when the browser will not copy, the link is still in the address bar.
  const copyLink = useAction(
    async (anchor: Anchor) => {
      shared.current = true;
      held.current = true;
      options.setLinked(encodeAnchor(anchor));
      await nextFrame();
      await navigator.clipboard.writeText(window.location.href);
    },
    { done: labels.linkCopied, failed: labels.linkNotCopied }
  );

  // Focus after a comment is sent: on its thread, once the caller has added it.
  const focusNext = useRef<{
    id?: string;
    anchor?: string;
    ids: Set<string>;
  } | null>(null);
  useEffect(() => {
    const wanted = focusNext.current;
    if (!wanted || !threads) {
      return;
    }
    const fresh = threads.find((thread) =>
      wanted.id !== undefined && wanted.id !== ""
        ? thread.id === wanted.id
        : !wanted.ids.has(thread.id) &&
          encodeAnchor(thread.anchor) === wanted.anchor
    );
    if (!fresh) {
      return;
    }
    focusNext.current = null;
    openNow(fresh.id);
    // Once the panel's list (drawn in the background) has it.
    const land = () => {
      const target = elementOf(root)?.querySelector<HTMLElement>(
        `[data-thread="${CSS.escape(fresh.id)}"]`
      );
      if (!target) {
        return false;
      }
      target.focus();
      return true;
    };
    eachFrameUntil(land, 60);
  }, [threads, root]);

  const panel =
    on && open ? (
      <CommentsPanel
        labels={labels}
        threads={placed}
        active={active}
        showResolved={showResolved}
        onShowResolved={setShowResolved}
        draft={draft?.quote ?? null}
        author={options.author}
        onComment={(body) => {
          if (!draft) {
            return;
          }
          const known = new Set((threads ?? []).map((thread) => thread.id));
          focusNext.current = {
            anchor: encodeAnchor(draft.anchor),
            ids: known,
          };
          const answer = options.onComment?.(draft.anchor, body);
          if (typeof answer === "string") {
            focusNext.current = { id: answer, ids: known };
          } else if (isThenable(answer)) {
            void (async () => {
              const id = await answer;
              if (typeof id === "string") {
                focusNext.current = { id, ids: known };
              }
            })();
          }
          setDraft(null);
          say(labels.commentAdded);
        }}
        onCancelDraft={() => {
          const back = draft?.from;
          setDraft(null);
          // Back to where the comment was begun: the document, or find's button.
          requestAnimationFrame(() =>
            (back instanceof HTMLElement && back.isConnected
              ? back
              : scroller
            )?.focus()
          );
        }}
        onOpen={(id) => {
          openThread(id);
        }}
        onReply={(id, body) => {
          options.onReply?.(id, body);
          say(labels.replyAdded);
        }}
        onResolve={(id, resolved) => {
          options.onResolve?.(id, resolved);
          say(resolved ? labels.resolved : labels.reopened);
        }}
        onDelete={onDelete}
        onClose={() => {
          setOpen(false);
          scroller?.focus();
        }}
        extra={options.threadExtra}
        note={
          kind === "none" && options.preview ? (
            <>
              <p {...stylex.props(styles.note)}>
                {labels.previewCannotMark}{" "}
                <Button variant="ghost" size="xs" onClick={onShowCode}>
                  {labels.showItsCode}
                </Button>
              </p>
              {options.panelExtra}
            </>
          ) : (
            options.panelExtra
          )
        }
      />
    ) : null;

  const floating =
    on && chosen ? (
      // A press here keeps the selection: it is what the buttons act on.
      <div
        ref={bar}
        role="toolbar"
        tabIndex={-1}
        aria-label={labels.selection}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        {...stylex.props(styles.floating)}
      >
        <Button
          size="sm"
          variant="ink"
          icon={CommentAdd}
          aria-keyshortcuts="c"
          onClick={() => {
            startDraft(chosen);
          }}
        >
          {labels.comment}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={Link}
          {...copyLink.status}
          onClick={() => {
            void copyLink.run(chosen);
          }}
        >
          {labels.copyLink}
        </Button>
      </div>
    ) : null;

  const wantedParts = [
    ...new Set(
      placed.flatMap((entry) =>
        entry.thread.anchor.kind === "pdf" ? [entry.thread.anchor.page] : []
      )
    ),
  ];
  return {
    on,
    panel,
    floating,
    placed,
    notes,
    count: placed.filter((entry) => entry.thread.resolved !== true).length,
    wantedParts,
    commentHere,
    startDraft,
    openThread,
    next: () => {
      step(1);
    },
    previous: () => {
      step(-1);
    },
  };
};
