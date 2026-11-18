import { appDataErrors } from "@grasp-os/shared/app-data";
import type {
  AppDataImportPreview,
  AppDataImportResult,
  AppDataRecord,
  AppDataTable,
  RecordChange,
} from "@grasp-os/shared/app-data";
import type { AuditActor } from "@grasp-os/shared/audit";
import { i18n } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { downloadCsv } from "../csv.ts";
import { readPeople } from "../directory.ts";
import { formatDateTime, valueText } from "../format.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { DataTable } from "../grasp/data-table/index.ts";
import type { DataTableColumn } from "../grasp/data-table/index.ts";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { FileUpload } from "../grasp/file-upload/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import {
  Database,
  Download,
  Icon,
  Search,
  Sortable,
  Upload,
} from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "../grasp/sheet/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";

// An App's data, for its builders and the admins (core's app-data.ts):
// pick a table, page through its records, open one to read its fields and
// its change history, export a table as CSV and import CSV rows into one.
// Reading only, but for an import, which core checks row by row and lands
// whole or not at all.

// Grasp UI has no token for a toolbar field's measure: the table picker
// and the find-by-ID field are as wide as the old grid's bar had them.
const BAR_FIELD = "14rem";

/**
 * A record by what people call it: its `title` or `name` field where it
 * has one as text, else the end of its ID, as the table shows it.
 */
const recordName = (record: {
  id: string;
  fields: Record<string, unknown>;
}): string => {
  for (const field of ["title", "name"]) {
    const value = record.fields[field];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return `…${record.id.slice(-6)}`;
};

const styles = stylex.create({
  // The records: their bar, what a read ran into, then the table, which
  // scrolls on its own while the bar stays.
  records: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
  },
  bar: {
    display: "flex",
    flexShrink: 0,
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space3,
    borderBottomStyle: "solid",
    borderBottomWidth: grasp.hairline,
    borderBottomColor: grasp.line,
  },
  spacer: { flexGrow: 1 },
  barField: { width: BAR_FIELD, maxWidth: "100%" },
  notes: {
    display: "grid",
    flexShrink: 0,
    gap: grasp.space2,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space3,
  },
  // A note, and what to do about it beside it.
  note: { display: "flex", alignItems: "center", gap: grasp.space2 },
  noteWords: { flexGrow: 1 },
  grid: { flexGrow: 1, minHeight: 0, overflow: "auto" },
  // A record's sheet and a history entry: their parts, one under the other.
  stack: { display: "grid", gap: grasp.space4 },
  entry: { display: "grid", gap: grasp.space2 },
  entryHead: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  list: {
    display: "grid",
    gap: grasp.space4,
    margin: 0,
    padding: 0,
    listStyleType: "none",
  },
  start: { justifySelf: "start" },
  // The import's columns, each beside the field it lands in.
  mapping: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 2fr)",
    alignItems: "center",
    gap: grasp.space3,
  },
  errors: {
    maxHeight: "12rem",
    overflowY: "auto",
    margin: 0,
    paddingInlineStart: grasp.space4,
  },
});

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

