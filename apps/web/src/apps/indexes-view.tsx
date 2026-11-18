import type { DataModelTable, IndexUse } from "@grasp-os/shared/data-model";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { formatList } from "../format.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Checkbox, CheckboxGroup } from "../grasp/checkbox/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { Search, Sortable, Trash } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { RadioGroup, RadioGroupItem } from "../grasp/radio-group/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { ModelOperation } from "./data-model-changes.tsx";

// A table's indexes and its search in an App's Data view, each by its
// fields and what uses it: the App’s queries that read it, and the pages
// that call them (core reads them from the App's code, `IndexUse`). One
// that nothing uses, and one a query reads that the table lacks, are said
// plainly. A new one is a field and what it's for, named from its field.

// A form's measure: Grasp UI has no token for a column of cards.
const VIEW_WIDE = "42rem";
// The field picker's measure, as the old form had it.
const FIELD_WIDE = "20rem";

const styles = stylex.create({
  scroll: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  view: {
    display: "grid",
    gap: grasp.space6,
    maxWidth: VIEW_WIDE,
    padding: grasp.space6,
  },
  form: { display: "grid", gap: grasp.space4 },
  field: { maxWidth: FIELD_WIDE },
  start: { justifySelf: "start" },
  missing: { margin: 0, paddingInlineStart: grasp.space4 },
});

/** The fields an index can order by: its own scalar fields, and when records were added or changed. */
const orderable = (table: DataModelTable): string[] => [
  ...table.fields.flatMap(({ name, type }) =>
    ["other", "file", "money"].includes(type.kind) ? [] : [name]
  ),
  "_createdAt",
  "_updatedAt",
];

/** A free name for an index on `field`, as code names one: `by_stage`. */
const indexNameFor = (table: DataModelTable, field: string): string => {
  const base = `by_${field.replace(/^_+/u, "")}`;
  const taken = new Set(table.indexes.map(({ name }) => name));
  let name = base;
  for (let count = 2; taken.has(name); count += 1) {
    name = `${base}_${count}`;
  }
  return name;
};

/** What reads an index: its queries, each with the pages that call it. */
const UsedBy = ({ uses }: { uses: IndexUse[] }) => {
  const { t } = useLingui();
  if (uses.length === 0) {
    return (
      <Badge size="sm" tone="attention">
        {t`No query uses it yet`}
      </Badge>
    );
  }
  const queries = formatList(
    uses.map(({ query, pages }) => {
      const routes = formatList(pages);
      return pages.length === 0 ? query : t`${query} (on ${routes})`;
    })
  );
  return t`Used by ${queries}`;
};

/** One index or the search: its fields, what uses it, and removing it. */
const IndexRow = ({
  icon,
  title,
  name,
  uses,
  removeLabel,
  disabled,
  onRemove,
}: {
  icon: IconData;
  title: string;
  name?: string;
  uses: IndexUse[];
  removeLabel: string;
  disabled: boolean;
  onRemove: () => void;
}) => (
  <Item size="sm">
    <ItemMedia icon={icon} />
    <ItemContent>
      <ItemTitle>
        {title}
        {name === undefined ? null : <ItemDetail>{name}</ItemDetail>}
      </ItemTitle>
      <ItemDescription>
        <UsedBy uses={uses} />
      </ItemDescription>
    </ItemContent>
    <ItemActions>
      <Button
        aria-label={removeLabel}
        disabled={disabled}
        icon={Trash}
        onClick={onRemove}
        size="sm"
        title={removeLabel}
        variant="ghost"
      />
    </ItemActions>
  </Item>
);

