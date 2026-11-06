import type { AppDataAccess } from "@grasp-os/shared/app-data";
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
  FieldCode,
  FieldTypeIcon,
  FieldTypePicker,
  ModelTableItem,
  ModelTableList,
} from "@grasp-os/ui/components/data-model";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Empty,
  EmptyDescription,
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
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
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
import { Switch } from "@grasp-os/ui/components/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import {
  DatabaseIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  RepeatIcon,
  Table2Icon,
  TrashIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { NotLoaded } from "../load-from-core.tsx";
import { TableRecords } from "./app-data.tsx";
import { PlanList, planLines, useModelChanges } from "./data-model-changes.tsx";
import type { ModelOperation } from "./data-model-changes.tsx";
import { AccessPanel, IndexesPanel } from "./data-model-settings.tsx";
import { KindIcon, pickedKinds, useFieldKinds } from "./field-kinds.tsx";
import { useCoreRead } from "./use-core-read.ts";

// An App's data model in its workspace's Data view, as a no-code tool
// shows one: its tables in a column, and the open one's fields, records,
// access and indexes. Whoever builds the App changes it here as the
// chat's agent does, through the definition's own operations, into the
// chat's draft (`chats.defineDraft`): nothing changes for the App's
// people until the draft is published, and what publishing does to the
// records the App holds is said in plain words, before a change that
// needs it and in the bar on top. A field shows its type as code declares
// it too, for whoever reads code. While the chat's agent works on the App,
// the model is read only: two writers would only refuse each other.

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

/** A draft of `field`'s type as it is, to change it. */
const draftOf = (field: DataModelField, tables: string[]): TypeDraft => ({
  kind: field.type.kind === "other" ? "text" : field.type.kind,
  values: field.type.kind === "choice" ? field.type.values.join(", ") : "",
  table: field.type.kind === "link" ? field.type.table : (tables[0] ?? ""),
  required: field.required,
});

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
      <FieldTypePicker
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
      {draft.kind === "choice" ? (
        <Input
          aria-label={t`Options, separated by commas`}
          className="w-56"
          disabled={disabled}
          onChange={(event) => {
            onChange({ ...draft, values: event.target.value });
          }}
          placeholder={t`Open, Done`}
          value={draft.values}
        />
      ) : null}
      {draft.kind === "link" ? (
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
          <SelectTrigger aria-label={t`Linked table`} className="w-40">
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
      ) : null}
      <Field className="w-auto" orientation="horizontal">
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