/** Who made a change, as people read it: a person by name, where it is known. */
const actorText = (
  actor: AuditActor,
  people: ReadonlyMap<string, string>
): string => {
  switch (actor.type) {
    case "person":
    case "staff": {
      return (
        people.get(actor.userId) ?? i18n._(msg`Someone in the organization`)
      );
    }
    case "agent": {
      const person =
        people.get(actor.onBehalfOf) ??
        i18n._(msg`someone in the organization`);
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

/** A value a change held, or a dash where it held none. */
const heldText = (
  values: Record<string, unknown> | null,
  field: string
): string =>
  values !== null && Object.hasOwn(values, field)
    ? valueText(values[field])
    : "–";

/** One change of a record's history: what, by whom and when, and each field before and after. */
const ChangeItem = ({
  change,
  people,
}: {
  change: RecordChange;
  people: ReadonlyMap<string, string>;
}) => {
  const { t } = useLingui();
  const who = actorText(change.actor, people);
  const when = formatDateTime(change.at);
  const fields = change.fields.join(", ");
  return (
    <li {...stylex.props(styles.entry)}>
      <div {...stylex.props(styles.entryHead)}>
        <Badge size="sm">{i18n._(ops[change.op])}</Badge>
        <Text element="span" size="sm" tone="muted">
          {i18n._(sources[change.source])}
        </Text>
      </div>
      <Text size="sm">{t`${who}, ${when}`}</Text>
      {change.valuesLeftOut === null ? (
        // Each field it changed, before then after: a list, which a narrow
        // sheet holds whole where a table's columns would be cut off.
        <KeyValueList
          items={change.fields.map((field) => {
            const before = heldText(change.before, field);
            const after = heldText(change.after, field);
            return {
              key: field,
              value: t({
                message: `${before} → ${after}`,
                comment: "A field's value before a change, then after it.",
              }),
            };
          })}
          variant="inline"
        />
      ) : (
        <Text size="sm" tone="muted">
          {fields} {i18n._(leftOut[change.valuesLeftOut])}
        </Text>
      )}
    </li>
  );
};

/** A record's change history as read, and reading older changes. */
const RecordHistory = ({
  changes,
  people,
  failure,
  busy,
  onOlder,
}: {
  changes: RecordChange[] | undefined;
  /** People's names by ID, where they could be read. */
  people: ReadonlyMap<string, string>;
  failure: string | undefined;
  busy: boolean;
  onOlder: (() => void) | undefined;
}) => {
  const { t } = useLingui();
  return (
    <section {...stylex.props(styles.stack)}>
      <Heading level={3} size="ui">
        {t`History`}
      </Heading>
      {failure === undefined ? null : <Alert tone="danger">{failure}</Alert>}
      {changes?.length === 0 ? (
        <Text size="sm" tone="muted">
          {t`No changes are kept for this record.`}
        </Text>
      ) : (
        <ul {...stylex.props(styles.list)}>
          {changes?.map((change) => (
            <ChangeItem change={change} key={change.id} people={people} />
          ))}
        </ul>
      )}
      {onOlder === undefined ? null : (
        <Button
          disabled={busy}
          layout={styles.start}
          onClick={onOlder}
          size="sm"
        >
          {t`Older changes`}
        </Button>
      )}
    </section>
  );
};

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
  const [people, setPeople] = useState<ReadonlyMap<string, string>>(new Map());
  const load = async (before: number | null) => {
    if (version === null) {
      return;
    }
    const read = await run(
      async (session) =>
        await Promise.all([
          unlessStale(
            async () =>
              await session.apps.data.history(
                app,
                table,
                version,
                record.id,
                before
              ),
            onStale
          ),
          // Names for whoever made a change, once: none where they can't be listed.
          before === null ? readPeople(session) : undefined,
        ])
    );
    const [page, named] = read ?? [];
    if (named !== undefined) {
      setPeople(named);
    }
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
  const shown = recordName(record);
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <SheetContent closeLabel={t`Close`}>
        <SheetTitle>{shown}</SheetTitle>
        <SheetDescription>{formatDateTime(record.updatedAt)}</SheetDescription>
        <SheetBody>
          <div {...stylex.props(styles.stack)}>
            <KeyValueList
              items={Object.entries(record.fields).map(([field, value]) => ({
                key: field,
                value: valueText(value),
              }))}
            />
            {version === null ? null : (
              <RecordHistory
                busy={busy}
                changes={changes}
                people={people}
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
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
};

/** The field to leave a column out of an import with. */
const leaveOut = "-";

/** What core refused of an import: each row's problem, and whether there were more. */
const ImportErrors = ({
  errors,
  more,
}: {
  errors: Extract<AppDataImportResult, { ok: false }>["errors"];
  more: boolean;
}) => {
  const { t } = useLingui();
  return (
    <Alert
      title={t`Nothing was added. Fix these rows and try again.`}
      tone="danger"
    >
      <ul {...stylex.props(styles.errors)}>
        {errors.map((error) => {
          const { row, message } = error;
          const where = error.field ?? error.column ?? "";
          return (
            <li key={`${row}:${where}:${error.message}`}>
              {row === 0
                ? t`File ${where}: ${message}`
                : t`Row ${row} ${where}: ${message}`}
            </li>
          );
        })}
      </ul>
      {more ? t`And more.` : null}
    </Alert>
  );
};

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
  const rows = preview?.rows ?? 0;
  const inserted = result?.ok === true ? result.inserted : 0;
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
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Import into ${name}`}</DialogTitle>
        <DialogDescription>
          {t`Every row is checked first. If one is wrong, nothing is added.`}
        </DialogDescription>
        <DialogBody>
          <div {...stylex.props(styles.stack)}>
            <Field>
              <FieldLabel>{t`CSV file`}</FieldLabel>
              <FileUpload
                accept={[".csv", "text/csv"]}
                disabled={busy}
                onValueChange={(files) => {
                  void choose(files[0]);
                }}
              />
            </Field>
            {preview === undefined ? null : (
              <>
                <Text size="sm" tone="muted">
                  {t`${plural(rows, {
                    one: "# row to import.",
                    other: "# rows to import.",
                  })}`}
                </Text>
                <div {...stylex.props(styles.mapping)}>
                  {preview.columns.map((column) => (
                    <Field key={column} orientation="horizontal">
                      <Text element="span" size="sm" wrap="truncate">
                        {column}
                      </Text>
                      <Select
                        items={fieldItems}
                        onValueChange={(value) => {
                          if (typeof value === "string") {
                            setMapping({
                              ...mapping,
                              [column]: value === leaveOut ? null : value,
                            });
                          }
                        }}
                        value={mapping[column] ?? leaveOut}
                      >
                        <SelectTrigger aria-label={t`Field for ${column}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent />
                      </Select>
                    </Field>
                  ))}
                </div>
              </>
            )}
            {failure === undefined ? null : (
              <Alert tone="danger">{failure}</Alert>
            )}
            {result?.ok === true ? (
              <Alert tone="success">
                {t`${plural(inserted, {
                  one: "# record added.",
                  other: "# records added.",
                })}`}
              </Alert>
            ) : null}
            {result?.ok === false ? (
              <ImportErrors errors={result.errors} more={result.more} />
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            disabled={busy || preview === undefined || result?.ok === true}
            icon={Upload}
            onClick={() => {
              void start();
            }}
            variant="ink"
          >
            {t`Import`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** A column of a table's records: the field whose values it shows, and its name in the head. */
export interface RecordColumn {
  field: string;
  header: string;
}

/** The words the record columns say, translated where they are made. */
interface RecordColumnWords {
  record: string;
  changed: string;
}

/** The table's columns: each record's ID, which opens it, its fields, and when it last changed. */
const recordColumns = (
  columns: readonly RecordColumn[],
  words: RecordColumnWords,
  onOpen: (record: AppDataRecord) => void
): DataTableColumn<AppDataRecord>[] => [
  {
    key: "_id",
    header: words.record,
    control: true,
    value: (record) => record.id,
    cell: (record) => (
      <Button
        onClick={() => {
          onOpen(record);
        }}
        size="xs"
        title={record.id}
        variant="ghost"
      >
        {/* A UUIDv7 starts with its time, the same for records made
            together: its end tells them apart. */}
        {`…${record.id.slice(-6)}`}
      </Button>
    ),
  },
  ...columns.map(({ field, header }): DataTableColumn<AppDataRecord> => ({
    key: field,
    header,
    value: (record) => {
      const value = record.fields[field];
      return value === undefined || value === null ? "" : valueText(value);
    },
  })),
  {
    key: "_updatedAt",
    header: words.changed,
    value: (record) => record.updatedAt,
    cell: (record) => (
      <Text element="span" size="sm" tone="muted">
        {formatDateTime(record.updatedAt)}
      </Text>
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
  if (!stale && !missing && failure === undefined) {
    return null;
  }
  return (
    <div {...stylex.props(styles.notes)}>
      {stale ? (
        <div {...stylex.props(styles.note)}>
          <Alert layout={styles.noteWords} tone="attention">
            {t`This App changed. Reload to see its current version.`}
          </Alert>
          <Button
            onClick={() => {
              void router.invalidate();
            }}
            size="sm"
          >
            {t`Reload`}
          </Button>
        </div>
      ) : null}
      {missing ? (
        <Alert>{t`No record of this table has that ID.`}</Alert>
      ) : null}
      {failure === undefined ? null : (
        <div {...stylex.props(styles.note)}>
          <Alert layout={styles.noteWords} tone="danger">
            {failure}
          </Alert>
          {onRetry === undefined ? null : (
            <Button onClick={onRetry} size="sm">
              {t`Try again`}
            </Button>
          )}
        </div>
      )}
    </div>
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
 * all again on `reload`.
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
    /** The first page is on its way. */
    loading: records === undefined && busy,
    /** A next page is on its way. */
    loadingMore: records !== undefined && busy,
    /** There is a next page to read. */
    more: records !== undefined && cursor !== null,
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
          onSubmit={(event) => {
            event.preventDefault();
            if (wanted.trim() !== "" && !busy) {
              onFind(wanted);
            }
          }}
          {...stylex.props(styles.barField)}
        >
          <InputGroup>
            <InputGroupText>
              <Icon icon={Search} />
            </InputGroupText>
            <InputGroupInput
              aria-label={t`Find a record by its ID`}
              onValueChange={(value: string) => {
                setWanted(value);
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
          aria-label={t`Import or export`}
          disabled={busy}
          icon={Sortable}
          size="sm"
          title={t`Import or export`}
          variant="ghost"
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem icon={Download} onSelect={onExport}>
            {t`Export as CSV`}
          </DropdownMenuItem>
          {importable ? (
            <DropdownMenuItem icon={Upload} onSelect={onImport}>
              {t`Import from CSV`}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
};

/**
 * One table's records in a table, a page at a time, read from `source`:
 * the live App's, with find, export and import, the App's version read;
 * or the draft preview's test data. Its columns are the page's
 * (`columns`, by field), and the start of the bar above it (`toolbar`)
 * the page's too, its end too (`end`). The next page loads as the last
 * row comes into view, so a table of any size scrolls through. None for
 * a table the source doesn't have (`table` undefined), or with no source.
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
  const { t } = useLingui();
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
  const tableColumns = recordColumns(
    columns,
    { record: t`Record`, changed: t`Changed` },
    setOpen
  );
  return (
    <div {...stylex.props(styles.records)}>
      <div {...stylex.props(styles.bar)}>
        {toolbar}
        <span {...stylex.props(styles.spacer)} />
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
        <div {...stylex.props(styles.grid)}>
          <DataTable
            columns={tableColumns}
            density="compact"
            empty={{ description: t`No records` }}
            hasMore={pages.more && pages.failure === undefined}
            label={label}
            loading={pages.loading}
            loadingMore={pages.loadingMore}
            onEndReached={pages.handleEnd}
            rowKey={(record) => record.id}
            rows={pages.records}
            unit={{ one: t`record`, other: t`records` }}
          />
        </div>
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
          <EmptyMedia icon={Database} />
          <EmptyTitle>{t`No tables`}</EmptyTitle>
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
      columns={table.fields.map(({ name }) => ({ field: name, header: name }))}
      label={table.name}
      table={table}
      toolbar={
        <Select
          items={items}
          layout={styles.barField}
          onValueChange={(value) => {
            if (typeof value === "string") {
              setPicked({ app, table: value });
            }
          }}
          value={table.name}
        >
          <SelectTrigger aria-label={t`Table`} size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent />
        </Select>
      }
      source={{ kind: "live", version }}
    />
  );
};