/** A new index, or the search, in one step: what it's for, and its field or fields. */
const AddIndex = ({
  table,
  disabled,
  onChange,
}: {
  table: DataModelTable;
  disabled: boolean;
  onChange: (operation: ModelOperation) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const fields = orderable(table);
  const texts = table.fields.flatMap(({ name, type }) =>
    type.kind === "text" ? [name] : []
  );
  const searchable = table.searchIndex === null && texts.length > 0;
  const [kind, setKind] = useState<"index" | "search">("index");
  const [by, setBy] = useState(fields[0] ?? "");
  const [searched, setSearched] = useState<string[]>([]);
  const managed: Record<string, string> = {
    _createdAt: t`When it was added`,
    _updatedAt: t`When it last changed`,
  };
  const items = fields.map((field) => ({
    value: field,
    label: managed[field] ?? field,
  }));
  const ready = kind === "index" ? by !== "" : searched.length > 0;
  const searching = kind === "search" && searchable;
  return (
    <SectionCard density="compact" title={t`Add`}>
      <form
        aria-label={t`Add an index`}
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            const made = await onChange(
              kind === "index"
                ? {
                    op: "addIndex",
                    table: table.name,
                    name: indexNameFor(table, by),
                    fields: [by],
                  }
                : {
                    op: "addIndex",
                    table: table.name,
                    fields: searched,
                    search: true,
                  }
            );
            if (made) {
              setSearched([]);
            }
          })();
        }}
        {...stylex.props(styles.form)}
      >
        {searchable ? (
          <RadioGroup
            aria-label={t`Add`}
            disabled={disabled}
            onValueChange={(next) => {
              setKind(next === "search" ? "search" : "index");
            }}
            value={kind}
          >
            <Field orientation="horizontal">
              <RadioGroupItem value="index" />
              <FieldLabel>{t`An index, to sort and filter by a field`}</FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <RadioGroupItem value="search" />
              <FieldLabel>
                {t`Search, to find records by the words in them`}
              </FieldLabel>
            </Field>
          </RadioGroup>
        ) : null}
        {searching ? (
          <Field>
            <FieldLabel>{t`Fields to search`}</FieldLabel>
            <CheckboxGroup>
              {texts.map((field) => (
                <Field key={field} orientation="horizontal">
                  <Checkbox
                    checked={searched.includes(field)}
                    disabled={disabled}
                    onCheckedChange={(checked) => {
                      const rest = searched.filter((held) => held !== field);
                      setSearched(checked === true ? [...rest, field] : rest);
                    }}
                  />
                  <FieldLabel>{field}</FieldLabel>
                </Field>
              ))}
            </CheckboxGroup>
          </Field>
        ) : (
          <Field layout={styles.field}>
            <FieldLabel>{t`Field`}</FieldLabel>
            <Select
              disabled={disabled}
              items={items}
              onValueChange={(next) => {
                if (typeof next === "string") {
                  setBy(next);
                }
              }}
              value={by}
            >
              <SelectTrigger aria-label={t`Field`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent />
            </Select>
          </Field>
        )}
        <Button
          disabled={disabled || !ready}
          layout={styles.start}
          type="submit"
        >
          {searching ? t`Add search` : t`Add index`}
        </Button>
      </form>
    </SectionCard>
  );
};

/** A table's indexes and search: what each orders or searches, what uses it, and adding one. */
export const IndexesView = ({
  table,
  uses,
  disabled,
  onChange,
}: {
  table: DataModelTable;
  /** Every index the App's functions read, of every table. */
  uses: IndexUse[];
  disabled: boolean;
  onChange: (operation: ModelOperation) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const mine = uses.filter((use) => use.table === table.name);
  const names = new Set(table.indexes.map(({ name }) => name));
  const missing = mine.filter(
    ({ index }) =>
      (index !== null && !names.has(index)) ||
      (index === null && table.searchIndex === null)
  );
  const managed: Record<string, string> = {
    _createdAt: t`When it was added`,
    _updatedAt: t`When it last changed`,
  };
  const none = table.indexes.length === 0 && table.searchIndex === null;
  const searched = formatList(table.searchIndex ?? []);
  return (
    <div {...stylex.props(styles.scroll)}>
      <div {...stylex.props(styles.view)}>
        {missing.length === 0 ? null : (
          <Alert tone="attention">
            <ul {...stylex.props(styles.missing)}>
              {missing.map(({ query, index }) => (
                <li key={`${query}/${index ?? ""}`}>
                  {index === null
                    ? t`${query} searches this table, which has no search.`
                    : t`${query} reads the index ${index}, which this table doesn’t have.`}
                </li>
              ))}
            </ul>
          </Alert>
        )}
        <SectionCard
          density="compact"
          flush={!none}
          info={t`An index keeps records in order of a field, so queries that sort or filter by it stay fast. Search finds records by their words.`}
          title={t`Indexes`}
        >
          {none ? (
            <Text size="sm" tone="muted">
              {t`The chat adds indexes as it writes the App’s queries.`}
            </Text>
          ) : (
            <ItemGroup aria-label={t`Indexes`} separated>
              {table.indexes.map((index) => {
                const indexName = index.name;
                return (
                  <IndexRow
                    disabled={disabled}
                    icon={Sortable}
                    key={index.name}
                    name={index.name}
                    onRemove={() => {
                      void onChange({
                        op: "removeIndex",
                        table: table.name,
                        name: index.name,
                      });
                    }}
                    removeLabel={t`Remove the index ${indexName}`}
                    title={formatList(
                      index.fields.map((field) => managed[field] ?? field)
                    )}
                    uses={mine.filter((use) => use.index === index.name)}
                  />
                );
              })}
              {table.searchIndex === null ? null : (
                <IndexRow
                  disabled={disabled}
                  icon={Search}
                  onRemove={() => {
                    void onChange({
                      op: "removeIndex",
                      table: table.name,
                      search: true,
                    });
                  }}
                  removeLabel={t`Remove the search`}
                  title={t`Search in ${searched}`}
                  uses={mine.filter((use) => use.index === null)}
                />
              )}
            </ItemGroup>
          )}
        </SectionCard>
        <AddIndex
          disabled={disabled}
          // A new form for each change: the search's fields start again.
          key={JSON.stringify([table.indexes, table.searchIndex])}
          onChange={onChange}
          table={table}
        />
      </div>
    </div>
  );
};
