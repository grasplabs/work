import type { OperationReference } from "@grasp-os/sdk";
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
import { Component, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

// A table of an App's records, read page by page from one of its queries
// (`usePaginatedQuery`): what a screen would otherwise wire by hand around
// `Table`. The grid owns what a person does to the table (search, sort,
// filters, which columns show, which rows are selected) and hands the
// first three to the query through `args`, so the App's query does the
// searching, sorting and filtering on the server, over every record, not
// just those loaded. It shows the records the query answered, more on
// Load more, and its own empty, loading and failed states.
//
// What could go wrong, and how it is closed:
// - A search per keystroke: the search settles before it reaches `args`.
// - A bulk action on rows no longer shown: the selection is what the
//   person sees, the rows loaded now; a row gone from the list drops out.
// - An inline edit saved twice, or lost: one save at a time per cell; a
//   failure keeps the editor open with what was typed, and says why.
// - A failed query blanking the screen: the grid shows the failure in its
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

/** What an inline edit of a value of type `Value` saves: its text, number or yes or no. */
type EditValue<Value> = Value extends string
  ? string
  : Value extends number
    ? number
    : Value extends boolean
      ? boolean
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
  /** How a cell shows the record; its value as text otherwise. */
  readonly cell?: (row: Row) => ReactNode;
  /**
   * Saves a new value the person typed in the cell, with a mutation of the
   * App's: the cell becomes editable. Text and numbers are typed, a yes or
   * no is a switch. Its rejection is shown in the cell.
   */
  readonly edit?: (row: Row, value: EditValue<Row[Name]>) => Promise<unknown>;
}

/** A column: a field's name alone, or how it shows. */
export type DataGridColumn<Row> =
  | FieldOf<Row>
  | { [Name in FieldOf<Row>]: ColumnOf<Row, Name> }[FieldOf<Row>];

/** Something the person can do to one row, from its menu. */
export interface DataGridRowAction<Row> {
  readonly label: string;
  readonly onSelect: (row: Row) => unknown;
  readonly destructive?: boolean;
}

/** Something the person can do to the selected rows at once. */
export interface DataGridBulkAction<Row> {
  readonly label: string;
  /** Called with the selected rows; the selection clears once it resolves. */
  readonly onSelect: (rows: readonly Row[]) => unknown;
  readonly destructive?: boolean;
}

/** What the grid says, in English unless the screen says otherwise. */
export interface DataGridText {
  readonly search: string;
  readonly columns: string;
  readonly loadMore: string;
  readonly empty: string;
  /** When a search or filter answered nothing. */
  readonly noMatches: string;
  readonly failed: string;
  readonly tryAgain: string;
  readonly all: string;
  readonly selectAll: string;
  readonly selectRow: string;
  readonly selected: (count: number) => string;
  readonly shown: (count: number) => string;
  readonly rowActions: string;
  readonly edit: (label: string) => string;
  readonly yes: string;
  readonly no: string;
  /** An inline edit of a number that isn't one. */
  readonly notANumber: string;
}

const englishText: DataGridText = {
  search: "Search",
  columns: "Columns",
  loadMore: "Load more",
  empty: "Nothing here yet.",
  noMatches: "Nothing matches.",
  failed: "This list couldn't load",
  tryAgain: "Try again",
  all: "All",
  selectAll: "Select all rows",
  selectRow: "Select row",
  selected: (count) => `${count} selected`,
  shown: (count) => `${count} shown`,
  rowActions: "Row actions",
  edit: (label) => `Edit ${label}`,
  yes: "Yes",
  no: "No",
  notANumber: "Enter a number.",
};

/** What every column of a grid is, read from its spec. */
interface ReadColumn<Row> {
  readonly field: FieldOf<Row>;
  readonly label: string;
  readonly sortable: boolean;
  readonly filter: Readonly<Partial<Record<string, string>>> | undefined;
  readonly hidden: boolean;
  readonly cell: ((row: Row) => ReactNode) | undefined;
  readonly edit: ((row: Row, value: unknown) => Promise<unknown>) | undefined;
}

const camelBreak = /(?<=[a-z0-9])(?=[A-Z])/gu;

