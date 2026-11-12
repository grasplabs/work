import { appDataErrors } from "@grasp-os/shared/app-data";
import type {
  AppDataImportPreview,
  AppDataImportResult,
  AppDataRecord,
  AppDataTable,
  RecordChange,
} from "@grasp-os/shared/app-data";
import type { AuditActor } from "@grasp-os/shared/audit";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  RecordGrid,
  RecordGridHeader,
  RecordGridValue,
} from "@grasp-os/ui/components/record-grid";
import type { RecordGridColumn } from "@grasp-os/ui/components/record-grid";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import {
  ArrowUpDownIcon,
  DownloadIcon,
  SearchIcon,
  UploadIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { downloadCsv } from "../csv.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime, valueText } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";

// An App's data, for its builders and the admins (core's app-data.ts):
// pick a table, page through its records, open one to read its fields and
// its change history, export a table as CSV and import CSV rows into one.
// Reading only, but for an import, which core checks row by row and lands
// whole or not at all.

/**
 * `call`'s answer, or undefined once core says the App's version moved
 * on from the one the page read (`app_data.version_changed`), which
 * `onStale` hears: the page offers a reload rather than an error.
 */
const unlessStale = async <T,>(
  call: () => Promise<T>,
  onStale: () => void
): Promise<T | undefined> => {
  try {
    return await call();
  } catch (error) {
    if (appDataErrors.codeOf(error) === "app_data.version_changed") {
      onStale();
      return undefined;
    }
    throw error;
  }
};

const ops = {
  insert: msg({ message: "Added", context: "a record was added" }),
  update: msg({ message: "Changed", context: "a record's fields changed" }),
  delete: msg({ message: "Deleted", context: "a record was deleted" }),
} as const satisfies Record<RecordChange["op"], unknown>;

const sources = {
  commit: msg({ message: "by the App", context: "a change's source" }),
  cascade: msg({
    message: "with a record it referred to",
    context: "a change's source: deleted with a record it pointed at",
  }),
  import: msg({ message: "by an import", context: "a change's source" }),
} as const satisfies Record<RecordChange["source"], unknown>;

const leftOut = {
  sensitive: msg`Values aren't kept: the table is sensitive.`,
  too_large: msg`Values aren't kept: they were too large.`,
  unread: msg`Values weren't read.`,
  erased: msg`Values were erased with the person who wrote them.`,
} as const satisfies Record<
  NonNullable<RecordChange["valuesLeftOut"]>,
  unknown
>;

/** Who made a change, as people read it. */
const actorText = (actor: AuditActor): string => {
  switch (actor.type) {
    case "person":
    case "staff": {
      return actor.userId;
    }
    case "agent": {
      const person = actor.onBehalfOf;
      return i18n._(msg`Agent for ${person}`);
    }
    case "visitor": {
      return i18n._(msg`A visitor`);
    }
    case "workflow": {
      const workflow = actor.workflowId;
      return i18n._(msg`Workflow ${workflow}`);
    }
    case "app":
    case "guest": {
      const app = actor.appId;
      return i18n._(msg`App ${app}`);
    }
    case "system": {
      return i18n._(msg`Grasp`);
    }
    default: {
      return i18n._(msg`Grasp`);
    }
  }
};

/** One change of a record's history. */
const ChangeItem = ({ change }: { change: RecordChange }) => {
  const who = actorText(change.actor);
  const when = formatDateTime(change.at);
  return (
    <li className="flex flex-col gap-1 border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{i18n._(ops[change.op])}</Badge>
        <span className="text-muted-foreground">
          {i18n._(sources[change.source])}
        </span>
      </div>
      <p>
        <Trans>
          {who}, {when}
        </Trans>
      </p>
      {change.valuesLeftOut === null ? (
        <dl className="grid grid-cols-3 gap-x-2 gap-y-1">
          {change.fields.map((field) => (
            <div className="contents" key={field}>
              <dt className="font-medium">{field}</dt>
              <dd className="text-muted-foreground truncate">
                {change.before !== null && Object.hasOwn(change.before, field)
                  ? valueText(change.before[field])
                  : "–"}
              </dd>
              <dd className="truncate">
                {change.after !== null && Object.hasOwn(change.after, field)
                  ? valueText(change.after[field])
                  : "–"}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-muted-foreground">
          {change.fields.join(", ")} {i18n._(leftOut[change.valuesLeftOut])}
        </p>
      )}
    </li>
  );
};

/** A record's change history as read, and reading older changes. */
const RecordHistory = ({
  changes,
  failure,
  busy,
  onOlder,
}: {
  changes: RecordChange[] | undefined;
  failure: string | undefined;
  busy: boolean;
  onOlder: (() => void) | undefined;
}) => (
  <>
    <h3 className="font-medium">
      <Trans>History</Trans>
    </h3>
    {failure === undefined ? null : <ErrorText>{failure}</ErrorText>}
    {changes?.length === 0 ? (
      <p className="text-muted-foreground">
        <Trans>No changes are kept for this record.</Trans>
      </p>
    ) : (
      <ul>
        {changes?.map((change) => (
          <ChangeItem change={change} key={change.id} />
        ))}
      </ul>
    )}
    {onOlder === undefined ? null : (
      <Button disabled={busy} onClick={onOlder} size="sm" variant="outline">
        <Trans>Older changes</Trans>
      </Button>
    )}
  </>
);

/**
 * A record's fields and its change history, in a sheet: the history of
 * the live App's version `version`'s record; none for test data.
 */
const RecordSheet = ({
  app,
  table,
  version,
  record,
  stale,
  onStale,
  onClose,
}: {
  app: string;
  table: string;
  version: number | null;
  record: AppDataRecord;
  stale: boolean;
  onStale: () => void;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [changes, setChanges] = useState<RecordChange[]>();
  const [next, setNext] = useState<number | null>(null);
  const load = async (before: number | null) => {
    if (version === null) {
      return;
    }
    const page = await run(
      async (session) =>
        await unlessStale(
          async () =>
            await session.apps.data.history(
              app,
              table,
              version,
              record.id,
              before
            ),
          onStale
        )
    );
    if (page !== undefined) {
      setChanges([
        ...(before === null ? [] : (changes ?? [])),
        ...page.changes,
      ]);
      setNext(page.next);
    }
  };
  if (
    version !== null &&
    changes === undefined &&
    !busy &&
    failure === undefined &&
    !stale
  ) {
    void load(null);
  }
  const { id } = record;
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <SheetContent closeLabel={t`Close`} side="right">
        <SheetHeader>
          <SheetTitle>
            <Trans>Record {id}</Trans>
          </SheetTitle>
          <SheetDescription>
            {formatDateTime(record.updatedAt)}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 overflow-y-auto px-4 pb-4 text-sm">
          <dl className="grid grid-cols-3 gap-x-2 gap-y-1">
            {Object.entries(record.fields).map(([field, value]) => (
              <div className="contents" key={field}>
                <dt className="font-medium">{field}</dt>
                <dd className="col-span-2 break-words">{valueText(value)}</dd>
              </div>
            ))}
          </dl>
          {version === null ? null : (
            <RecordHistory
              busy={busy}
              changes={changes}
              failure={failure}
              onOlder={
                next === null
                  ? undefined
                  : () => {
                      void load(next);
                    }
              }
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};

/** The field to leave a column out of an import with. */
const leaveOut = "-";

/** Importing a CSV file into `table`: pick it, map its columns, import. */
const ImportDialog = ({
  app,
  table,
  version,
  onStale,
  onDone,
  onClose,
}: {
  app: string;
  table: AppDataTable;
  version: number;
  onStale: () => void;
  onDone: () => void;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [csv, setCsv] = useState<string>();
  const [preview, setPreview] = useState<AppDataImportPreview>();
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [result, setResult] = useState<AppDataImportResult>();
  const choose = async (file: File | undefined) => {
    // Whatever the last file showed goes at once: Import waits for this
    // one's preview, and stays off should it fail.
    setCsv(undefined);
    setPreview(undefined);
    setMapping({});
    setResult(undefined);
    if (file === undefined) {
      return;
    }
    const text = await file.text();
    const read = await run(
      async (session) =>
        await session.apps.data.previewImport(app, table.name, text)
    );
    if (read !== undefined) {
      setCsv(text);
      setPreview(read);
      setMapping(read.mapping);
    }
  };
  const start = async () => {
    if (csv === undefined) {
      return;
    }
    const done = await run(
      async (session) =>
        await unlessStale(
          async () =>
            await session.apps.data.import(app, table.name, {
              version,
              csv,
              mapping,
            }),
          onStale
        )
    );
    setResult(done);
    if (done?.ok === true) {
      onDone();
    }
  };
  const { name } = table;
  const fieldItems = [
    { value: leaveOut, label: t`Leave out` },
    ...table.fields.map((field) => ({ value: field.name, label: field.name })),
  ];
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            <Trans>Import into {name}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Every row is checked first. If one is wrong, nothing is added.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="app-data-file">
            <Trans>CSV file</Trans>
          </FieldLabel>
          <Input
            accept=".csv,text/csv"
            disabled={busy}
            id="app-data-file"
            onChange={(event) => {
              void choose(event.target.files?.[0]);
            }}
            type="file"
          />
        </Field>
        {preview === undefined ? null : (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground">
              <Plural
                one="# row to import."
                other="# rows to import."
                value={preview.rows}
              />
            </p>
            {preview.columns.map((column) => (
              <Field key={column} orientation="horizontal">
                <FieldLabel className="w-1/3">
                  <span className="truncate">{column}</span>
                </FieldLabel>
                <Select
                  items={fieldItems}
                  onValueChange={(value: unknown) => {
                    if (typeof value === "string") {
                      setMapping({
                        ...mapping,
                        [column]: value === leaveOut ? null : value,
                      });
                    }
                  }}
                  value={mapping[column] ?? leaveOut}
                >
                  <SelectTrigger
                    aria-label={t`Field for ${column}`}
                    className="flex-1"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {fieldItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ))}
          </div>
        )}
        {failure === undefined ? null : <ErrorText>{failure}</ErrorText>}
        {result?.ok === true ? (
          <p>
            <Plural
              one="# record added."
              other="# records added."
              value={result.inserted}
            />
          </p>
        ) : null}
        {result?.ok === false ? (
          <div className="flex flex-col gap-1">
            <ErrorText>
              {t`Nothing was added. Fix these rows and try again.`}
            </ErrorText>
            <ul className="text-muted-foreground max-h-48 overflow-y-auto">
              {result.errors.map((error) => {
                const { row, message } = error;
                const where = error.field ?? error.column ?? "";
                return (
                  <li key={`${row}:${where}:${error.message}`}>
                    {row === 0 ? (
                      <Trans>
                        File {where}: {message}
                      </Trans>
                    ) : (
                      <Trans>
                        Row {row} {where}: {message}
                      </Trans>
                    )}
                  </li>
                );
              })}
            </ul>
            {result.more ? (
              <p className="text-muted-foreground">
                <Trans>And more.</Trans>
              </p>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button
            disabled={busy || preview === undefined || result?.ok === true}
            onClick={() => {
              void start();
            }}
          >
            <UploadIcon data-icon="inline-start" />
            <Trans>Import</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** A column of a table's records: the field whose values it shows, and its header. */
export interface RecordColumn {
  field: string;
  header: ReactNode;
  width?: number;
}

/** A header that only names its column. */
export const PlainHeader = ({ children }: { children: ReactNode }) => (
  <RecordGridHeader>{children}</RecordGridHeader>
);

/** The grid's columns: each record's ID, which opens it, its fields, and when it last changed. */
const recordColumns = (
  columns: readonly RecordColumn[],
  onOpen: (record: AppDataRecord) => void
): RecordGridColumn<AppDataRecord>[] => [
  {
    id: "_id",
    width: 96,
    header: (
      <PlainHeader>
        <Trans>Record</Trans>
      </PlainHeader>
    ),
    cell: (record) => (
      <Button
        onClick={() => {
          onOpen(record);
        }}
        size="xs"
        title={record.id}
        variant="link"
      >
        {/* A UUIDv7 starts with its time, the same for records made
            together: its end tells them apart. */}
        <RecordGridValue tone="code">…{record.id.slice(-6)}</RecordGridValue>
      </Button>
    ),
  },
  ...columns.map(
    ({ field, header, width }): RecordGridColumn<AppDataRecord> => ({
      id: field,
      header,
      ...(width === undefined ? {} : { width }),
      cell: (record) => {
        const value = record.fields[field];
        return value === undefined || value === null ? null : (
          <RecordGridValue>{valueText(value)}</RecordGridValue>
        );
      },
    })
  ),
  {
    id: "_updatedAt",
    width: 168,
    header: (
      <PlainHeader>
        <Trans>Changed</Trans>
      </PlainHeader>
    ),
    cell: (record) => (
      <RecordGridValue tone="muted">
        {formatDateTime(record.updatedAt)}
      </RecordGridValue>
    ),
  },
];

/** What a read of records ran into: the App moved on, an ID found nothing, a failure. */
const RecordNotes = ({
  stale,
  missing,
  failure,
  onRetry,
}: {
  stale: boolean;
  missing: boolean;
  failure: string | undefined;
  /** Reads again what failed to load; none for a failure nothing reads again. */
  onRetry?: () => void;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  return (
    <>
      {stale ? (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <ErrorText>
            {t`This App changed. Reload to see its current version.`}
          </ErrorText>
          <Button
            onClick={() => {
              void router.invalidate();
            }}
            size="sm"
            variant="outline"
          >
            <Trans>Reload</Trans>
          </Button>
        </div>
      ) : null}
      {missing || failure !== undefined ? (
        <div className="flex items-center gap-2 border-b px-3 py-2">
          {missing ? (
            <p className="text-muted-foreground text-sm">
              <Trans>No record of this table has that ID.</Trans>
            </p>
          ) : null}
          <ErrorText>{failure}</ErrorText>
          {failure === undefined || onRetry === undefined ? null : (
            <Button onClick={onRetry} size="sm" variant="outline">
              <Trans>Try again</Trans>
            </Button>
          )}
        </div>
      ) : null}
    </>
  );
};

/**
 * Where a table's records are read: the live App's, under the version
 * whose tables the page read; or the test data of the preview of the
 * App's draft (`apps.drafts.testRecords`), which nothing records,
 * exports or imports.
 */
export type RecordSource = { kind: "live"; version: number } | { kind: "test" };

/** A table, and where its records are read. */
interface ReadTable {
  table: AppDataTable;
  source: RecordSource;
}

/**
 * The records of `read`'s table, a page at a time, read apart from what
 * else the page does: the first page at once, the next one on `handleEnd`
 * (none while a read is out, once the last came, or after one failed),
 * all again on `reload`; and how many there are, when that's known.
 */
const useRecordPages = (
  app: string,
  live: ReadTable | undefined,
  stale: boolean,
  onStale: () => void
) => {
  const { busy, failure, run } = useCoreAction();
  const [records, setRecords] = useState<AppDataRecord[]>();
  const [cursor, setCursor] = useState<string | null>(null);
  const load = async (from: string | null) => {
    if (live === undefined) {
      return;
    }
    const { table, source } = live;
    const page = await run(
      async (session) =>
        await (source.kind === "test"
          ? session.apps.drafts.testRecords(app, table.name, from)
          : unlessStale(
              async () =>
                await session.apps.data.records(
                  app,
                  table.name,
                  source.version,
                  from
                ),
              onStale
            ))
    );
    if (page !== undefined) {
      setRecords([...(from === null ? [] : (records ?? [])), ...page.records]);
      setCursor(page.cursor);
    }
  };
  const idle = !busy && failure === undefined;
  if (live !== undefined && records === undefined && idle && !stale) {
    void load(null);
  }
  return {
    records: records ?? [],
    failure,
    // The table's count, or, once the last page came, the records read.
    total:
      live?.table.records ?? (cursor === null ? records?.length : undefined),
    /** Reads again the page that failed: the first, or the one after the last read. */
    retry: () => {
      void load(records === undefined ? null : cursor);
    },
    handleEnd: () => {
      if (cursor !== null && idle) {
        void load(cursor);
      }
    },
    reload: () => {
      void load(null);
    },
  };
};

/**
 * The records bar's actions: one field that finds a record by its ID,
 * and one menu to export the table's records, or import some.
 */
const RecordActions = ({
  busy,
  importable,
  onFind,
  onExport,
  onImport,
}: {
  busy: boolean;
  importable: boolean;
  onFind: (id: string) => void;
  onExport: () => void;
  onImport: () => void;
}) => {
  const { t } = useLingui();
  const [wanted, setWanted] = useState("");
  return (
    <>
      <search>
        <form
          className="w-56"
          onSubmit={(event) => {
            event.preventDefault();
            if (wanted.trim() !== "" && !busy) {
              onFind(wanted);
            }
          }}
        >
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={t`Find a record by its ID`}
              onChange={(event) => {
                setWanted(event.target.value);
              }}
              placeholder={t`Find a record by its ID`}
              type="search"
              value={wanted}
            />
          </InputGroup>
        </form>
      </search>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy}
          render={
            <Button
              aria-label={t`Import or export`}
              size="icon-sm"
              title={t`Import or export`}
              variant="ghost"
            />
          }
        >
          <ArrowUpDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onExport}>
            <DownloadIcon />
            <Trans>Export as CSV</Trans>
          </DropdownMenuItem>
          {importable ? (
            <DropdownMenuItem onClick={onImport}>
              <UploadIcon />
              <Trans>Import from CSV</Trans>
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
};

/**
 * One table's records in a grid, a page at a time, read from `source`:
 * the live App's, with find, export and import, the App's version read;
 * or the draft preview's test data. Its columns are the page's
 * (`columns`, by field), and the start of the bar above it (`toolbar`)
 * the page's too, its end too (`end`). The next page loads as the grid
 * nears its last row, so a table of any size scrolls through. None for a
 * table the source doesn't have (`table` undefined), or with no source.
 */
export const TableRecords = ({
  app,
  source,
  table,
  label,
  columns,
  toolbar,
  end,
  instead,
}: {
  app: string;
  source: RecordSource | null;
  table: AppDataTable | undefined;
  label: string;
  columns: RecordColumn[];
  toolbar?: ReactNode;
  end?: ReactNode;
  /** What the page shows in place of the records (the table's fields), if anything. */
  instead?: ReactNode;
}) => {
  const router = useRouter();
  // An export or a lookup that fails never stops the paging.
  const action = useCoreAction();
  // Core has another version current than the one this page read.
  const [stale, setStale] = useState(false);
  const onStale = () => {
    setStale(true);
  };
  const [open, setOpen] = useState<AppDataRecord>();
  const [importing, setImporting] = useState(false);
  const [missing, setMissing] = useState(false);
  const read =
    table !== undefined && source !== null ? { table, source } : undefined;
  const pages = useRecordPages(app, read, stale, onStale);
  // The live App's version read: what find, export and import name.
  const live =
    table !== undefined && source?.kind === "live"
      ? { table, version: source.version }
      : undefined;
  const exportTable = async (name: string) => {
    const text = await action.run(
      async (session) =>
        await new Response(await session.apps.data.export(app, name)).text()
    );
    if (text !== undefined) {
      downloadCsv(text, `${name}.csv`);
    }
  };
  const find = async (wanted: string) => {
    if (live === undefined) {
      return;
    }
    setMissing(false);
    const found = await action.run(
      async (session) =>
        await unlessStale(
          async () =>
            await session.apps.data.record(
              app,
              live.table.name,
              live.version,
              wanted.trim()
            ),
          onStale
        )
    );
    if (found === null) {
      setMissing(true);
    } else if (found !== undefined) {
      setOpen(found);
    }
  };
  const gridColumns = recordColumns(columns, setOpen);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-2 border-b px-3 py-1.5">
        {toolbar}
        <div className="flex-1" />
        {end}
        {live === undefined || instead !== undefined ? null : (
          <RecordActions
            busy={action.busy}
            importable={live.table.write !== "none"}
            onExport={() => {
              void exportTable(live.table.name);
            }}
            onFind={(id) => {
              void find(id);
            }}
            onImport={() => {
              setImporting(true);
            }}
          />
        )}
      </div>
      {instead}
      {instead === undefined ? (
        <RecordNotes
          failure={pages.failure ?? action.failure}
          {...(pages.failure === undefined ? {} : { onRetry: pages.retry })}
          missing={missing}
          stale={stale}
        />
      ) : null}
      {instead === undefined ? (
        <RecordGrid
          columns={gridColumns}
          empty={
            <p className="text-muted-foreground px-3 py-6 text-sm">
              <Trans>No records</Trans>
            </p>
          }
          label={label}
          onEndReached={pages.handleEnd}
          rowKey={(record) => record.id}
          rows={pages.records}
          total={pages.total}
        />
      ) : null}
      {open === undefined || read === undefined ? null : (
        <RecordSheet
          app={app}
          onClose={() => {
            setOpen(undefined);
          }}
          onStale={onStale}
          record={open}
          stale={stale}
          table={read.table.name}
          version={live?.version ?? null}
        />
      )}
      {importing && live !== undefined ? (
        <ImportDialog
          app={app}
          onClose={() => {
            setImporting(false);
          }}
          onDone={() => {
            pages.reload();
            // The table list's counts, read again.
            void router.invalidate();
          }}
          onStale={onStale}
          table={live.table}
          version={live.version}
        />
      ) : null}
    </div>
  );
};

/** An App's live tables, one picked at a time, and its records. */
export const AppData = ({
  app,
  version,
  tables,
}: {
  app: string;
  /** The version whose tables these are: every read and import names it. */
  version: number | null;
  tables: AppDataTable[];
}) => {
  const { t } = useLingui();
  // The table picked, with the App it was picked in: another App
  // opened on the same page starts from its own first table.
  const [picked, setPicked] = useState({ app, table: tables[0]?.name });
  const wanted = picked.app === app ? picked.table : tables[0]?.name;
  const table = tables.find(({ name }) => name === wanted) ?? tables.at(0);
  if (table === undefined || version === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <Trans>No tables</Trans>
          </EmptyTitle>
          <EmptyDescription>
            {t`The App's live version keeps no data.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const items = tables.map(({ name }) => ({ value: name, label: name }));
  return (
    <TableRecords
      app={app}
      // Its own state for each App and table: nothing read of one is
      // shown, or kept, for another.
      key={`${app}/${version}/${table.name}`}
      columns={table.fields.map(({ name }) => ({
        field: name,
        header: <PlainHeader>{name}</PlainHeader>,
      }))}
      label={table.name}
      table={table}
      toolbar={
        <Select
          items={items}
          onValueChange={(value: unknown) => {
            if (typeof value === "string") {
              setPicked({ app, table: value });
            }
          }}
          value={table.name}
        >
          <SelectTrigger aria-label={t`Table`} className="w-56" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      source={{ kind: "live", version }}
    />
  );
};
