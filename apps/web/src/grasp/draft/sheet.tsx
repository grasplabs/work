// SheetDraft: a spreadsheet the agent drafted ("put this quarter's late invoices in a sheet"), on the
// Draft frame: its name in the head, where it will be saved (a chip with the service's mark), then the
// sheet itself as a Data grid, every cell editable in place, the keys, copy and paste of a real
// spreadsheet, then its size and Create sheet. The host gets every change as the whole draft
// (`onDraftChange`, from the grid's patches) and the sheet as it stands on Create (`onCreate`).
//
//   <SheetDraft draft={sheet} onDraftChange={setSheet} onCreate={create} onDismiss={dismiss} />
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { DataGrid, applyPatch } from "../data-grid";
import type { CellValue, DataGridKind } from "../data-grid";
import { Spreadsheet } from "../icons";
import { grasp } from "../tokens/tokens.stylex";
import {
  changeOf,
  Draft,
  draftEditable,
  DraftInput,
  fieldOf,
  useDraftWords,
} from "./draft";
import type { DraftStatus } from "./draft";

/** A column of the sheet: its key in each row, its header, and its kind (the Data grid's kinds). */
export interface SheetDraftColumn {
  key: string;
  header: string;
  kind: DataGridKind;
  /** The choices of a `select` column. */
  options?: readonly string[];
}

/** A row: its id and a value per column key. */
export interface SheetDraftRow {
  id: string;
  [key: string]: CellValue;
}

/** The sheet as drafted. */
export interface SheetDraftValue {
  title: string;
  columns: readonly SheetDraftColumn[];
  rows: readonly SheetDraftRow[];
  /** Where it will be saved: its name ("Finance / Q4") and the service's mark (a bare BrandIcon). */
  place?: { name: string; mark?: ReactNode };
}

/** Every prop a SheetDraft takes. */
export interface SheetDraftProps {
  /** Where the draft is (Draft's `status`): drafting, ready, sending, sent, failed or dismissed. */
  status?: DraftStatus;
  /** When it was made, ISO, for the sent line's time. */
  doneAt?: string;
  /** Undo on the sent line, for as long as the host can undo. */
  onUndo?: () => void;
  /** Restore on the dismissed line, for as long as the host can bring it back. */
  onRestore?: () => void;
  /** The sheet as it stands. */
  draft: SheetDraftValue;
  /** Every change the person makes in place; left out, the sheet is locked, as `readOnly`. */
  onDraftChange?: (draft: SheetDraftValue) => void;
  /**
   * Locked: shown to be made exactly as it is. No way to change it, no
   * placeholder and no empty optional row; its values stand as text, and the foot keeps its main
   * action and Discard. Leaving out `onDraftChange` locks it the same way.
   * @default false
   */
  readOnly?: boolean;
  /** Create sheet: the sheet as it stands. */
  onCreate: (draft: SheetDraftValue) => unknown;
  /** Discard, at the foot's start. */
  onDismiss?: () => void;
  /** The service's mark in the head (a BrandIcon); left out, the spreadsheet icon. */
  mark?: ReactNode;
  /** The zone the sent line's time is shown in; left out, the browser's. */
  timeZone?: string;
}

const styles = stylex.create({
  // Where it is saved: a quiet name beside a chip, as a message's place.
  place: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    minWidth: 0,
  },
  name: { color: grasp.muted },
  chip: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space1,
    minWidth: 0,
    height: grasp.controlXs,
    boxSizing: "border-box",
    paddingInline: grasp.space2,
    borderRadius: grasp.cornerPill,
    cornerShape: "round",
    backgroundColor: grasp.soft,
    boxShadow: grasp.edge,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.ink,
  },
  chipMark: { display: "inline-flex", flexShrink: 0 },
  chipName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // Locked: a long name wraps inside the chip, never cut (as a person's chip does).
  chipWhole: {
    alignItems: "flex-start",
    height: "auto",
    minHeight: grasp.controlXs,
    paddingBlock: `calc((${grasp.controlXs} - ${grasp.textXsLine}) / 2)`,
    borderRadius: `calc(${grasp.controlXs} / 2)`,
  },
  chipMarkWhole: { alignItems: "center", height: grasp.textXsLine },
  chipNameWhole: {
    overflow: "visible",
    textOverflow: "clip",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  },
  // The grid scrolls sideways by itself when it is wider (never the page); nothing here clips it,
  // so its edge, drawn outside it, closes all four sides.
  grid: { minWidth: 0 },
  size: {
    margin: 0,
    color: grasp.muted,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
  },
});

/** A spreadsheet drafted in an answer, ready to change and create. */
export const SheetDraft = ({
  draft,
  onDraftChange,
  readOnly,
  onCreate,
  onDismiss,
  mark,
  timeZone,
  status = "ready",
  doneAt,
  onUndo,
  onRestore,
}: SheetDraftProps) => {
  const words = useDraftWords("sheet");
  const change = changeOf(readOnly, onDraftChange);
  const locked = change === undefined;
  const field = fieldOf(draft, change, status);
  const editable = change !== undefined && draftEditable(status);
  return (
    <Draft
      aria-label={`${words.kind}: ${draft.title}`}
      icon={Spreadsheet}
      mark={mark}
      title={
        <DraftInput
          readOnly={locked}
          title
          value={draft.title}
          label={words.title}
          placeholder={locked ? undefined : words.title}
          onValueChange={field("title")}
        />
      }
      main={{ label: words.create, onPress: () => onCreate(draft) }}
      onDismiss={onDismiss}
      status={status}
      done={
        doneAt === undefined
          ? words.created
          : `${words.created} · ${words.time(doneAt, timeZone)}`
      }
      onUndo={onUndo}
      onRestore={onRestore}
      readOnly={locked}
    >
      {draft.place === undefined ? null : (
        <div {...stylex.props(styles.place)}>
          <span {...stylex.props(styles.name)}>{words.saveTo}</span>
          <span
            data-slot="draft-place"
            {...stylex.props(styles.chip, locked && styles.chipWhole)}
          >
            {draft.place.mark === undefined ? null : (
              <span
                aria-hidden="true"
                {...stylex.props(
                  styles.chipMark,
                  locked && styles.chipMarkWhole
                )}
              >
                {draft.place.mark}
              </span>
            )}
            <span
              {...stylex.props(styles.chipName, locked && styles.chipNameWhole)}
            >
              {draft.place.name}
            </span>
          </span>
        </div>
      )}
      <div {...stylex.props(styles.grid)}>
        <DataGrid
          label={draft.title}
          rows={draft.rows}
          rowKey={(row) => row.id}
          columns={draft.columns.map((column) => ({
            key: column.key,
            header: column.header,
            kind: column.kind,
            options: column.options,
            format:
              column.kind === "date"
                ? (value: CellValue) =>
                    typeof value === "string" && value !== ""
                      ? words.date(value)
                      : ""
                : undefined,
            readOnly: !editable,
            value: (row: SheetDraftRow) => row[column.key] ?? null,
          }))}
          onPatch={
            editable
              ? (patch) => {
                  change({
                    ...draft,
                    rows: applyPatch(draft.rows, patch, (row) => row.id),
                  });
                }
              : undefined
          }
        />
      </div>
      <p {...stylex.props(styles.size)}>
        {words.size(draft.rows.length, draft.columns.length)}
      </p>
    </Draft>
  );
};