/** A new field, added in line under a table's fields. */
const AddField = ({
  table,
  tables,
  disabled,
  onAdd,
}: {
  table: DataModelTable;
  tables: string[];
  disabled: boolean;
  onAdd: (operation: ModelOperation) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const empty: TypeDraft = {
    kind: "text",
    values: "",
    table: tables[0] ?? "",
    required: false,
  };
  const [name, setName] = useState("");
  const [draft, setDraft] = useState(empty);
  const code = draftCode(draft);
  const named = identifierOf(name);
  return (
    <form
      aria-label={t`Add a field`}
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (code === undefined || named === "") {
          return;
        }
        void (async () => {
          if (
            await onAdd({
              op: "addField",
              table: table.name,
              name: named,
              type: code,
            })
          ) {
            setName("");
            setDraft(empty);
          }
        })();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label={t`Field name`}
          className="w-48"
          disabled={disabled}
          onChange={(event) => {
            setName(event.target.value);
          }}
          placeholder={t`New field`}
          value={name}
        />
        <TypeChoice
          disabled={disabled}
          draft={draft}
          onChange={setDraft}
          tables={tables}
        />
        <Button
          disabled={disabled || code === undefined || named === ""}
          type="submit"
        >
          <PlusIcon data-icon="inline-start" />
          <Trans>Add field</Trans>
        </Button>
      </div>
      {named !== "" && named !== name.trim() ? (
        <FieldDescription>
          <Trans>Saved as {named}</Trans>
        </FieldDescription>
      ) : null}
    </form>
  );
};

/** What a field is, in words: its kind, a choice's options. */
const FieldSummary = ({ field }: { field: DataModelField }) => {
  const { describe } = useFieldKinds();
  if (field.type.kind === "choice") {
    const options = formatList(field.type.values);
    const kind = describe(field.type);
    return (
      <Trans>
        {kind}: {options}
      </Trans>
    );
  }
  return describe(field.type);
};

/** Renaming a field, or changing its type: what the dialog asks. */
type FieldEdit = { kind: "rename" } | { kind: "retype" };

/** A dialog that renames a field, or changes its type. */
const FieldDialog = ({
  table,
  field,
  edit,
  tables,
  busy,
  onClose,
  onChange,
}: {
  table: DataModelTable;
  field: DataModelField;
  edit: FieldEdit;
  tables: string[];
  busy: boolean;
  onClose: () => void;
  onChange: (operation: ModelOperation) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const [name, setName] = useState(field.name);
  const [draft, setDraft] = useState(draftOf(field, tables));
  const named = identifierOf(name);
  const code = draftCode(draft);
  const fieldName = field.name;
  const ready =
    edit.kind === "rename"
      ? named !== "" && named !== field.name
      : code !== undefined;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent className="sm:max-w-lg" closeLabel={t`Close`}>
        <DialogHeader>
          <DialogTitle>
            {edit.kind === "rename" ? (
              <Trans>Rename {fieldName}</Trans>
            ) : (
              <Trans>Change the type of {fieldName}</Trans>
            )}
          </DialogTitle>
          <DialogDescription>
            {edit.kind === "rename" ? (
              <Trans>
                Its values, and whatever reads it, follow it under the new name.
              </Trans>
            ) : (
              <Trans>
                You see what this does to the records it holds before it is
                made.
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ready) {
              return;
            }
            void (async () => {
              const operation: ModelOperation =
                edit.kind === "rename"
                  ? {
                      op: "renameField",
                      table: table.name,
                      field: field.name,
                      name: named,
                    }
                  : {
                      op: "changeField",
                      table: table.name,
                      field: field.name,
                      type: code ?? field.code,
                    };
              // The dialog closes either way: a review opens in its place,
              // or the change is made.
              onClose();
              await onChange(operation);
            })();
          }}
        >
          {edit.kind === "rename" ? (
            <Field>
              <FieldLabel>
                <Trans>New name</Trans>
              </FieldLabel>
              <Input
                aria-label={t`New name`}
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
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <TypeChoice
                disabled={busy}
                draft={draft}
                onChange={setDraft}
                tables={tables}
              />
            </div>
          )}
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              <Trans>Cancel</Trans>
            </Button>
            <Button disabled={busy || !ready} type="submit">
              {edit.kind === "rename" ? (
                <Trans>Rename</Trans>
              ) : (
                <Trans>Review the change</Trans>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** One field of a table, with what can be done to it. */
const FieldRow = ({
  table,
  field,
  disabled,
  onEdit,
  onChange,
}: {
  table: DataModelTable;
  field: DataModelField;
  disabled: boolean;
  onEdit: (edit: FieldEdit) => void;
  onChange: (operation: ModelOperation) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const fieldName = field.name;
  return (
    <Item render={<li />} size="sm" variant="row">
      <ItemMedia>
        <FieldTypeIcon>
          <KindIcon kind={field.type.kind} />
        </FieldTypeIcon>
      </ItemMedia>
      <ItemContent className="min-w-0">
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
        <FieldCode>{fieldCode(field.code, field.required)}</FieldCode>
      </ItemContent>
      <ItemActions>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled}
            render={
              <Button
                aria-label={t`Change ${fieldName}`}
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            <MoreHorizontalIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {
                onEdit({ kind: "rename" });
              }}
            >
              <PencilIcon />
              <Trans>Rename</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                onEdit({ kind: "retype" });
              }}
            >
              <RepeatIcon />
              <Trans>Change type</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => {
                void onChange({
                  op: "changeField",
                  table: table.name,
                  field: field.name,
                  type: fieldCode(field.code, !field.required),
                });
              }}
            >
              {field.required ? (
                <Trans>Make optional</Trans>
              ) : (
                <Trans>Make required</Trans>
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                void onChange({
                  op: "removeField",
                  table: table.name,
                  field: field.name,
                });
              }}
              variant="destructive"
            >
              <TrashIcon />
              <Trans>Remove</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ItemActions>
    </Item>
  );
};

/** A table's fields, each changed from its row, and a new one added under them. */
const FieldsPanel = ({
  table,
  tables,
  disabled,
  busy,
  onChange,
}: {
  table: DataModelTable;
  tables: string[];
  disabled: boolean;
  busy: boolean;
  onChange: (operation: ModelOperation) => Promise<boolean>;
}) => {
  const [editing, setEditing] = useState<{
    field: DataModelField;
    edit: FieldEdit;
  }>();
  return (
    <div className="flex flex-col gap-4">
      {table.fields.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <Trans>
            No fields yet. Add the first: what each record of this table holds.
          </Trans>
        </p>
      ) : (
        <ItemGroup render={<ul />} variant="card">
          {table.fields.map((field) => (
            <FieldRow
              disabled={disabled}
              field={field}
              key={field.id}
              onChange={onChange}
              onEdit={(edit) => {
                setEditing({ field, edit });
              }}
              table={table}
            />
          ))}
        </ItemGroup>
      )}
      <AddField
        disabled={disabled}
        onAdd={onChange}
        table={table}
        tables={tables}
      />
      {editing === undefined ? null : (
        <FieldDialog
          busy={busy}
          edit={editing.edit}
          field={editing.field}
          onChange={onChange}
          onClose={() => {
            setEditing(undefined);
          }}
          table={table}
          tables={tables}
        />
      )}
    </div>
  );
};

