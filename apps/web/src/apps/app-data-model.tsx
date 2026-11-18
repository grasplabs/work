import type { AppDataAccess, AppDataTable } from "@grasp-os/shared/app-data";
import { fieldCode } from "@grasp-os/shared/data-model";
import type {
  DataModel,
  DataModelTable,
  DefinitionPlan,
  DraftDataModel,
  IndexUse,
  PlanField,
} from "@grasp-os/shared/data-model";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatCompact } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
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
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Field, FieldDescription, FieldLabel } from "../grasp/field/index.ts";
import {
  AppRecord,
  Database,
  ListView,
  Lock,
  More,
  Plus,
  Rows,
  Sortable,
  Trash,
} from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemContent,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
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
  SheetTitle,
} from "../grasp/sheet/index.ts";
import { Toggle, ToggleGroup } from "../grasp/toggle/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { NotLoaded } from "../load-from-core.tsx";
import { AccessView } from "./access-view.tsx";
import { TableRecords } from "./app-data.tsx";
import { PlanList, planLines, useModelChanges } from "./data-model-changes.tsx";
import type { ModelChange, ModelOperation } from "./data-model-changes.tsx";
import { FieldsView } from "./field-editor.tsx";
import { identifierOf } from "./identifier.ts";
import { IndexesView } from "./indexes-view.tsx";
import { ResetTestData } from "./reset-test-data.tsx";
import { useCoreRead } from "./use-core-read.ts";

// An App's data model in its workspace's Data view, as a database studio
// shows one: the tables in a column, each with how many records it holds,
// and the open one as a table whose column heads are its fields and
// whose rows are the test records of the draft's preview, which its
// builders share, loaded as people scroll; Reset test data clears them
// for everyone (reset-test-data.tsx). Its
// Fields view lists the fields, each changed in place with room for all
// it takes, and adds new ones; who reaches the records and the orders
// they're read in sit behind the bar's two quieter toggles. Whoever builds the App changes it
// here as the chat's agent does, through the definition's own operations,
// into the App's draft (`apps.drafts.define`): nothing changes for the
// App's people until the draft is published, and a change that removes,
// retypes, changes access or needs a value for records is reviewed first
// (data-model-changes.tsx). While the chat's agent works on the App, the
// model is read only: two writers would only refuse each other.

// How tall the table list may grow above the table on a narrow screen,
// and how wide it stands beside it on a wide one: Grasp UI has no token
// for a side list's measure (app-code.tsx's file tree takes the same).
const LIST_TALL = "14rem";
const LIST_WIDE = "15rem";

const styles = stylex.create({
  studio: {
    display: "flex",
    flexDirection: { default: "column", [media.fromTablet]: "row" },
    flexGrow: 1,
    minHeight: 0,
  },
  tables: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    gap: grasp.space2,
    maxHeight: { default: LIST_TALL, [media.fromTablet]: "none" },
    width: { default: "auto", [media.fromTablet]: LIST_WIDE },
    overflowY: "auto",
    padding: grasp.space2,
    boxShadow: grasp.edge,
  },
  foot: { marginBlockStart: "auto" },
  plan: { display: "grid", gap: grasp.space2 },
  wide: { width: "100%" },
  model: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
  },
  failure: {
    flexShrink: 0,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space3,
  },
  padded: { padding: grasp.space4 },
  form: { display: "grid", gap: grasp.space4 },
});

/**
 * The tables of the draft preview's test data, with their counts: read
 * again at each revision of the draft (`revision`) and each reset
 * (`resets`).
 */
const useTestTables = (app: string, revision: number, resets: number) => {
  const read = useCoreRead(
    `${app}/${revision}/${resets}`,
    async (session) => await session.apps.drafts.testTables(app)
  );
  return read?.state === "ready" ? read.data : undefined;
};

/** What a table's bar shows: its records, fields, access or indexes. */
const showings = ["records", "fields", "access", "indexes"] as const;

type Showing = (typeof showings)[number];

