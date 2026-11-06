import type { AppDataAccess, AppDataTables } from "@grasp-os/shared/app-data";
import { fieldCode, fieldKindCode } from "@grasp-os/shared/data-model";
import type {
  DataModel,
  DataModelField,
  DataModelTable,
  DefinitionPlan,
  DraftDataModel,
  FieldKind,
  FieldType,
  PlanField,
} from "@grasp-os/shared/data-model";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  FieldTypeIcon,
  FieldTypePicker,
  ModelTableItem,
  ModelTableList,
} from "@grasp-os/ui/components/data-model";
import {
  Dialog,
  DialogContent,
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
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { RecordGridHeader } from "@grasp-os/ui/components/record-grid";
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
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@grasp-os/ui/components/sheet";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Switch } from "@grasp-os/ui/components/switch";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  Columns3Icon,
  DatabaseIcon,
  ListOrderedIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  Rows3Icon,
  ShieldIcon,
  Table2Icon,
  TrashIcon,
} from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatCompact, formatList } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { NotLoaded } from "../load-from-core.tsx";
import { TableRecords } from "./app-data.tsx";
import { PlanList, planLines, useModelChanges } from "./data-model-changes.tsx";
import type { ModelOperation } from "./data-model-changes.tsx";
import { AccessPanel, IndexesPanel } from "./data-model-settings.tsx";
import { KindIcon, pickedKinds, useFieldKinds } from "./field-kinds.tsx";
import { useCoreRead } from "./use-core-read.ts";

// An App's data model in its workspace's Data view, as a database studio
// shows one: the tables in a column, each with how many records it holds,
// and the open one as a grid whose column headers are its fields and
// whose rows are the live App's records, loaded as people scroll. Its
// Fields view lists the fields, each changed in place with room for all
// it takes, and adds new ones; who reaches the records and the orders
// they're read in sit behind the bar's two quieter buttons. Whoever builds the App changes it
// here as the chat's agent does, through the definition's own operations,
// into the chat's draft (`chats.defineDraft`): nothing changes for the
// App's people until the draft is published, and a change that removes,
// retypes, changes access or needs a value for records is reviewed first
// (data-model-changes.tsx). While the chat's agent works on the App, the
// model is read only: two writers would only refuse each other.

