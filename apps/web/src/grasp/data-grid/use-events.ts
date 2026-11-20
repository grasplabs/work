// What a person does to the grid: the keys, copy, cut and paste as TSV, and the pointer. Each
// handler reads the model and the page as they are when it runs; nothing here runs in render.
"use client";

import type { RowData } from "@tanstack/react-table";
import { useEffect, useRef } from "react";
import type { ClipboardEvent, KeyboardEvent, PointerEvent } from "react";

import { all, at, fromTsv, move, pasteTarget, toTsv } from "./model";
import type { Cell } from "./model";
import type { GridModel } from "./use-data-grid";
import { plainOf } from "./values";

type Command = "all" | "undo" | "redo" | "tick" | "collapse" | "clear" | "edit";

const within = (target: EventTarget, selector: string) =>
  target instanceof Element && target.closest(selector) !== null;
const directionOf = (element: Element | null) =>
  element !== null && getComputedStyle(element).direction === "rtl";
const modOf = (event: KeyboardEvent) => event.metaKey || event.ctrlKey;

// The keys that are not moves, by what they do.
const commandOf = (
  event: KeyboardEvent,
  ranged: boolean,
  onBox: boolean,
  canEdit: boolean
): Command | null => {
  const mod = modOf(event);
  const key = event.key.toLowerCase();
  if (mod && key === "a") {
    return "all";
  }
  if (mod && key === "z") {
    return event.shiftKey ? "redo" : "undo";
  }
  if (mod && key === "y") {
    return "redo";
  }
  if (key === " " && onBox) {
    return "tick";
  }
  if (key === "escape" && ranged) {
    return "collapse";
  }
  if (key === "delete" || key === "backspace") {
    return "clear";
  }
  if (
    (key === "f2" || (key === "enter" && !event.shiftKey)) &&
    canEdit &&
    !mod
  ) {
    return "edit";
  }
  return null;
};

/** Which way an arrow goes along a row, in the text's flow: 1 to the next column, -1 to the one before. */
const arrowAlong = (key: string, rtl: boolean) => {
  if (key !== "ArrowRight" && key !== "ArrowLeft") {
    return 0;
  }
  return (key === "ArrowRight") === rtl ? -1 : 1;
};

/** A key that types a letter: it opens the editor on that letter. */
const typed = (event: KeyboardEvent) =>
  event.key.length === 1 && !modOf(event) && !event.altKey;

