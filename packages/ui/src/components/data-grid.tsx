import type { OperationReference } from "@grasp-os/sdk";
import type { ValueDescriptor } from "@grasp-os/sdk/form-binding";
import { usePaginatedQuery, useRetryFailed } from "@grasp-os/sdk/react";
import type { PageItemOf, PaginatedArgsOf } from "@grasp-os/sdk/react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Input } from "@grasp-os/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Switch } from "@grasp-os/ui/components/switch";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { useSettled } from "@grasp-os/ui/hooks/use-settled";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  Columns3Icon,
  MoreHorizontalIcon,
  SearchIcon,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  draftOf,
  editorKindOf,
  parsedDraft,
  recordFieldsOf,
  shownCell,
} from "../internal/data-grid-cells.ts";
import type { EditorKind } from "../internal/data-grid-cells.ts";
import { dataGridTexts } from "../internal/data-grid-text.ts";
import type { DataGridText } from "../internal/data-grid-text.ts";
import { documentLanguage, pageText } from "../internal/language.ts";
import { QueryBoundary } from "../internal/query-boundary.tsx";

export type { DataGridText } from "../internal/data-grid-text.ts";

// A table of an App's records, read page by page from one of its queries
// (`usePaginatedQuery`): what a page would otherwise wire by hand around
// `Table`. The grid owns what a person does to the table (search, sort,
// filters, which columns show, which rows are selected) and hands the
// first three to the query through `args`, so the App's query does the
// searching, sorting and filtering on the server, over every record, not
// just those loaded. Each cell shows and edits its field as the query
// declares it (its `returns`): a moment as a date, money in its currency,
// a nullable number edited as a number.
//
// What could go wrong, and how it is closed:
// - A search per keystroke: the search settles before it reaches `args`.
// - A bulk action on rows no longer shown, or on the wrong ones: rows are
//   selected by their `_id` (a grid with bulk actions needs one), and the
//   selection is of the rows loaded now; a row gone from the list drops out.
// - An inline edit saved twice, or lost: one save at a time per cell; a
//   failure keeps the editor open with what was typed, and says why.
// - An action failing unseen: a row's or bulk action's failure is shown
//   above the table, as an edit's is in its cell.
// - A failed query blanking the page: the grid shows the failure in its
//   place, with Try again, and the search and filters stay usable.

/** A query a grid reads its records with: one that answers pages. */
type AnyQuery = OperationReference<unknown, unknown, "query">;

/** Which way a sorted column runs. */
export type SortDirection = "asc" | "desc";

/** A record's fields a column can show. */
type FieldOf<Row> = keyof Row & string;

/** The values a person can filter a field by: those of its values that are text. */
type FilterValue<Value> = Extract<Value, string>;

/**
 * What the person did to the table that the query answers for, typed by
 * the records `Row`: hand it on to the query's arguments as it takes them.
 */
export interface DataGridState<Row> {
  /** What the person searched for, once they stopped typing; "" for nothing. */
  readonly search: string;
  /** The column sorted by, if any. */
  readonly sort:
    | { readonly field: FieldOf<Row>; readonly direction: SortDirection }
    | undefined;
  /** Each filtered column's chosen value, by its field: one of its `filter`'s. */
  readonly filters: {
    readonly [Name in FieldOf<Row>]?: FilterValue<Row[Name]>;
  };
}

/** The same, as the grid keeps it, of any record. */
interface GridState {
  readonly search: string;
  readonly sort:
    | { readonly field: string; readonly direction: SortDirection }
    | undefined;
  readonly filters: Readonly<Record<string, string>>;
}

/**
 * What an inline edit of a value of type `Value` saves: text (an enum's
 * value among them), a number (a moment's too), a yes or no, or null for a
 * field that allows it, cleared. Never a record's ID, which isn't typed in.
 */
type EditValue<Value> = Value extends { readonly __tableName: string }
  ? never
  : Value extends undefined
    ? undefined
    : Value extends string
      ? Value
      : Value extends number
        ? number
        : Value extends boolean
          ? boolean
          : Value extends null
            ? null
            : never;

