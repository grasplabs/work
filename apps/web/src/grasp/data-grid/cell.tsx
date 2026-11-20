// One cell of the grid: its value as its kind shows it, the box of a checkbox column, and the
// editor that opens in place.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef } from "react";
import type { MouseEvent, PointerEvent } from "react";

import { boxStyles } from "../choice/choice";
import { visuallyHidden } from "../hidden/hidden";
import { Icon, Tick } from "../icons";
import { edgeStyles } from "./head";
import type { Lines } from "./lines";
import type { Cell } from "./model";
import { styles } from "./styles";
import type {
  DataGridActiveLook,
  DataGridKind,
  DataGridRangeLook,
} from "./types";
import type { Editing } from "./use-data-grid";
import { isFigure } from "./values";

const activeStyle = {
  halo: styles.activeHalo,
  lifted: styles.activeLifted,
  underline: styles.activeUnderline,
};

// The Checkbox's own box and mark, drawn still: the cell is the control (Space, or a press).
const Box = ({ checked }: { checked: boolean }) => (
  <span aria-hidden="true" {...stylex.props(boxStyles.control, styles.box)}>
    <span
      {...stylex.props(
        boxStyles.face,
        checked ? boxStyles.full : boxStyles.empty
      )}
    >
      {checked && <Icon icon={Tick} />}
    </span>
  </span>
);

interface EditorProps {
  editing: Editing;
  label: string;
  figure: boolean;
  onType: (text: string) => void;
  onBlur: () => void;
}

// The cell's words, typed in place. It takes focus as it opens: on all its words when the cell
// was opened, after the letter when a letter opened it.
const Editor = ({ editing, label, figure, onType, onBlur }: EditorProps) => {
  const ref = useRef<HTMLInputElement>(null);
  const { all } = editing;
  useEffect(() => {
    const input = ref.current;
    input?.focus({ preventScroll: true });
    if (all) {
      input?.select();
    }
  }, [all]);
  return (
    <input
      ref={ref}
      type="text"
      aria-label={label}
      aria-invalid={editing.wrong ? true : undefined}
      autoComplete="off"
      spellCheck={false}
      value={editing.text}
      onChange={(event) => {
        onType(event.currentTarget.value);
      }}
      onBlur={onBlur}
      {...stylex.props(styles.editor, figure && styles.editorEnd)}
    />
  );
};

/** How a cell is drawn by what is chosen. */
export interface CellState {
  /** It is the active cell: Tab into the grid lands on it. */
  active: boolean;
  /** It is the active cell and the grid holds the focus: only then is its edge drawn. */
  lit: boolean;
  /** It lies in a chosen range of more than one cell. */
  inRange: boolean;
  /** Its lines on the range's edge. */
  lines: Lines;
  /** Its sides on the range's edge, for the firmer edge. */
  sides: { top: boolean; bottom: boolean; start: boolean; end: boolean };
  /** The edge is the firmer range's mint, not pine. */
  mint: boolean;
  /** It is in the last column, the last row. */
  lastCol: boolean;
  lastRow: boolean;
}

export interface GridCellProps {
  cell: Cell;
  /** Its place among the columns for a screen reader, from 1. */
  index: number;
  kind: DataGridKind;
  /** Its value as words. */
  text: string;
  /** A box's tick. */
  checked: boolean;
  /** Its name: "Budget, row 3". */
  name: string;
  /** What a screen reader hears for a box. */
  boxWords: string;
  editable: boolean;
  state: CellState;
  look: { active: DataGridActiveLook; range: DataGridRangeLook };
  /** The open editor, when this cell holds it. */
  editing: Editing | null;
  editWords: string;
  onPress: (event: PointerEvent<HTMLTableCellElement>, cell: Cell) => void;
  onEnter: (cell: Cell) => void;
  onTick: (cell: Cell) => void;
  onOpen: () => void;
  onType: (text: string) => void;
  onEditorBlur: () => void;
}