/** A name as a definition takes it: words joined in camel case, as code names things. */
export const identifierOf = (text: string): string => {
  const words = text
    .normalize("NFKD")
    .replaceAll(/[^A-Za-z0-9]+/gu, " ")
    .trim()
    .split(" ")
    .filter((word) => word !== "");
  const joined = words
    .map((word, index) =>
      index === 0
        ? word.charAt(0).toLowerCase() + word.slice(1)
        : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join("");
  return /^[0-9]/u.test(joined) ? `_${joined}` : joined;
};

/** A field's kind as it is picked: a choice's options as typed, a link's table. */
interface TypeDraft {
  kind: Exclude<FieldKind, "other">;
  values: string;
  table: string;
  required: boolean;
}

/** A choice's options, as typed: one each between commas. */
const optionsOf = (text: string): string[] => [
  ...new Set(
    text
      .split(",")
      .map((option) => option.trim())
      .filter((option) => option !== "")
  ),
];

/** The type a draft declares, as code writes it; undefined while it lacks what its kind needs. */
const draftCode = (draft: TypeDraft): string | undefined => {
  let type: FieldType;
  if (draft.kind === "choice") {
    const values = optionsOf(draft.values);
    if (values.length === 0) {
      return undefined;
    }
    type = { kind: "choice", values };
  } else if (draft.kind === "link") {
    if (draft.table === "") {
      return undefined;
    }
    type = { kind: "link", table: draft.table };
  } else {
    type = { kind: draft.kind };
  }
  const code = fieldKindCode(type);
  return code === undefined ? undefined : fieldCode(code, draft.required);
};

/** A draft of `field`'s type as it is, to change it; a new field's, without one. */
const draftOf = (
  field: DataModelField | undefined,
  tables: string[]
): TypeDraft => ({
  kind:
    field === undefined || field.type.kind === "other"
      ? "text"
      : field.type.kind,
  values: field?.type.kind === "choice" ? field.type.values.join(", ") : "",
  table: field?.type.kind === "link" ? field.type.table : (tables[0] ?? ""),
  required: field?.required ?? false,
});

/** A draft's kind and what it takes, apart from whether it is required. */
const kindOf = ({ kind, values, table }: TypeDraft): string =>
  JSON.stringify([kind, kind === "choice" ? optionsOf(values) : [], table]);

/** The picker of a field's kind, with what its kind needs: a choice's options, a link's table. */
const TypeChoice = ({
  draft,
  tables,
  onChange,
  disabled,
}: {
  draft: TypeDraft;
  tables: string[];
  onChange: (draft: TypeDraft) => void;
  disabled: boolean;
}) => {
  const { t } = useLingui();
  const { options } = useFieldKinds();
  const ids = useId();
  const tableItems = tables.map((table) => ({ value: table, label: table }));
  return (
    <>
      <Field>
        <FieldLabel>
          <Trans>Type</Trans>
        </FieldLabel>
        <FieldTypePicker
          className="w-full"
          disabled={disabled}
          label={t`Type`}
          onValueChange={(value) => {
            const kind = pickedKinds.find((each) => each === value);
            if (kind !== undefined) {
              onChange({ ...draft, kind });
            }
          }}
          options={options}
          value={draft.kind}
        />
      </Field>
      {draft.kind === "choice" ? (
        <Field>
          <FieldLabel>
            <Trans>Options</Trans>
          </FieldLabel>
          <Input
            aria-label={t`Options, separated by commas`}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...draft, values: event.target.value });
            }}
            placeholder={t`Open, Done`}
            value={draft.values}
          />
        </Field>
      ) : null}
      {draft.kind === "link" ? (
        <Field>
          <FieldLabel>
            <Trans>Linked table</Trans>
          </FieldLabel>
          <Select
            disabled={disabled}
            items={tableItems}
            onValueChange={(next: unknown) => {
              if (typeof next === "string") {
                onChange({ ...draft, table: next });
              }
            }}
            value={draft.table === "" ? null : draft.table}
          >
            <SelectTrigger aria-label={t`Linked table`} className="w-full">
              <SelectValue placeholder={t`Pick a table`} />
            </SelectTrigger>
            <SelectContent>
              {tableItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      <Field className="self-end" orientation="horizontal">
        <Switch
          checked={draft.required}
          disabled={disabled}
          id={`${ids}-required`}
          onCheckedChange={(required) => {
            onChange({ ...draft, required });
          }}
        />
        <FieldLabel htmlFor={`${ids}-required`}>
          <Trans>Required</Trans>
        </FieldLabel>
      </Field>
    </>
  );
};

/**
 * A field's name and type, a new one's (`field` undefined) or one to
 * change: its operations, made one after another, on Save; removing it,
 * too, for one that exists.
 */
const FieldEditor = ({
  table,
  field,
  tables,
  disabled,
  onChange,
  onDone,
  onCancel,
}: {
  table: DataModelTable;
  field: DataModelField | undefined;
  tables: string[];
  disabled: boolean;
  onChange: (operation: ModelOperation) => Promise<boolean>;
  onDone: () => void;
  onCancel: () => void;
}) => {
  const { t } = useLingui();
  const [name, setName] = useState(field?.name ?? "");
  const [draft, setDraft] = useState(draftOf(field, tables));
  const named = identifierOf(name);
  const retyped = kindOf(draft) !== kindOf(draftOf(field, tables));
  // A field whose kind stays keeps its code, so a change of `required`
  // keeps every constraint of code's (`v.string().max(200)`).
  const code =
    field !== undefined && !retyped
      ? fieldCode(field.code, draft.required)
      : draftCode(draft);
  const operations = (): ModelOperation[] => {
    if (code === undefined || named === "") {
      return [];
    }
    if (field === undefined) {
      return [{ op: "addField", table: table.name, name: named, type: code }];
    }
    return [
      ...(named === field.name
        ? []
        : [
            {
              op: "renameField",
              table: table.name,
              field: field.name,
              name: named,
            } as const,
          ]),
      ...(code === fieldCode(field.code, field.required)
        ? []
        : [
            {
              op: "changeField",
              table: table.name,
              field: named,
              type: code,
            } as const,
          ]),
    ];
  };
  const made = operations();
  return (
    <form
      aria-label={field === undefined ? t`Add a field` : t`Edit ${name}`}
      className="flex w-full flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void (async () => {
          for (const operation of made) {
            // oxlint-disable-next-line no-await-in-loop -- the rename lands before the retype names it
            if (!(await onChange(operation))) {
              return;
            }
          }
          onDone();
        })();
      }}
    >
      <div className="grid items-start gap-3 md:grid-cols-2">
        <Field>
          <FieldLabel>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input
            aria-label={t`Field name`}
            autoFocus
            disabled={disabled}
            onChange={(event) => {
              setName(event.target.value);
            }}
            value={name}
          />
          {named !== "" && named !== name.trim() ? (
            <FieldDescription>
              <Trans>Saved as {named}</Trans>
            </FieldDescription>
          ) : null}
        </Field>
        <TypeChoice
          disabled={disabled}
          draft={draft}
          onChange={setDraft}
          tables={tables}
        />
      </div>
      <div className="flex items-center gap-2">
        {field === undefined ? null : (
          <Button
            disabled={disabled}
            onClick={() => {
              void (async () => {
                if (
                  await onChange({
                    op: "removeField",
                    table: table.name,
                    field: field.name,
                  })
                ) {
                  onDone();
                }
              })();
            }}
            size="sm"
            type="button"
            variant="destructive"
          >
            <TrashIcon data-icon="inline-start" />
            <Trans>Remove</Trans>
          </Button>
        )}
        <Button
          className="ms-auto"
          onClick={onCancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Trans>Cancel</Trans>
        </Button>
        <Button
          disabled={disabled || made.length === 0}
          size="sm"
          type="submit"
        >
          {field === undefined ? <Trans>Add field</Trans> : <Trans>Save</Trans>}
        </Button>
      </div>
    </form>
  );
};