/** A table's records, as the App's live version holds them: none for a table it doesn't have yet. */
const RecordsPanel = ({ app, table }: { app: string; table: string }) => {
  const live = useCoreRead(
    `${app}/live`,
    async (session) => await session.apps.data.tables(app)
  );
  if (live === undefined) {
    return <LoadingLines lines={4} />;
  }
  if (live.state !== "ready") {
    return <NotLoaded page={live} />;
  }
  const held = live.data.tables.find(({ name }) => name === table);
  const { version } = live.data;
  if (held === undefined || version === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <Trans>No records yet</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>
              The live App doesn&apos;t have this table yet: it holds records
              once you publish.
            </Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <TableRecords app={app} table={held} version={version} />
    </div>
  );
};

/** What a table is, in a line: its fields and who sees its records. */
const TableSummary = ({ table }: { table: DataModelTable }) => {
  const count = table.fields.length;
  return <Plural one="# field" other="# fields" value={count} />;
};

/** The table open: its name, and its fields, records, access and indexes. */
const TableEditor = ({
  app,
  table,
  tables,
  disabled,
  busy,
  onChange,
}: {
  app: string;
  table: DataModelTable;
  tables: string[];
  disabled: boolean;
  busy: boolean;
  onChange: (operation: ModelOperation) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const [tab, setTab] = useState("fields");
  const { name } = table;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader align="start">
        <PageHeaderContent>
          <PageHeaderTitle render={<h2>{table.name}</h2>} />
          <PageHeaderDescription>
            <TableSummary table={table} />
          </PageHeaderDescription>
        </PageHeaderContent>
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
          <DropdownMenuContent align="end">
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
      </PageHeader>
      <Tabs
        onValueChange={(value: unknown) => {
          if (typeof value === "string") {
            setTab(value);
          }
        }}
        value={tab}
      >
        <TabsList>
          <TabsTrigger value="fields">
            <Trans context="a table's fields">Fields</Trans>
          </TabsTrigger>
          <TabsTrigger value="records">
            <Trans context="a table's records">Records</Trans>
          </TabsTrigger>
          <TabsTrigger value="access">
            <Trans context="who can see and change a table's records">
              Access
            </Trans>
          </TabsTrigger>
          <TabsTrigger value="indexes">
            <Trans context="a table's indexes and search">Indexes</Trans>
          </TabsTrigger>
        </TabsList>
        <TabsContent value="fields">
          <FieldsPanel
            busy={busy}
            disabled={disabled}
            onChange={onChange}
            table={table}
            tables={tables}
          />
        </TabsContent>
        <TabsContent value="records">
          {tab === "records" ? (
            <RecordsPanel app={app} table={table.name} />
          ) : null}
        </TabsContent>
        <TabsContent value="access">
          <div className="flex flex-col gap-4">
            <p className="text-muted-foreground text-sm">
              <Trans>
                Who can see and change these records. Every read and every
                change in the App keeps to it.
              </Trans>
            </p>
            <AccessPanel
              disabled={disabled}
              // Its form starts again from the table as it now is.
              key={JSON.stringify([table.access, table.sensitive])}
              onChange={(operation) => {
                void onChange(operation);
              }}
              table={table}
            />
          </div>
        </TabsContent>
        <TabsContent value="indexes">
          <IndexesPanel
            disabled={disabled}
            key={table.id}
            onChange={onChange}
            table={table}
          />
        </TabsContent>
      </Tabs>
    </div>
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
          <DialogDescription>
            <Trans>
              A table holds one kind of record: tasks, customers, orders. You
              give it fields next.
            </Trans>
          </DialogDescription>
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

/** What publishing does to the records the App holds, opened from the bar. */
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
  return (
    <>
      <Button
        disabled={lines.length === 0}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
        variant="outline"
      >
        {lines.length === 0 ? (
          <Trans>No changes to publish</Trans>
        ) : (
          <Plural
            one="# change to publish"
            other="# changes to publish"
            value={changeCount}
          />
        )}
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
            <SheetDescription>
              <Trans>
                What your changes to the data model do to the records the App
                holds. Records are never dropped.
              </Trans>
            </SheetDescription>
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

/** The model as shown: the one read, or the one a change just made, until its read comes. */
interface Shown {
  model: DataModel;
  plan: DefinitionPlan;
}

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
  const [made, setMade] = useState<Shown & { revision: number }>();
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
      <div className="p-4 md:px-6">
        {read === undefined ? (
          <LoadingLines lines={6} />
        ) : (
          <NotLoaded page={read} />
        )}
      </div>
    );
  }
  const { model, plan } = shown;
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
        <p className="text-muted-foreground min-w-0 flex-1 text-xs">
          {running ? (
            <Trans>
              Grasp is changing the App in the chat. You can change the data
              model again once it is done.
            </Trans>
          ) : (
            <Trans>
              Changes go into your unpublished changes, as the chat&apos;s do.
            </Trans>
          )}
        </p>
        <PublishPlan onAnswer={answer} plan={plan} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          aria-label={t`Tables`}
          className="flex max-h-56 flex-none flex-col gap-2 overflow-y-auto border-b p-2 md:max-h-none md:w-60 md:border-e md:border-b-0"
        >
          <Button
            disabled={disabled}
            onClick={() => {
              setCreating(true);
            }}
            variant="highlight"
          >
            <PlusIcon data-icon="inline-start" />
            <Trans>New table</Trans>
          </Button>
          <ModelTableList>
            {model.tables.map((each) => (
              <ModelTableItem
                active={each.id === table?.id}
                icon={<Table2Icon />}
                key={each.id}
                meta={each.fields.length}
                onClick={() => {
                  setPicked(each.id);
                }}
              >
                {each.name}
              </ModelTableItem>
            ))}
          </ModelTableList>
        </nav>
        <section
          aria-label={t`Data model`}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 md:px-6">
            <ErrorText>{changes.failure}</ErrorText>
            {table === undefined ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <DatabaseIcon />
                  </EmptyMedia>
                  <EmptyTitle>
                    <Trans>No tables yet</Trans>
                  </EmptyTitle>
                  <EmptyDescription>
                    <Trans>
                      A table holds the App&apos;s records: tasks, customers,
                      orders. Create one, then give it fields.
                    </Trans>
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <TableEditor
                app={app}
                busy={changes.busy}
                disabled={disabled}
                // Each table its own tabs and forms.
                key={table.id}
                onChange={change}
                table={table}
                tables={tables}
              />
            )}
          </div>
        </section>
      </div>
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