const Shown = ({
  kind,
  text,
  checked,
  boxWords,
  hidden,
  clear = false,
}: {
  kind: DataGridKind;
  text: string;
  checked: boolean;
  boxWords: string;
  hidden: boolean;
  /** The words stand on a pad of the range's ground, clear of its dither. */
  clear?: boolean;
}) => {
  if (kind === "checkbox") {
    return (
      <>
        <Box checked={checked} />
        <span {...stylex.props(visuallyHidden)}>{boxWords}</span>
      </>
    );
  }
  if (kind === "select" && text !== "") {
    return (
      <span
        {...stylex.props(
          styles.chip,
          clear && styles.chipClear,
          hidden && styles.unseenText
        )}
      >
        {text}
      </span>
    );
  }
  return (
    <span
      {...stylex.props(
        styles.text,
        clear && styles.textClear,
        hidden && styles.unseenText
      )}
    >
      {text}
    </span>
  );
};

/** The firmer edge's second line, on the sides of a cell that lie on the range's edge. */
const firmStyles = ({ sides }: CellState) => [
  styles.firm,
  sides.top && styles.firmTop,
  sides.bottom && styles.firmBottom,
  sides.start && styles.firmStart,
  sides.end && styles.firmEnd,
];

/** How the range and the active cell draw on a cell. */
const drawnStyles = (
  state: CellState,
  look: GridCellProps["look"],
  editing: Editing | null
) => [
  state.inRange && styles.inRange,
  state.inRange && look.range === "dither" && styles.inRangeDither,
  state.lastCol && styles.lastCol,
  state.lastRow && styles.lastRow,
  edgeStyles(state.lines, state.mint),
  // The active cell's own edge marks it; the range's mint edge is not drawn over it as well, or
  // its ring showed pine on two sides and mint on the other two.
  state.inRange &&
    look.range === "outline" &&
    !state.active &&
    firmStyles(state),
  state.lit && styles.activeBase,
  state.lit && activeStyle[look.active],
  state.lit &&
    !state.inRange &&
    look.active !== "underline" &&
    styles.activeAlone,
  state.lit &&
    state.inRange &&
    look.active === "underline" &&
    styles.activeUnderlineInRange,
  editing !== null && styles.editing,
  editing?.wrong === true && styles.wrong,
];

/** Where a cell's value stands and how it reads, by its kind. */
const kindStyles = (kind: DataGridKind, editable: boolean) => {
  const boxed = kind === "checkbox";
  return [
    isFigure(kind) && styles.end,
    boxed && styles.centre,
    boxed && editable && styles.boxCell,
    (kind === "text" || isFigure(kind)) && styles.ink,
    !editable && styles.readOnly,
  ];
};

/** One cell. */
export const GridCell = (props: GridCellProps) => {
  const { cell, kind, state, editing } = props;
  const boxed = kind === "checkbox";
  const handleClick = (event: MouseEvent) => {
    if (boxed && !event.shiftKey) {
      props.onTick(cell);
    }
  };
  return (
    <td
      aria-colindex={props.index}
      aria-selected={state.inRange || state.active}
      aria-readonly={props.editable ? undefined : true}
      aria-label={boxed ? props.name : undefined}
      tabIndex={state.active ? 0 : -1}
      data-row={cell.row}
      data-col={cell.col}
      onPointerDown={(event) => {
        props.onPress(event, cell);
      }}
      onPointerEnter={() => {
        props.onEnter(cell);
      }}
      // Reached by Tab after the grid has scrolled (a sort, a scroll by hand), the active cell is
      // brought clear of the fades at the edges, so its ring is never under one.
      onFocus={(event) => {
        if (event.target === event.currentTarget) {
          event.currentTarget.scrollIntoView({
            block: "nearest",
            inline: "nearest",
          });
        }
      }}
      onClick={handleClick}
      onDoubleClick={props.onOpen}
      {...stylex.props(
        styles.cell,
        kindStyles(kind, props.editable),
        drawnStyles(state, props.look, editing)
      )}
    >
      <Shown
        kind={kind}
        text={props.text}
        checked={props.checked}
        boxWords={props.boxWords}
        hidden={editing !== null}
        clear={state.inRange && props.look.range === "dither"}
      />
      {editing !== null && (
        <Editor
          editing={editing}
          label={props.editWords}
          figure={isFigure(kind)}
          onType={props.onType}
          onBlur={props.onEditorBlur}
        />
      )}
    </td>
  );
};