/** A record the grid can tell apart from the others whatever moves: one with an `_id`. */
interface KeyedRow {
  readonly _id: string;
}

/**
 * How a column saves an inline edit: only of records with an `_id`, so a
 * draft is always saved to the record it was typed for, however the list
 * moves while it is open.
 */
type EditOf<Row, Name extends FieldOf<Row>> = [Row] extends [KeyedRow]
  ? (row: Row, value: EditValue<Row[Name]>) => Promise<unknown>
  : never;

/** One column, showing one field of the record. */
interface ColumnOf<Row, Name extends FieldOf<Row>> {
  readonly field: Name;
  /** Its heading; the field's name, in words, otherwise. */
  readonly label?: string;
  /** Whether the person can sort by it: the query gets `sort`. */
  readonly sortable?: boolean;
  /** The values the person can filter it by, each by its label: the query gets `filters[field]`. */
  readonly filter?: Readonly<Partial<Record<FilterValue<Row[Name]>, string>>>;
  /** Whether it starts hidden; the person can show it. */
  readonly hidden?: boolean;
  /**
   * Whether the field, a moment (`v.timestamp()`), holds a day, as a date
   * field keeps it (the moment the day starts in UTC): shown and edited as
   * that day, wherever the person is. A moment shows its date and time
   * otherwise.
   */
  readonly day?: boolean;
  /**
   * How a cell shows the record; as the query declares the field
   * otherwise. Formatted text (Markdown) shows with `RichText`:
   * `cell: (row) => <RichText value={row.notes} />`.
   */
  readonly cell?: (row: Row) => ReactNode;
  /**
   * Saves a new value the person gave in the cell, with a mutation of the
   * App's: the cell becomes editable, as the query declares the field
   * (text, an enum's values, a number, a moment or a day, a yes or no).
   * Its rejection is shown in the cell. Other fields stay read-only, their
   * `edit` never called: a record's ID (typed `never`), a file, money, a
   * duration, a list or an object. Don't combine it with a `cell` that
   * renders something interactive (a link, a button): the cell is the
   * edit button, and can't hold another.
   */
  readonly edit?: EditOf<Row, Name>;
}

/** A column: a field's name alone, or how it shows. */
export type DataGridColumn<Row> =
  | FieldOf<Row>
  | { [Name in FieldOf<Row>]: ColumnOf<Row, Name> }[FieldOf<Row>];

/** Something the person can do to one row, from its menu. */
export interface DataGridRowAction<Row> {
  readonly label: string;
  /** Its rejection is shown above the table. */
  readonly onSelect: (row: Row) => unknown;
  readonly destructive?: boolean;
}

/** Something the person can do to the selected rows at once. */
export interface DataGridBulkAction<Row> {
  readonly label: string;
  /**
   * Called with the selected rows; the selection clears once it resolves,
   * and stays, its rejection shown above the table, if it fails.
   */
  readonly onSelect: (rows: readonly Row[]) => unknown;
  readonly destructive?: boolean;
}

/** What every column of a grid is, read from its spec and the query. */
interface ReadColumn<Row> {
  readonly field: FieldOf<Row>;
  readonly label: string;
  readonly sortable: boolean;
  readonly filter: Readonly<Partial<Record<string, string>>> | undefined;
  readonly hidden: boolean;
  readonly day: boolean;
  readonly cell: ((row: Row) => ReactNode) | undefined;
  readonly edit: ((row: Row, value: unknown) => Promise<unknown>) | undefined;
  /** What the query declares of the field. */
  readonly descriptor: ValueDescriptor | undefined;
}

const camelBreak = /(?<=[a-z0-9])(?=[A-Z])/gu;
const leadingUnderscores = /^_+/u;