/** What a field is, in words: its kind, a choice's options, a link's table. */
const FieldSummary = ({ field }: { field: DataModelField }) => {
  const { describe } = useFieldKinds();
  const kind = describe(field.type);
  if (field.type.kind === "choice") {
    const options = formatList(field.type.values);
    return (
      <Trans>
        {kind}: {options}
      </Trans>
    );
  }
  return kind;
};

/** A field as its table's Fields view lists it, and the way to change it. */
const FieldRow = ({
  field,
  disabled,
  onEdit,
}: {
  field: DataModelField;
  disabled: boolean;
  onEdit: () => void;
}) => {
  const { t } = useLingui();
  const fieldName = field.name;
  return (
    <Item render={<li />} size="sm" variant="row">
      <ItemMedia>
        <FieldTypeIcon size="sm">
          <KindIcon kind={field.type.kind} />
        </FieldTypeIcon>
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {field.name}
          {field.required ? (
            <Badge variant="secondary">
              <Trans>Required</Trans>
            </Badge>
          ) : null}
        </ItemTitle>
        <ItemDescription>
          <FieldSummary field={field} />
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button
          aria-label={t`Edit ${fieldName}`}
          disabled={disabled}
          onClick={onEdit}
          size="icon-sm"
          title={t`Edit ${fieldName}`}
          variant="ghost"
        >
          <PencilIcon />
        </Button>
      </ItemActions>
    </Item>
  );
};

/**
 * A table's fields, each changed in place, and a new one added under
 * them: one open at a time, with room for all it takes.
 */