/** A field's name in words: `_createdAt` as "Created at". */
export const labelOfField = (field: string): string => {
  const words = field
    .replace(/^_+/u, "")
    .split(camelBreak)
    .join(" ")
    .replaceAll("_", " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const readColumn = <Row,>(spec: DataGridColumn<Row>): ReadColumn<Row> => {
  if (typeof spec === "string") {
    return {
      field: spec,
      label: labelOfField(spec),
      sortable: false,
      filter: undefined,
      hidden: false,
      cell: undefined,
      edit: undefined,
    };
  }
  return {
    field: spec.field,
    label: spec.label ?? labelOfField(spec.field),
    sortable: spec.sortable === true,
    filter: spec.filter,
    hidden: spec.hidden === true,
    cell: spec.cell,
    // SAFETY: an editor hands `edit` a value of the type the field holds
    // (`EditValue`): text for text, a number for a number, a boolean for
    // a boolean (`editorKindOf`).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    edit: spec.edit as ReadColumn<Row>["edit"],
  };
};

/** A record's key among the rows: its `_id`, or where it is. */
const keyOf = (row: unknown, index: number): string =>
  typeof row === "object" &&
  row !== null &&
  "_id" in row &&
  typeof row._id === "string"
    ? row._id
    : `#${index}`;

/** `row`'s value of `field`. */
const valueOf = (row: unknown, field: string): unknown =>
  typeof row === "object" && row !== null && Object.hasOwn(row, field)
    ? Reflect.get(row, field)
    : undefined;

/** A value as a cell shows it when its column says nothing else. */
const shownValue = (value: unknown, text: DataGridText): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? text.yes : text.no;
  }
  if (Array.isArray(value)) {
    return value.map((item) => shownValue(item, text)).join(", ");
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return value.toString();
  }
  return typeof value === "object" ? JSON.stringify(value) : "";
};

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

/** How a cell's value is edited: as text, a number, or a yes or no. */
type EditorKind = "text" | "number" | "boolean";

const editorKindOf = (value: unknown): EditorKind => {
  if (typeof value === "number") {
    return "number";
  }
  return typeof value === "boolean" ? "boolean" : "text";
};