/** The table open: its fields as the table's columns, its records as rows. */
const TableView = ({
  app,
  held,
  table,
  tables,
  uses,
  disabled,
  onChange,
  reset,
}: {
  app: string;
  /** The test data's tables; none while read. */
  held: AppDataTable[] | undefined;
  table: DataModelTable;
  tables: string[];
  uses: IndexUse[];
  disabled: boolean;
  onChange: (change: ModelChange) => Promise<boolean>;
  /** Reset test data, at the bar's end. */
  reset: ReactNode;
}) => {
  const { t } = useLingui();
  const [showing, setShowing] = useState<Showing>("records");
  const { name } = table;
  return (
    <TableRecords
      app={app}
      columns={table.fields.map((field) => ({
        field: field.name,
        header: field.name,
      }))}
      instead={
        {
          records: undefined,
          fields: (
            <FieldsView
              disabled={disabled}
              onChange={onChange}
              table={table}
              tables={tables}
            />
          ),
          access: (
            <AccessView
              disabled={disabled}
              // Its answers start again from the table as it now is.
              key={JSON.stringify([table.access, table.sensitive])}
              onChange={onChange}
              table={table}
            />
          ),
          indexes: (
            <IndexesView
              disabled={disabled}
              onChange={onChange}
              table={table}
              uses={uses}
            />
          ),
        }[showing]
      }
      end={reset}
      label={name}
      source={{ kind: "test" }}
      // The test data's records of this table, once its store has it.
      table={held?.find((each) => each.name === name)}
      toolbar={
        <>
          <ToggleGroup
            aria-label={t`Show`}
            onValueChange={(chosen: unknown[]) => {
              setShowing(
                showings.find((each) => each === chosen[0]) ?? "records"
              );
            }}
            size="sm"
            value={[showing]}
          >
            <Toggle icon={AppRecord} value="records">
              {t({ message: "Records", context: "a table's records" })}
            </Toggle>
            <Toggle icon={ListView} value="fields">
              {t({ message: "Fields", context: "a table's fields" })}
            </Toggle>
            <Toggle icon={Lock} value="access">
              {t({
                message: "Access",
                context: "who reaches a table's records",
              })}
            </Toggle>
            <Toggle icon={Sortable} value="indexes">
              {t({ message: "Indexes", context: "a table's indexes" })}
            </Toggle>
          </ToggleGroup>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t`Change ${name}`}
              disabled={disabled}
              icon={More}
              size="sm"
              variant="ghost"
            />
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                icon={Trash}
                onSelect={() => {
                  void onChange({ op: "removeTable", table: table.name });
                }}
                variant="danger"
              >
                {t`Remove table`}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
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
  const formId = useId();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<AppDataAccess>("appMembers");
  const named = identifierOf(name);
  const items: { value: AppDataAccess; label: string }[] = [
    { value: "appMembers", label: t`Everyone who uses the App` },
    { value: "owner", label: t`Only the person who added each record` },
    { value: "appBuilders", label: t`Only the App's builders` },
  ];
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`New table`}</DialogTitle>
        <DialogBody>
          <form
            id={formId}
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
            {...stylex.props(styles.form)}
          >
            <Field>
              <FieldLabel>{t`Name`}</FieldLabel>
              <Input
                aria-label={t`Table name`}
                onValueChange={(value: string) => {
                  setName(value);
                }}
                placeholder={t`tasks`}
                value={name}
              />
              {named !== "" && named !== name.trim() ? (
                <FieldDescription>{t`Saved as ${named}`}</FieldDescription>
              ) : null}
            </Field>
            <Field>
              <FieldLabel>{t`Who can see and change its records`}</FieldLabel>
              <Select
                items={items}
                onValueChange={(next) => {
                  const picked = items.find(({ value }) => value === next);
                  if (picked !== undefined) {
                    setMode(picked.value);
                  }
                }}
                value={mode}
              >
                <SelectTrigger
                  aria-label={t`Who can see and change its records`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent />
              </Select>
            </Field>
          </form>
        </DialogBody>
        <DialogFooter>
          <DialogAction>{t`Cancel`}</DialogAction>
          <Button
            disabled={busy || named === ""}
            form={formId}
            type="submit"
            variant="ink"
          >
            {t`Create table`}
          </Button>
        </DialogFooter>
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
    <div {...stylex.props(styles.plan)}>
      <Button
        layout={styles.wide}
        onClick={() => {
          setOpen(true);
        }}
        size="sm"
      >
        {t`${plural(changeCount, {
          one: "# change to publish",
          other: "# changes to publish",
        })}`}
      </Button>
      {needs === 0 ? null : (
        <Badge tone="attention">
          {t`${plural(needs, { one: "# needs you", other: "# need you" })}`}
        </Badge>
      )}
      <Sheet onOpenChange={setOpen} open={open}>
        <SheetContent closeLabel={t`Close`}>
          <SheetTitle>{t`When you publish`}</SheetTitle>
          <SheetBody>
            <PlanList
              lines={lines}
              onAnswer={(field) => {
                setOpen(false);
                onAnswer(field);
              }}
            />
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
};

/**
 * The data model of the App's draft of `app` at its `revision`, changed
 * here (`onChanged` after each change); read only while the chat's agent
 * is `running`. `onTestDataReset` once its test data was reset here, so
 * the preview starts afresh on it.
 */
export const AppDataModel = ({
  app,
  revision,
  running,
  onChanged,
  onTestDataReset,
}: {
  app: string;
  revision: number;
  running: boolean;
  onChanged?: () => void;
  onTestDataReset?: () => void;
}) => {
  const { t } = useLingui();
  const read = useCoreRead(
    `${app}/${revision}`,
    async (session) => await session.apps.drafts.dataModel(app)
  );
  // What a change made here answered, at the revision it was made over:
  // shown until the draft's next revision is read.
  const [made, setMade] = useState<DraftDataModel & { revision: number }>();
  // Each reset of the test data reads it afresh.
  const [resets, setResets] = useState(0);
  const held = useTestTables(app, revision, resets);
  const [picked, setPicked] = useState<string>();
  const [creating, setCreating] = useState(false);
  const changes = useModelChanges({
    app,
    onMade: (next) => {
      onChanged?.();
      // What uses the indexes comes with the next read of the draft.
      setMade({
        ...next,
        uses: read?.state === "ready" ? read.data.uses : (made?.uses ?? []),
        revision,
      });
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
      <div {...stylex.props(styles.padded)}>
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
  const change = async (next: ModelChange): Promise<boolean> => {
    const done = await changes.make(next);
    if (done && "op" in next && next.op === "addTable") {
      setPicked(next.name);
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
    <div {...stylex.props(styles.studio)}>
      <nav aria-label={t`Tables`} {...stylex.props(styles.tables)}>
        <Button
          disabled={disabled}
          icon={Plus}
          onClick={() => {
            setCreating(true);
          }}
          size="sm"
        >
          {t`New table`}
        </Button>
        <ItemGroup>
          {model.tables.map((each) => {
            const records = held?.find(
              ({ name }) => name === each.name
            )?.records;
            return (
              <Item
                current={each.id === table?.id}
                key={each.id}
                render={
                  <button
                    aria-label={each.name}
                    onClick={() => {
                      setPicked(each.id);
                    }}
                    type="button"
                  />
                }
                size="sm"
              >
                <ItemMedia icon={Rows} iconLook="inline" />
                <ItemContent>
                  <ItemTitle>
                    {each.name}
                    {/* How many test records it holds; none for a table
                        the test data doesn't have yet, or whose records
                        each person sees only some of. */}
                    {records === undefined || records === null ? null : (
                      <ItemDetail>{formatCompact(records)}</ItemDetail>
                    )}
                  </ItemTitle>
                </ItemContent>
              </Item>
            );
          })}
        </ItemGroup>
        <div {...stylex.props(styles.foot)}>
          <PublishPlan onAnswer={answer} plan={plan} />
        </div>
      </nav>
      <section aria-label={t`Data model`} {...stylex.props(styles.model)}>
        {changes.failure === undefined ? null : (
          <div {...stylex.props(styles.failure)}>
            <ErrorText>{changes.failure}</ErrorText>
          </div>
        )}
        {table === undefined ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia icon={Database} />
              <EmptyTitle>{t`No tables yet`}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <TableView
            app={app}
            disabled={disabled}
            held={held}
            // Each table its own records, popovers and sheets, read afresh
            // once the test data was reset.
            key={`${table.id}/${resets}`}
            onChange={change}
            reset={
              <ResetTestData
                app={app}
                onReset={() => {
                  setResets((before) => before + 1);
                  onTestDataReset?.();
                }}
              />
            }
            table={table}
            tables={tables}
            uses={shown.uses}
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