const FieldsView = ({
  table,
  tables,
  disabled,
  onChange,
}: {
  table: DataModelTable;
  tables: string[];
  disabled: boolean;
  onChange: (operation: ModelOperation) => Promise<boolean>;
}) => {
  // The field open (its ID), a new one (`new`), or none: a table with no
  // fields opens on its first.
  const [open, setOpen] = useState<string | undefined>(
    table.fields.length === 0 ? "new" : undefined
  );
  const close = (): void => {
    setOpen(undefined);
  };
  const editor = (field?: DataModelField) => (
    <Item key={field?.id ?? "new"} render={<li />} size="sm" variant="row">
      <FieldEditor
        disabled={disabled}
        field={field}
        onCancel={close}
        onChange={onChange}
        onDone={close}
        table={table}
        tables={tables}
      />
    </Item>
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex max-w-3xl flex-col gap-3 p-3">
        <ItemGroup render={<ul />} variant="card">
          {table.fields.map((field) =>
            open === field.id ? (
              editor(field)
            ) : (
              <FieldRow
                disabled={disabled || open !== undefined}
                field={field}
                key={field.id}
                onEdit={() => {
                  setOpen(field.id);
                }}
              />
            )
          )}
          {open === "new" ? editor() : null}
        </ItemGroup>
        {open === undefined ? (
          <div>
            <Button
              disabled={disabled}
              onClick={() => {
                setOpen("new");
              }}
              size="sm"
              variant="outline"
            >
              <PlusIcon data-icon="inline-start" />
              <Trans>Add field</Trans>
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
};

/** One of a table's quieter views, in a sheet from the bar: its access, or its indexes. */
const SideView = ({
  label,
  icon,
  children,
}: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  return (
    <Sheet>
      <SheetTrigger
        render={
          <Button aria-label={label} size="sm" title={label} variant="ghost" />
        }
      >
        {icon}
        <span className="max-md:sr-only">{label}</span>
      </SheetTrigger>
      <SheetContent closeLabel={t`Close`} side="right">
        <SheetHeader>
          <SheetTitle>{label}</SheetTitle>
        </SheetHeader>
        <div className="overflow-y-auto px-4 pb-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
};

/** The live App's tables, by name, and its version: where records are read. */
const useLiveTables = (app: string) => {
  const live = useCoreRead(
    `${app}/live`,
    async (session) => await session.apps.data.tables(app)
  );
  return live?.state === "ready" ? live.data : undefined;
};

/** The table open: its fields as the grid's columns, its records as rows. */
const TableView = ({
  app,
  live,
  table,
  tables,
  disabled,
  onChange,
}: {
  app: string;
  /** The live App's tables and their version; none while read. */
  live: AppDataTables | undefined;
  table: DataModelTable;
  tables: string[];
  disabled: boolean;
  onChange: (operation: ModelOperation) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const [showing, setShowing] = useState<"records" | "fields">("records");
  const { name } = table;
  return (
    <TableRecords
      app={app}
      columns={table.fields.map((field) => ({
        field: field.name,
        header: (
          <RecordGridHeader
            icon={<KindIcon kind={field.type.kind} />}
            required={field.required}
            requiredLabel={t`Required`}
          >
            {field.name}
          </RecordGridHeader>
        ),
      }))}
      instead={
        showing === "fields" ? (
          <FieldsView
            disabled={disabled}
            onChange={onChange}
            table={table}
            tables={tables}
          />
        ) : undefined
      }
      // The live App's records of this table, once the App has it.
      key={`${table.id}/${live?.version ?? ""}`}
      label={name}
      table={live?.tables.find((held) => held.name === name)}
      toolbar={
        <>
          <ToggleGroup
            aria-label={t`Show`}
            onValueChange={(chosen: unknown[]) => {
              setShowing(chosen[0] === "fields" ? "fields" : "records");
            }}
            size="sm"
            spacing={0}
            value={[showing]}
            variant="outline"
          >
            <ToggleGroupItem value="records">
              <Rows3Icon data-icon="inline-start" />
              <Trans context="a table's records">Records</Trans>
            </ToggleGroupItem>
            <ToggleGroupItem value="fields">
              <Columns3Icon data-icon="inline-start" />
              <Trans context="a table's fields">Fields</Trans>
            </ToggleGroupItem>
          </ToggleGroup>
          <SideView icon={<ShieldIcon />} label={t`Access`}>
            <AccessPanel
              disabled={disabled}
              // Its form starts again from the table as it now is.
              key={JSON.stringify([table.access, table.sensitive])}
              onChange={(operation) => {
                void onChange(operation);
              }}
              table={table}
            />
          </SideView>
          <SideView icon={<ListOrderedIcon />} label={t`Indexes`}>
            <IndexesPanel
              disabled={disabled}
              onChange={onChange}
              table={table}
            />
          </SideView>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={disabled}
              render={
                <Button
                  aria-label={t`Change ${name}`}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <MoreHorizontalIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                onClick={() => {
                  void onChange({ op: "removeTable", table: table.name });
                }}
                variant="destructive"
              >
                <TrashIcon />
                <Trans>Remove table</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
      version={live?.version ?? null}
    />
  );
};

/** A new table: its name, and who can see and change its records. */
const NewTableDialog = ({
  open,
  busy,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (operation: ModelOperation) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<AppDataAccess>("appMembers");
  const named = identifierOf(name);
  const items = [
    { value: "appMembers", label: t`Everyone who uses the App` },
    { value: "owner", label: t`Only the person who added each record` },
    { value: "appBuilders", label: t`Only the App's builders` },
  ] as const;
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-md" closeLabel={t`Close`}>
        <DialogHeader>
          <DialogTitle>
            <Trans>New table</Trans>
          </DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (named === "") {
              return;
            }
            void (async () => {
              const made = await onAdd({
                op: "addTable",
                name: named,
                access: { read: mode, write: mode },
              });
              if (made) {
                setName("");
                onOpenChange(false);
              }
            })();
          }}
        >
          <Field>
            <FieldLabel>
              <Trans>Name</Trans>
            </FieldLabel>
            <Input
              aria-label={t`Table name`}
              onChange={(event) => {
                setName(event.target.value);
              }}
              placeholder={t`tasks`}
              value={name}
            />
            {named !== "" && named !== name.trim() ? (
              <FieldDescription>
                <Trans>Saved as {named}</Trans>
              </FieldDescription>
            ) : null}
          </Field>
          <Field>
            <FieldLabel>
              <Trans>Who can see and change its records</Trans>
            </FieldLabel>
            <Select
              items={items}
              onValueChange={(next: unknown) => {
                const picked = items.find(({ value }) => value === next);
                if (picked !== undefined) {
                  setMode(picked.value);
                }
              }}
              value={mode}
            >
              <SelectTrigger
                aria-label={t`Who can see and change its records`}
                className="w-full"
              >
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
          </Field>
          <DialogFooter>
            <Button
              onClick={() => {
                onOpenChange(false);
              }}
              type="button"
              variant="outline"
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button disabled={busy || named === ""} type="submit">
              <Trans>Create table</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** What publishing does to the records the App holds, line by line. */
const PublishPlan = ({
  plan,
  onAnswer,
}: {
  plan: DefinitionPlan;
  onAnswer: (field: PlanField) => void;
}) => {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const lines = planLines(plan, i18n);
  const needs = lines.filter(({ tone }) => tone === "needs").length;
  const changeCount = lines.length;
  if (changeCount === 0) {
    return null;
  }
  return (
    <>
      <Button
        className="w-full"
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="outline"
      >
        <Plural
          one="# change to publish"
          other="# changes to publish"
          value={changeCount}
        />
        {needs === 0 ? null : (
          <Badge variant="attention">
            <Plural one="# needs you" other="# need you" value={needs} />
          </Badge>
        )}
      </Button>
      <Sheet onOpenChange={setOpen} open={open}>
        <SheetContent closeLabel={t`Close`} side="right">
          <SheetHeader>
            <SheetTitle>
              <Trans>When you publish</Trans>
            </SheetTitle>
          </SheetHeader>
          <div className="overflow-y-auto px-4 pb-4">
            <PlanList
              lines={lines}
              onAnswer={(field) => {
                setOpen(false);
                onAnswer(field);
              }}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
};

/**
 * The data model of the chat's draft of `app` at its `revision`, changed
 * here; read only while the chat's agent is `running`.
 */
export const AppDataModel = ({
  app,
  chatId,
  revision,
  running,
}: {
  app: string;
  chatId: string;
  revision: number;
  running: boolean;
}) => {
  const { t } = useLingui();
  const read = useCoreRead(
    `${chatId}/${app}/${revision}`,
    async (session) => await session.chats.dataModel(chatId, app)
  );
  // What a change made here answered, at the revision it was made over:
  // shown until the draft's next revision is read.
  const [made, setMade] = useState<DraftDataModel & { revision: number }>();
  const live = useLiveTables(app);
  const [picked, setPicked] = useState<string>();
  const [creating, setCreating] = useState(false);
  const changes = useModelChanges({
    app,
    chatId,
    onMade: (model, plan) => {
      setMade({ model, plan, revision });
    },
  });
  let shown: DraftDataModel | undefined;
  if (made !== undefined && made.revision === revision) {
    shown = made;
  } else if (read?.state === "ready") {
    shown = read.data;
  } else {
    shown = made;
  }
  if (shown === undefined) {
    return (
      <div className="p-4">
        {read === undefined ? (
          <LoadingLines lines={6} />
        ) : (
          <NotLoaded page={read} />
        )}
      </div>
    );
  }
  const { model, plan }: { model: DataModel; plan: DefinitionPlan } = shown;
  const tables = model.tables.map(({ name }) => name);
  const table =
    model.tables.find(({ id, name }) => id === picked || name === picked) ??
    model.tables.at(0);
  const disabled = running || changes.busy;
  const change = async (operation: ModelOperation): Promise<boolean> => {
    const done = await changes.make(operation);
    if (done && operation.op === "addTable") {
      setPicked(operation.name);
    }
    return done;
  };
  const answer = (asked: PlanField): void => {
    const field = model.tables
      .find(({ name }) => name === asked.table)
      ?.fields.find(({ name }) => name === asked.field);
    if (field !== undefined) {
      void change({
        op: "changeField",
        table: asked.table,
        field: asked.field,
        type: fieldCode(field.code, field.required),
      });
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav
        aria-label={t`Tables`}
        className="flex max-h-56 flex-none flex-col gap-2 overflow-y-auto border-b p-2 md:max-h-none md:w-56 md:border-e md:border-b-0"
      >
        <Button
          disabled={disabled}
          onClick={() => {
            setCreating(true);
          }}
          size="sm"
          variant="highlight"
        >
          {running ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <PlusIcon data-icon="inline-start" />
          )}
          <Trans>New table</Trans>
        </Button>
        <ModelTableList>
          {model.tables.map((each) => {
            const records = live?.tables.find(
              ({ name }) => name === each.name
            )?.records;
            return (
              <ModelTableItem
                active={each.id === table?.id}
                icon={<Table2Icon />}
                key={each.id}
                // How many records the live App holds; none for a table it
                // doesn't have yet, or whose records each person sees only
                // some of.
                {...(records === undefined || records === null
                  ? {}
                  : { meta: formatCompact(records) })}
                onClick={() => {
                  setPicked(each.id);
                }}
              >
                {each.name}
              </ModelTableItem>
            );
          })}
        </ModelTableList>
        <div className="mt-auto">
          <PublishPlan onAnswer={answer} plan={plan} />
        </div>
      </nav>
      <section
        aria-label={t`Data model`}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {changes.failure === undefined ? null : (
          <div className="border-b px-3 py-2">
            <ErrorText>{changes.failure}</ErrorText>
          </div>
        )}
        {table === undefined ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <DatabaseIcon />
              </EmptyMedia>
              <EmptyTitle>
                <Trans>No tables yet</Trans>
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <TableView
            app={app}
            live={live}
            disabled={disabled}
            // Each table its own grid, popovers and sheets.
            key={table.id}
            onChange={change}
            table={table}
            tables={tables}
          />
        )}
      </section>
      <NewTableDialog
        busy={changes.busy}
        onAdd={change}
        onOpenChange={setCreating}
        open={creating}
      />
      {changes.dialog}
    </div>
  );
};