/** Why a save failed, as a person reads it. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A cell the person can edit in place, saving through its column's `edit`. */
const EditableCell = <Row,>({
  row,
  column,
  text,
}: {
  row: Row;
  column: ReadColumn<Row>;
  text: DataGridText;
}): React.JSX.Element => {
  const value = valueOf(row, column.field);
  const kind = editorKindOf(value);
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  // One save at a time: Enter and the blur that follows it are one edit.
  const pending = useRef(false);
  const [failure, setFailure] = useState<string>();
  const failureId = useId();
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
      failed = messageOf(error);
    }
    pending.current = false;
    setSaving(false);
    setFailure(failed);
    if (failed === undefined) {
      setDraft(undefined);
    }
  };
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
          aria-describedby={failure === undefined ? undefined : failureId}
          aria-label={text.edit(column.label)}
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
        aria-label={`${text.edit(column.label)}: ${shownValue(value, text)}`}
        onClick={() => {
          setDraft(shownValue(value, text));
          setFailure(undefined);
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        {column.cell === undefined ? shownValue(value, text) : column.cell(row)}
      </Button>
    );
  }
  const commit = (): void => {
    if (draft === shownValue(value, text)) {
      setDraft(undefined);
      return;
    }
    if (kind === "number") {
      const number = Number(draft);
      if (draft.trim() === "" || !Number.isFinite(number)) {
        setFailure(text.notANumber);
        return;
      }
      void save(number);
      return;
    }
    void save(draft);
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          aria-describedby={failure === undefined ? undefined : failureId}
          aria-invalid={failure !== undefined}
          aria-label={text.edit(column.label)}
          autoFocus
          disabled={saving}
          onBlur={commit}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
            if (event.key === "Escape") {
              setDraft(undefined);
              setFailure(undefined);
            }
          }}
          type={kind === "number" ? "number" : "text"}
          value={draft}
        />
        {saving ? <Spinner aria-hidden /> : null}
      </div>
      {failureShown}
    </div>
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
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [acting, setActing] = useState(false);
  const rows = list.items.map((row, index) => ({
    key: keyOf(row, index),
    row,
  }));
  // The selection is of the rows shown now: one gone from the list drops out.
  const chosen = rows.filter(({ key }) => selected.has(key));
  const selectable = bulkActions.length > 0;
  const allChosen = rows.length > 0 && chosen.length === rows.length;
  const width =
    columns.length + (selectable ? 1 : 0) + (rowActions.length > 0 ? 1 : 0);
  const loadingFirst = list.isLoading && rows.length === 0;
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
    body = rows.map(({ key, row }) => (
      <TableRow
        data-state={selected.has(key) ? "selected" : undefined}
        key={key}
      >
        {selectable ? (
          <TableCell>
            <Checkbox
              aria-label={text.selectRow}
              checked={selected.has(key)}
              onCheckedChange={(checked) => {
                const next = new Set(selected);
                if (checked) {
                  next.add(key);
                } else {
                  next.delete(key);
                }
                setSelected(next);
              }}
            />
          </TableCell>
        ) : null}
        {columns.map((column) => (
          <TableCell key={column.field}>
            {column.edit === undefined ? (
              (column.cell?.(row) ??
              shownValue(valueOf(row, column.field), text))
            ) : (
              <EditableCell column={column} row={row} text={text} />
            )}
          </TableCell>
        ))}
        {rowActions.length > 0 ? (
          <TableCell variant="end">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label={text.rowActions}
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
                      void action.onSelect(row);
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
      {selectable && chosen.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2" role="toolbar">
          <span className="text-sm">{text.selected(chosen.length)}</span>
          {bulkActions.map((action) => (
            <Button
              disabled={acting}
              key={action.label}
              onClick={() => {
                const act = async (): Promise<void> => {
                  setActing(true);
                  let done = false;
                  try {
                    await action.onSelect(chosen.map(({ row }) => row));
                    done = true;
                  } catch {
                    // The action says why it failed itself; the selection
                    // stays, to try again.
                  }
                  setActing(false);
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
                  disabled={rows.length === 0}
                  indeterminate={chosen.length > 0 && !allChosen}
                  onCheckedChange={(checked) => {
                    setSelected(
                      new Set(checked ? rows.map(({ key }) => key) : [])
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
                <span className="sr-only">{text.rowActions}</span>
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
  onRetry,
  text,
}: {
  error: unknown;
  onRetry: () => void;
  text: DataGridText;
}): React.JSX.Element => {
  const retryFailed = useRetryFailed();
  return (
    <Alert live="assertive" variant="destructive">
      <AlertTitle>{text.failed}</AlertTitle>
      <AlertDescription>
        <p>{messageOf(error)}</p>
        <p>
          <Button
            onClick={() => {
              retryFailed();
              onRetry();
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

interface BoundaryProps {
  readonly children: ReactNode;
  readonly text: DataGridText;
  /** What the rows are read for: another search or filter reads them afresh. */
  readonly reading: string;
}

interface BoundaryState {
  readonly failure: { readonly error: unknown } | null;
  readonly reading: string;
}

/**
 * Catches the grid's query failing, which `usePaginatedQuery` throws while
 * rendering, so it shows in the grid's place rather than the screen's.
 * React offers no hook for this; the React Compiler leaves classes as
 * they are.
 */
class GridBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failure: null, reading: props.reading };
  }

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { failure: { error } };
  }

  static getDerivedStateFromProps(
    props: BoundaryProps,
    state: BoundaryState
  ): Partial<BoundaryState> | null {
    return props.reading === state.reading
      ? null
      : { failure: null, reading: props.reading };
  }

  override render(): ReactNode {
    const { failure } = this.state;
    if (failure === null) {
      return this.props.children;
    }
    return (
      <GridFailure
        error={failure.error}
        onRetry={() => {
          // A class's own state: the one way out of a caught failure.
          // oxlint-disable-next-line react/no-set-state -- see above
          this.setState({ failure: null });
        }}
        text={this.props.text}
      />
    );
  }
}

/** How long typing settles before a search reaches the query. */
const searchSettleMs = 300;

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
  /** What a row's menu offers. */
  readonly rowActions?: readonly DataGridRowAction<PageItemOf<Reference>>[];
  /** What the selected rows can have done to them: rows become selectable. */
  readonly bulkActions?: readonly DataGridBulkAction<PageItemOf<Reference>>[];
  /** What it says, besides its title, when there are no records. */
  readonly empty?: ReactNode;
  /** What it says, in the screen's language. */
  readonly text?: Partial<DataGridText>;
}

const noActions: readonly never[] = [];

/**
 * A table of the records `query` answers, read page by page: search,
 * sorting and filters handed to the query, columns the person can hide,
 * rows they can select for bulk actions, a menu of actions per row, and
 * cells edited in place through a mutation.
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
 *     { field: "name", sortable: true, edit: (row, name) => rename({ id: row._id, name }) },
 *     { field: "status", filter: { active: "Active", archived: "Archived" } },
 *     "email",
 *   ]}
 *   search="Search customers"
 *   bulkActions={[{ label: "Archive", onSelect: (rows) => archive({ ids: rows.map((row) => row._id) }) }]}
 *   rowActions={[{ label: "Open", onSelect: (row) => navigate(screens.customer, { id: row._id }) }]}
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
  rowActions = noActions,
  bulkActions = noActions,
  empty,
  text: ownText,
}: DataGridProps<Reference>): React.JSX.Element => {
  const text: DataGridText = { ...englishText, ...ownText };
  const columns = specs.map((spec) => readColumn(spec));
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
      <div className="flex flex-wrap items-center gap-2" role="toolbar">
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
      <GridBoundary reading={JSON.stringify(listArgs)} text={text}>
        <GridRows
          args={listArgs}
          bulkActions={bulkActions}
          columns={shown}
          empty={empty}
          label={label}
          narrowed={narrowed}
          onSort={(field) => {
            setSort(nextSort(sort, field));
          }}
          pageSize={pageSize}
          query={query}
          rowActions={rowActions}
          state={state}
          text={text}
        />
      </GridBoundary>
    </div>
  );
};