/** The grid's handlers, and the table's ref they find cells through. */
export const useEvents = <Row extends RowData>(model: GridModel<Row>) => {
  const gridRef = useRef<HTMLTableElement>(null);
  const dragging = useRef(false);
  // Set while the grid itself moves focus out of the editor, so the editor's blur does not settle
  // it a second time.
  const leaving = useRef(false);
  const { selection, extent, columns } = model;
  const activeRow = selection.active.row;
  const activeCol = selection.active.col;

  // A drag ends wherever the pointer is let go.
  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  // Focus follows the active cell while the grid has it; focus already inside that cell (its
  // editor) stays.
  useEffect(() => {
    const grid = gridRef.current;
    const cell = grid?.querySelector<HTMLElement>(
      `[data-row="${String(activeRow)}"][data-col="${String(activeCol)}"]`
    );
    if (
      grid?.contains(document.activeElement) === true &&
      cell !== null &&
      cell !== undefined &&
      !cell.contains(document.activeElement)
    ) {
      cell.focus({ preventScroll: true });
      cell.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeRow, activeCol]);

  /** Focus back on the active cell, out of its editor, without the editor's blur settling it. */
  const leave = () => {
    leaving.current = true;
    gridRef.current
      ?.querySelector<HTMLElement>(
        `[data-row="${String(activeRow)}"][data-col="${String(activeCol)}"]`
      )
      ?.focus({ preventScroll: true });
    leaving.current = false;
  };

  const step = (event: KeyboardEvent) =>
    move(selection, extent, {
      key: event.key,
      shift: event.shiftKey,
      mod: modOf(event),
      rtl: directionOf(gridRef.current),
      page: 10,
    });

  // While the editor is open the keys are its own, but for three: Enter and Tab commit and move
  // on, Escape gives the cell back what it held.
  const editKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      leave();
      model.cancelEdit();
      return;
    }
    if (event.key !== "Enter" && event.key !== "Tab") {
      return;
    }
    event.preventDefault();
    if (!model.settle()) {
      return;
    }
    leave();
    const next = step(event);
    if (next !== null) {
      model.choose(at(next.active));
    }
  };

  // A head takes focus on its control (the button that sorts), or on itself when it has none.
  const headOf = (col: number) => {
    const head = [
      ...(gridRef.current?.querySelectorAll<HTMLElement>(
        "thead th[data-head]"
      ) ?? []),
    ].find((each) => each.dataset.head === String(col));
    return head?.querySelector<HTMLElement>("button") ?? head;
  };

  // On a head: Down goes into its column's first cell, and the arrows along the row go from head
  // to head. Every other key is the head's own control's (its sort; its handle keeps all its keys).
  const headKey = (event: KeyboardEvent) => {
    const head =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("th[data-head]")
        : null;
    if (head === null || event.target instanceof HTMLInputElement) {
      return;
    }
    const col = Number(head.dataset.head);
    if (event.key === "ArrowDown" && extent.rows > 0) {
      event.preventDefault();
      model.choose(at({ row: 0, col }));
      gridRef.current
        ?.querySelector<HTMLElement>(
          `[data-row="0"][data-col="${String(col)}"]`
        )
        ?.focus({ preventScroll: true });
      return;
    }
    const along = arrowAlong(event.key, directionOf(gridRef.current));
    if (along !== 0 && col + along >= 0 && col + along < extent.cols) {
      event.preventDefault();
      headOf(col + along)?.focus({ preventScroll: true });
    }
  };

  const commands: Record<Command, () => void> = {
    all: () => {
      model.choose(all(extent));
    },
    undo: () => {
      model.step(true);
    },
    redo: () => {
      model.step(false);
    },
    tick: () => {
      model.tick(selection.active);
    },
    collapse: () => {
      model.choose(at(selection.active));
    },
    clear: () => {
      model.clear("clear");
    },
    edit: () => {
      model.startEdit();
    },
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (within(event.target, "thead")) {
      headKey(event);
      return;
    }
    if (model.editing !== null) {
      editKey(event);
      return;
    }
    const onBox = columns[activeCol]?.kind === "checkbox" && !model.ranged;
    const command = commandOf(event, model.ranged, onBox, model.canEdit);
    if (command !== null) {
      event.preventDefault();
      commands[command]();
      return;
    }
    if (typed(event) && model.canEdit) {
      event.preventDefault();
      model.startEdit(event.key);
      return;
    }
    // Up from the first row goes to the column's head, as Down from a head comes back.
    if (
      event.key === "ArrowUp" &&
      activeRow === 0 &&
      !event.shiftKey &&
      !modOf(event)
    ) {
      event.preventDefault();
      headOf(activeCol)?.focus({ preventScroll: true });
      return;
    }
    const next = step(event);
    // Tab leaves the grid past the last cell and before the first; at once where the grid is one
    // stop (`tab="leave"`). Only an open editor's Tab always commits and moves on.
    const stuck =
      next !== null &&
      next.active.row === activeRow &&
      next.active.col === activeCol;
    if (next === null || (event.key === "Tab" && (stuck || model.tabLeaves))) {
      return;
    }
    event.preventDefault();
    model.choose(next);
  };

  // ---- Copy, cut and paste, as TSV, to and from real spreadsheets ------------------------------------
  const block = () => {
    const lines: string[][] = [];
    for (let row = model.rect.top; row <= model.rect.bottom; row += 1) {
      const line: string[] = [];
      for (let col = model.rect.left; col <= model.rect.right; col += 1) {
        line.push(plainOf(model.valueAt({ row, col }) ?? null));
      }
      lines.push(line);
    }
    return lines;
  };
  const handleCopy = (event: ClipboardEvent<HTMLTableElement>) => {
    if (model.editing !== null) {
      return;
    }
    event.clipboardData.setData("text/plain", toTsv(block()));
    event.preventDefault();
    model.say(model.words.copied);
  };
  const handleCut = (event: ClipboardEvent<HTMLTableElement>) => {
    if (model.editing !== null) {
      return;
    }
    event.clipboardData.setData("text/plain", toTsv(block()));
    event.preventDefault();
    model.clear("cut");
  };
  const handlePaste = (event: ClipboardEvent<HTMLTableElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (model.editing !== null || text === "") {
      return;
    }
    event.preventDefault();
    const target = pasteTarget(fromTsv(text), selection, extent);
    model.write(target.rect, target.value);
    model.choose({
      anchor: { row: target.rect.top, col: target.rect.left },
      active: { row: target.rect.bottom, col: target.rect.right },
    });
  };

  // ---- The pointer: press to choose, drag or Shift to grow, twice to edit ------------------------------
  const isActive = (cell: Cell) =>
    cell.row === activeRow && cell.col === activeCol;
  const handlePress = (
    event: PointerEvent<HTMLTableCellElement>,
    cell: Cell
  ) => {
    // A press in the open editor is the editor's own.
    if (event.button !== 0 || (model.editing !== null && isActive(cell))) {
      return;
    }
    if (event.shiftKey) {
      event.preventDefault();
      model.choose({ anchor: selection.anchor, active: cell });
      return;
    }
    // A finger cannot press twice quickly with ease: a tap on the active cell opens it.
    if (event.pointerType === "touch" && isActive(cell) && !model.ranged) {
      model.startEdit();
      return;
    }
    dragging.current = event.pointerType !== "touch";
    model.choose(at(cell));
  };
  const handleEnter = (cell: Cell) => {
    if (dragging.current) {
      model.grow(cell);
    }
  };
  const handleRowPress = (
    event: PointerEvent<HTMLTableCellElement>,
    row: number
  ) => {
    if (event.button !== 0 || extent.cols === 0) {
      return;
    }
    const first = event.shiftKey ? selection.anchor.row : row;
    model.choose({
      anchor: { row: first, col: 0 },
      active: { row, col: extent.cols - 1 },
    });
    gridRef.current
      ?.querySelector<HTMLElement>(
        `[data-row="${String(row)}"][data-col="${String(extent.cols - 1)}"]`
      )
      ?.focus({ preventScroll: true });
  };
  // Focus has left the editor by itself (a press elsewhere): it settles with what fits.
  const handleEditorBlur = () => {
    if (!leaving.current) {
      model.settle(true);
    }
  };

  // The ref apart from the handlers: a ref is never read in render, and the handlers are passed on.
  return {
    gridRef,
    events: {
      handleKeyDown,
      handleCopy,
      handleCut,
      handlePaste,
      handlePress,
      handleEnter,
      handleRowPress,
      handleEditorBlur,
    },
  };
};

export type GridEvents = ReturnType<typeof useEvents>["events"];