/** A field's name in words: `_createdAt` as "Created at". */
const labelOfField = (field: string): string => {
  const words = field
    .replace(leadingUnderscores, "")
    .split(camelBreak)
    .join(" ")
    .replaceAll("_", " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const readColumn = <Row,>(
  spec: DataGridColumn<Row>,
  fields: Readonly<Record<string, ValueDescriptor>>
): ReadColumn<Row> => {
  const field = typeof spec === "string" ? spec : spec.field;
  const descriptor = Object.hasOwn(fields, field) ? fields[field] : undefined;
  if (typeof spec === "string") {
    return {
      field,
      label: labelOfField(field),
      sortable: false,
      filter: undefined,
      hidden: false,
      day: false,
      cell: undefined,
      edit: undefined,
      descriptor,
    };
  }
  return {
    field,
    label: spec.label ?? labelOfField(field),
    sortable: spec.sortable === true,
    filter: spec.filter,
    hidden: spec.hidden === true,
    day: spec.day === true,
    cell: spec.cell,
    // SAFETY: an editor hands `edit` a value of the type the query
    // declares the field holds (`parsedDraft`), as `EditValue` types it.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    edit: spec.edit as ReadColumn<Row>["edit"],
    descriptor,
  };
};

/** A record's `_id`, if it has one. */
const idOf = (row: unknown): string | undefined =>
  typeof row === "object" &&
  row !== null &&
  "_id" in row &&
  typeof row._id === "string"
    ? row._id
    : undefined;

/** `row`'s value of `field`. */
const valueOf = (row: unknown, field: string): unknown =>
  typeof row === "object" && row !== null && Object.hasOwn(row, field)
    ? Reflect.get(row, field)
    : undefined;

/** The next sort when the person picks a column's heading: up, down, then none. */
const nextSort = (
  sort: GridState["sort"],
  field: string
): GridState["sort"] => {
  if (sort?.field !== field) {
    return { field, direction: "asc" };
  }
  return sort.direction === "asc" ? { field, direction: "desc" } : undefined;
};

/** Why something failed, as a person reads it: its own message, if it has one. */
const messageOf = (error: unknown, text: DataGridText): string =>
  error instanceof Error && error.message !== ""
    ? error.message
    : text.actionFailed;

/** A cell as the query declares its field: formatted, or rich text. */
const CellValue = <Row,>({
  row,
  column,
  text,
}: {
  row: Row;
  column: ReadColumn<Row>;
  text: DataGridText;
}): ReactNode => {
  if (column.cell !== undefined) {
    return column.cell(row);
  }
  return shownCell(
    valueOf(row, column.field),
    column.descriptor,
    text,
    documentLanguage(),
    column.day
  );
};

/** The input an editor types into, by what it edits. */
const inputTypes: Readonly<Record<EditorKind, string>> = {
  text: "text",
  choice: "text",
  number: "number",
  boolean: "checkbox",
  moment: "datetime-local",
  day: "date",
};

/** A cell the person can edit in place, saving through its column's `edit`. */
const EditableCell = <Row,>({
  row,
  rowLabel,
  column,
  kind,
  text,
}: {
  row: Row;
  rowLabel: string;
  column: ReadColumn<Row>;
  kind: EditorKind;
  text: DataGridText;
}): React.JSX.Element => {
  const value = valueOf(row, column.field);
  const { descriptor } = column;
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  // One save at a time: Enter and the blur that follows it are one edit.
  const pending = useRef(false);
  // Back to the cell once an edit the person ended there (Enter, Escape) closes.
  const refocus = useRef(false);
  const [failure, setFailure] = useState<string>();
  const failureId = useId();
  const name = text.edit(column.label, rowLabel);
  const save = async (next: unknown): Promise<void> => {
    if (pending.current || column.edit === undefined) {
      return;
    }
    pending.current = true;
    setSaving(true);
    setFailure(undefined);
    let failed: string | undefined;
    try {
      await column.edit(row, next);
    } catch (error) {
      failed = messageOf(error, text);
    }
    pending.current = false;
    setSaving(false);
    setFailure(failed);
    if (failed === undefined) {
      setDraft(undefined);
    }
  };
  const describedBy = failure === undefined ? undefined : failureId;
  const failureShown =
    failure === undefined ? null : (
      <p className="text-destructive text-xs" id={failureId} role="alert">
        {failure}
      </p>
    );
  if (kind === "boolean") {
    return (
      <div className="flex flex-col gap-1">
        <Switch
          aria-describedby={describedBy}
          aria-label={name}
          checked={value === true}
          disabled={saving}
          onCheckedChange={(checked) => {
            void save(checked);
          }}
        />
        {failureShown}
      </div>
    );
  }
  if (draft === undefined) {
    return (
      <Button
        aria-label={name}
        onClick={() => {
          setDraft(draftOf(value, kind));
          setFailure(undefined);
        }}
        ref={(button: HTMLButtonElement | null) => {
          if (button !== null && refocus.current) {
            refocus.current = false;
            button.focus();
          }
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        <CellValue column={column} row={row} text={text} />
      </Button>
    );
  }
  const commit = (typed: string): void => {
    if (typed === draftOf(value, kind)) {
      setDraft(undefined);
      return;
    }
    const parsed = parsedDraft(typed, kind, descriptor, text);
    if ("problem" in parsed) {
      setFailure(parsed.problem);
      return;
    }
    void save(parsed.value);
  };
  const keys = (event: React.KeyboardEvent): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      refocus.current = true;
      commit(draft);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      refocus.current = true;
      setDraft(undefined);
      setFailure(undefined);
    }
  };
  const choices = descriptor?.kind === "enum" ? descriptor.values : [];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        {kind === "choice" ? (
          <NativeSelect
            aria-describedby={describedBy}
            aria-invalid={failure !== undefined}
            aria-label={name}
            autoFocus
            disabled={saving}
            onBlur={() => {
              refocus.current = false;
              // A failed save stays open, its reason shown, to choose again.
              if (!pending.current && failure === undefined) {
                setDraft(undefined);
              }
            }}
            onChange={(event) => {
              setDraft(event.target.value);
              commit(event.target.value);
            }}
            onKeyDown={keys}
            value={draft}
          >
            {descriptor?.nullable === true ? (
              <NativeSelectOption value="" />
            ) : null}
            {choices.map((choice) => (
              <NativeSelectOption key={choice} value={choice}>
                {choice}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        ) : (
          <Input
            aria-describedby={describedBy}
            aria-invalid={failure !== undefined}
            aria-label={name}
            autoFocus
            disabled={saving}
            onBlur={() => {
              // Left for elsewhere: the cell doesn't take focus back.
              if (!pending.current) {
                refocus.current = false;
              }
              commit(draft);
            }}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={keys}
            type={inputTypes[kind]}
            value={draft}
          />
        )}
        {saving ? <Spinner aria-hidden /> : null}
      </div>
      {failureShown}
    </div>
  );
};

/** A cell of a row: editable where its column saves and its field can be edited. */
const RowCell = <Row,>({
  row,
  rowLabel,
  column,
  text,
}: {
  row: Row;
  rowLabel: string;
  column: ReadColumn<Row>;
  text: DataGridText;
}): React.JSX.Element => {
  const kind = editorKindOf(column.descriptor, column.day);
  // Only a record with an `_id` is edited: one without has no key that
  // holds still while the list moves.
  return (
    <TableCell>
      {column.edit === undefined ||
      kind === undefined ||
      idOf(row) === undefined ? (
        <CellValue column={column} row={row} text={text} />
      ) : (
        <EditableCell
          column={column}
          kind={kind}
          row={row}
          rowLabel={rowLabel}
          text={text}
        />
      )}
    </TableCell>
  );
};

/** What the rows of a grid take. */
interface RowsProps<Reference extends AnyQuery> {
  readonly label: string;
  readonly query: Reference;
  readonly args: PaginatedArgsOf<Reference> | "skip";
  readonly pageSize: number;
  readonly columns: readonly ReadColumn<PageItemOf<Reference>>[];
  readonly rowActions: readonly DataGridRowAction<PageItemOf<Reference>>[];
  readonly bulkActions: readonly DataGridBulkAction<PageItemOf<Reference>>[];
  readonly state: GridState;
  readonly onSort: (field: string) => void;
  readonly narrowed: boolean;
  readonly empty: ReactNode;
  readonly text: DataGridText;
}

/** How a sorted heading says its order to assistive technology. */
const ariaSortOf = (
  state: GridState,
  field: string
): "ascending" | "descending" | "none" => {
  if (state.sort?.field !== field) {
    return "none";
  }
  return state.sort.direction === "asc" ? "ascending" : "descending";
};

const SortIcon = ({
  state,
  field,
}: {
  state: GridState;
  field: string;
}): React.JSX.Element => {
  const sort = ariaSortOf(state, field);
  if (sort === "ascending") {
    return <ArrowUpIcon aria-hidden />;
  }
  if (sort === "descending") {
    return <ArrowDownIcon aria-hidden />;
  }
  return <ArrowUpDownIcon aria-hidden />;
};

/** How many placeholder rows show while the first records load. */
const loadingRows = 3;

/**
 * What names a row in its controls' names (`Select Ada`): its first
 * column as a cell shows it, or where it is.
 */
const rowLabelOf = <Row,>(
  row: Row,
  index: number,
  first: ReadColumn<Row> | undefined,
  text: DataGridText
): string => {
  const shown =
    first === undefined
      ? ""
      : shownCell(
          valueOf(row, first.field),
          first.descriptor,
          text,
          documentLanguage(),
          first.day
        );
  return shown === "" ? `#${index + 1}` : shown;
};

/** The grid's rows: read from the query, with the selection and Load more. */
const GridRows = <Reference extends AnyQuery>({
  label,
  query,
  args,
  pageSize,
  columns,
  rowActions,
  bulkActions,
  state,
  onSort,
  narrowed,
  empty,
  text,
}: RowsProps<Reference>): React.JSX.Element => {
  const list = usePaginatedQuery(query, args, { initialPageSize: pageSize });
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [acting, setActing] = useState(false);
  // Why the last row or bulk action failed, until another runs.
  const [failure, setFailure] = useState<string>();
  const [first] = columns;
  const rows = list.items.map((row, index) => ({
    id: idOf(row),
    key: idOf(row) ?? `#${index}`,
    label: rowLabelOf(row, index, first, text),
    row,
  }));
  // The selection is of the rows shown now, by ID: one that left the list
  // is dropped, never selected again should it come back.
  const selectableRows = rows.filter(({ id }) => id !== undefined);
  const shownIds = new Set(selectableRows.map(({ id }) => id));
  if ([...selected].some((id) => !shownIds.has(id))) {
    setSelected(new Set([...selected].filter((id) => shownIds.has(id))));
  }
  const chosen = selectableRows.filter(
    ({ id }) => id !== undefined && selected.has(id)
  );
  const selectable = bulkActions.length > 0;
  const allChosen =
    selectableRows.length > 0 && chosen.length === selectableRows.length;
  const width =
    columns.length + (selectable ? 1 : 0) + (rowActions.length > 0 ? 1 : 0);
  const loadingFirst = list.isLoading && rows.length === 0;
  const run = async (act: () => unknown): Promise<boolean> => {
    setActing(true);
    setFailure(undefined);
    let failed: string | undefined;
    try {
      await act();
    } catch (error) {
      failed = messageOf(error, text);
    }
    setActing(false);
    setFailure(failed);
    return failed === undefined;
  };
  let body: ReactNode;
  if (loadingFirst) {
    body = Array.from({ length: loadingRows }, (_, index) => (
      // Placeholders, all alike, never reordered: keyed by place.
      <TableRow key={index}>
        <TableCell colSpan={width}>
          <Skeleton className="h-5 w-full" />
        </TableCell>
      </TableRow>
    ));
  } else if (rows.length === 0) {
    body = (
      <TableRow>
        <TableCell colSpan={width}>
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{narrowed ? text.noMatches : text.empty}</EmptyTitle>
              {empty === undefined ? null : (
                <EmptyDescription>{empty}</EmptyDescription>
              )}
            </EmptyHeader>
          </Empty>
        </TableCell>
      </TableRow>
    );
  } else {
    body = rows.map(({ id, key, label: rowLabel, row }) => (
      <TableRow
        data-state={
          id !== undefined && selected.has(id) ? "selected" : undefined
        }
        key={key}
      >
        {selectable ? (
          <TableCell>
            {id === undefined ? null : (
              <Checkbox
                aria-label={text.selectRow(rowLabel)}
                checked={selected.has(id)}
                onCheckedChange={(checked) => {
                  const next = new Set(selected);
                  if (checked) {
                    next.add(id);
                  } else {
                    next.delete(id);
                  }
                  setSelected(next);
                }}
              />
            )}
          </TableCell>
        ) : null}
        {columns.map((column) => (
          <RowCell
            column={column}
            key={column.field}
            row={row}
            rowLabel={rowLabel}
            text={text}
          />
        ))}
        {rowActions.length > 0 && id === undefined ? (
          <TableCell variant="end" />
        ) : null}
        {rowActions.length > 0 && id !== undefined ? (
          <TableCell variant="end">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label={text.rowActions(rowLabel)}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <MoreHorizontalIcon aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {rowActions.map((action) => (
                  <DropdownMenuItem
                    key={action.label}
                    onClick={() => {
                      void run(() => action.onSelect(row));
                    }}
                    variant={
                      action.destructive === true ? "destructive" : "default"
                    }
                  >
                    {action.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </TableCell>
        ) : null}
      </TableRow>
    ));
  }
  return (
    <div className="flex flex-col gap-3">
      {failure === undefined ? null : (
        <Alert live="assertive" variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {selectable && chosen.length > 0 ? (
        <div
          aria-label={text.bulkActions}
          className="flex flex-wrap items-center gap-2"
          role="group"
        >
          <span className="text-sm">{text.selected(chosen.length)}</span>
          {bulkActions.map((action) => (
            <Button
              disabled={acting}
              key={action.label}
              onClick={() => {
                const act = async (): Promise<void> => {
                  const done = await run(() =>
                    action.onSelect(chosen.map(({ row }) => row))
                  );
                  if (done) {
                    setSelected(new Set());
                  }
                };
                void act();
              }}
              size="sm"
              type="button"
              variant={action.destructive === true ? "destructive" : "outline"}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
      <Table aria-busy={list.isLoading}>
        <TableCaption>{label}</TableCaption>
        <TableHeader>
          <TableRow>
            {selectable ? (
              <TableHead>
                <Checkbox
                  aria-label={text.selectAll}
                  checked={allChosen}
                  disabled={selectableRows.length === 0}
                  indeterminate={chosen.length > 0 && !allChosen}
                  onCheckedChange={(checked) => {
                    setSelected(
                      new Set(
                        checked
                          ? selectableRows.flatMap(({ id }) =>
                              id === undefined ? [] : [id]
                            )
                          : []
                      )
                    );
                  }}
                />
              </TableHead>
            ) : null}
            {columns.map((column) => (
              <TableHead
                aria-sort={
                  column.sortable ? ariaSortOf(state, column.field) : undefined
                }
                key={column.field}
              >
                {column.sortable ? (
                  <Button
                    onClick={() => {
                      onSort(column.field);
                    }}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    {column.label}
                    <SortIcon field={column.field} state={state} />
                  </Button>
                ) : (
                  column.label
                )}
              </TableHead>
            ))}
            {rowActions.length > 0 ? (
              <TableHead>
                <span className="sr-only">{text.actions}</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>{body}</TableBody>
      </Table>
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-sm" role="status">
          {loadingFirst ? null : text.shown(rows.length)}
        </span>
        {list.hasMore ? (
          <Button
            aria-busy={list.isLoading}
            disabled={list.isLoading}
            onClick={() => {
              const more = async (): Promise<void> => {
                try {
                  await list.loadMore();
                } catch {
                  // The list's own failure, which it throws while
                  // rendering, to the grid's boundary.
                }
              };
              void more();
            }}
            type="button"
            variant="outline"
          >
            {list.isLoading ? <Spinner aria-hidden /> : null}
            {text.loadMore}
          </Button>
        ) : null}
      </div>
    </div>
  );
};

/** The grid's failure, in place of its rows, and a way to read it again. */
const GridFailure = ({
  error,
  again,
  text,
}: {
  error: unknown;
  again: () => void;
  text: DataGridText;
}): React.JSX.Element => {
  const retryFailed = useRetryFailed();
  return (
    <Alert live="assertive" variant="destructive">
      <AlertTitle>{text.failed}</AlertTitle>
      <AlertDescription>
        <p>{messageOf(error, text)}</p>
        <p>
          <Button
            onClick={() => {
              retryFailed();
              again();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {text.tryAgain}
          </Button>
        </p>
      </AlertDescription>
    </Alert>
  );
};

/** How long typing settles before a search reaches the query. */
const searchSettleMs = 300;

/** The bulk actions a grid of `Row` takes: only of rows it can select by `_id`. */
type BulkActionsOf<Row> = [Row] extends [KeyedRow]
  ? readonly DataGridBulkAction<Row>[]
  : never;

/** The row actions a grid of `Row` takes: only of rows it knows by `_id`. */
type RowActionsOf<Row> = [Row] extends [KeyedRow]
  ? readonly DataGridRowAction<Row>[]
  : never;

/** What a data grid takes. */
export interface DataGridProps<Reference extends AnyQuery> {
  /** What the table is, as its caption says. */
  readonly label: string;
  /** The App's query that answers the records, a page at a time. */
  readonly query: Reference;
  /**
   * The query's arguments (without `pagination`) for what the person did:
   * hand `state.search`, `state.sort` and `state.filters` on as the query
   * takes them. A change starts the list again.
   */
  readonly args: (
    state: DataGridState<PageItemOf<Reference>>
  ) => PaginatedArgsOf<Reference> | "skip";
  /** Its columns, in order: a field's name, or how it shows. */
  readonly columns: readonly DataGridColumn<PageItemOf<Reference>>[];
  /** How many records it loads first, and more by: 1 to 100. */
  readonly pageSize?: number;
  /** Shows a search box; its text is the box's placeholder. */
  readonly search?: string;
  /** The sort it starts with. */
  readonly initialSort?: DataGridState<PageItemOf<Reference>>["sort"];
  /** What a row's menu offers: the records must have an `_id`. */
  readonly rowActions?: RowActionsOf<PageItemOf<Reference>>;
  /**
   * What the selected rows can have done to them: rows become selectable,
   * by their `_id`, which the records must have.
   */
  readonly bulkActions?: BulkActionsOf<PageItemOf<Reference>>;
  /** What it says, besides its title, when there are no records. */
  readonly empty?: ReactNode;
  /** What it says, in the page's language (the page's otherwise). */
  readonly text?: Partial<DataGridText>;
}

const noActions: readonly never[] = [];

/**
 * A table of the records `query` answers, read page by page: search,
 * sorting and filters handed to the query, columns the person can hide,
 * rows they can select for bulk actions, a menu of actions per row, and
 * cells edited in place through a mutation. Each cell shows and edits its
 * field as the query declares it.
 *
 * ```tsx
 * <DataGrid
 *   label="Customers"
 *   query={api.customers.list}
 *   args={({ search, sort, filters }) => ({
 *     search,
 *     nameOrder: sort?.field === "name" ? sort.direction : undefined,
 *     status: filters.status,
 *   })}
 *   columns={[
 *     { field: "name", sortable: true, edit: async (row, name) => await rename({ id: row._id, name }) },
 *     { field: "status", filter: { active: "Active", archived: "Archived" } },
 *     { field: "notes", cell: (row) => <RichText value={row.notes} /> },
 *     { field: "renewsOn", day: true },
 *     "_createdAt",
 *   ]}
 *   search="Search customers"
 *   bulkActions={[{ label: "Archive", onSelect: async (rows) => await archive({ ids: rows.map((row) => row._id) }) }]}
 *   rowActions={[{ label: "Open", onSelect: async (row) => await navigate({ to: "/customers/$customerId", params: { customerId: row._id } }) }]}
 * />
 * ```
 */
export const DataGrid = <Reference extends AnyQuery>({
  label,
  query,
  args,
  columns: specs,
  pageSize = 25,
  search: searchPlaceholder,
  initialSort,
  rowActions,
  bulkActions,
  empty,
  text: ownText,
}: DataGridProps<Reference>): React.JSX.Element => {
  // SAFETY: `BulkActionsOf` and `RowActionsOf` admit actions only of rows
  // with an `_id`, which are the rows these are.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const bulk = (bulkActions ?? noActions) as readonly DataGridBulkAction<
    PageItemOf<Reference>
  >[];
  // SAFETY: as above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const menu = (rowActions ?? noActions) as readonly DataGridRowAction<
    PageItemOf<Reference>
  >[];

  const text: DataGridText = { ...pageText(dataGridTexts), ...ownText };
  const fields = recordFieldsOf(query.returns ?? null);
  const columns = specs.map((spec) => readColumn(spec, fields));
  const [typed, setTyped] = useState("");
  const search = useSettled(typed, searchSettleMs);
  const [sort, setSort] = useState<GridState["sort"]>(initialSort);
  const [filters, setFilters] = useState<Readonly<Record<string, string>>>({});
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        columns.filter((column) => column.hidden).map(({ field }) => field)
      )
  );
  const state: GridState = { search: search.trim(), sort, filters };
  const shown = columns.filter((column) => !hidden.has(column.field));
  const filtered = columns.filter((column) => column.filter !== undefined);
  const narrowed = state.search !== "" || Object.keys(filters).length > 0;
  // SAFETY: the sort names a column's field, and each filter one of its
  // column's `filter` values, which are the field's own (`FilterValue`).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const listArgs = args(state as DataGridState<PageItemOf<Reference>>);
  return (
    <div className="flex flex-col gap-3" data-slot="data-grid">
      <div className="flex flex-wrap items-center gap-2">
        {searchPlaceholder === undefined ? null : (
          <InputGroup className="max-w-sm">
            <InputGroupAddon>
              <SearchIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={text.search}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
              placeholder={searchPlaceholder}
              type="search"
              value={typed}
            />
          </InputGroup>
        )}
        {filtered.map((column) => (
          <NativeSelect
            aria-label={column.label}
            key={column.field}
            onChange={(event) => {
              const { value } = event.target;
              const rest = Object.fromEntries(
                Object.entries(filters).filter(
                  ([field]) => field !== column.field
                )
              );
              setFilters(
                value === "" ? rest : { ...rest, [column.field]: value }
              );
            }}
            value={filters[column.field] ?? ""}
          >
            <NativeSelectOption value="">
              {`${column.label}: ${text.all}`}
            </NativeSelectOption>
            {Object.entries(column.filter ?? {}).map(
              ([value, name = value]) => (
                <NativeSelectOption key={value} value={value}>
                  {name}
                </NativeSelectOption>
              )
            )}
          </NativeSelect>
        ))}
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" />}>
            <Columns3Icon aria-hidden />
            {text.columns}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{text.columns}</DropdownMenuLabel>
              {columns.map((column) => (
                <DropdownMenuCheckboxItem
                  checked={!hidden.has(column.field)}
                  key={column.field}
                  onCheckedChange={(checked) => {
                    const next = new Set(hidden);
                    if (checked) {
                      next.delete(column.field);
                    } else {
                      next.add(column.field);
                    }
                    setHidden(next);
                  }}
                >
                  {column.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <QueryBoundary
        renderFailure={(error, again) => (
          <GridFailure again={again} error={error} text={text} />
        )}
        reading={JSON.stringify(listArgs)}
      >
        <GridRows
          args={listArgs}
          // Other arguments, another list: its selection starts empty.
          key={JSON.stringify(listArgs)}
          bulkActions={bulk}
          columns={shown}
          empty={empty}
          label={label}
          narrowed={narrowed}
          onSort={(field) => {
            setSort(nextSort(sort, field));
          }}
          pageSize={pageSize}
          query={query}
          rowActions={menu}
          state={state}
          text={text}
        />
      </QueryBoundary>
    </div>
  );
};
