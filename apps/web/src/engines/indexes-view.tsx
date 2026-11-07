import type { DataModelTable, IndexUse } from "@grasp-os/shared/data-model";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
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
  RadioGroup,
  RadioGroupItem,
} from "@grasp-os/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  ListOrderedIcon,
  SearchIcon,
  TrashIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { formatList } from "../format.ts";
import type { ModelOperation } from "./data-model-changes.tsx";

// A table's indexes and its search in an App's Data view, each by its
// fields and what uses it: the App’s queries that read it, and the pages
// that call them (core reads them from the App's code, `IndexUse`). One
// that nothing uses, and one a query reads that the table lacks, are said
// plainly. A new one is a field and what it's for, named from its field.

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
      <Badge variant="attention">
        <Trans>No query uses it yet</Trans>
      </Badge>
    );
  }
  const queries = formatList(
    uses.map(({ query, pages }) => {
      const routes = formatList(pages);
      return pages.length === 0 ? query : t`${query} (on ${routes})`;
    })
  );
  return <Trans>Used by {queries}</Trans>;
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
  icon: ReactNode;
  title: string;
  name?: string;
  uses: IndexUse[];
  removeLabel: string;
  disabled: boolean;
  onRemove: () => void;
}) => (
  <Item render={<li />} size="sm" variant="row">
    <ItemMedia variant="icon">{icon}</ItemMedia>
    <ItemContent>
      <ItemTitle>
        {title}
        {name === undefined ? null : <Badge variant="secondary">{name}</Badge>}
      </ItemTitle>
      <ItemDescription>
        <UsedBy uses={uses} />
      </ItemDescription>
    </ItemContent>
    <ItemActions>
      <Button
        aria-label={removeLabel}
        disabled={disabled}
        onClick={onRemove}
        size="icon-sm"
        title={removeLabel}
        variant="ghost"
      >
        <TrashIcon />
      </Button>
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
  const ids = useId();
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
  return (
    <form
      aria-label={t`Add an index`}
      className="flex flex-col gap-4"
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
    >
      <FieldSet>
        <FieldLegend>
          <Trans>Add</Trans>
        </FieldLegend>
        <RadioGroup
          disabled={disabled}
          onValueChange={(next: unknown) => {
            setKind(next === "search" ? "search" : "index");
          }}
          value={searchable ? kind : "index"}
        >
          <Field orientation="horizontal">
            <RadioGroupItem id={`${ids}-index`} value="index" />
            <FieldLabel htmlFor={`${ids}-index`}>
              <Trans>An index, to sort and filter by a field</Trans>
            </FieldLabel>
          </Field>
          {searchable ? (
            <Field orientation="horizontal">
              <RadioGroupItem id={`${ids}-search`} value="search" />
              <FieldLabel htmlFor={`${ids}-search`}>
                <Trans>Search, to find records by the words in them</Trans>
              </FieldLabel>
            </Field>
          ) : null}
        </RadioGroup>
      </FieldSet>
      {kind === "index" || !searchable ? (
        <Field>
          <FieldLabel htmlFor={`${ids}-by`}>
            <Trans>Field</Trans>
          </FieldLabel>
          <Select
            disabled={disabled}
            items={items}
            onValueChange={(next: unknown) => {
              if (typeof next === "string") {
                setBy(next);
              }
            }}
            value={by}
          >
            <SelectTrigger
              aria-label={t`Field`}
              className="w-full max-w-xs"
              id={`${ids}-by`}
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
      ) : (
        <FieldSet>
          <FieldLegend variant="label">
            <Trans>Fields to search</Trans>
          </FieldLegend>
          {texts.map((field) => (
            <Field key={field} orientation="horizontal">
              <Checkbox
                checked={searched.includes(field)}
                disabled={disabled}
                id={`${ids}-${field}`}
                onCheckedChange={(checked) => {
                  const rest = searched.filter((held) => held !== field);
                  setSearched(checked ? [...rest, field] : rest);
                }}
              />
              <FieldLabel htmlFor={`${ids}-${field}`}>{field}</FieldLabel>
            </Field>
          ))}
        </FieldSet>
      )}
      <div>
        <Button disabled={disabled || !ready} type="submit" variant="outline">
          {kind === "search" && searchable ? (
            <Trans>Add search</Trans>
          ) : (
            <Trans>Add index</Trans>
          )}
        </Button>
      </div>
    </form>
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
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex max-w-2xl flex-col gap-6 p-6">
        <FieldSet>
          <FieldLegend>
            <Trans>Indexes</Trans>
          </FieldLegend>
          <FieldDescription>
            <Trans>
              An index keeps records in order of a field, so queries that sort
              or filter by it stay fast. Search finds records by their words.
            </Trans>
          </FieldDescription>
        </FieldSet>
        {missing.length === 0 ? null : (
          <Alert variant="attention">
            <TriangleAlertIcon />
            <AlertDescription>
              <ul>
                {missing.map(({ query, index }) => (
                  <li key={`${query}/${index ?? ""}`}>
                    {index === null ? (
                      <Trans>
                        {query} searches this table, which has no search.
                      </Trans>
                    ) : (
                      <Trans>
                        {query} reads the index {index}, which this table
                        doesn’t have.
                      </Trans>
                    )}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {none ? (
          <p className="text-muted-foreground text-sm">
            <Trans>The chat adds indexes as it writes the App’s queries.</Trans>
          </p>
        ) : (
          <ItemGroup render={<ul />} variant="card">
            {table.indexes.map((index) => {
              const indexName = index.name;
              return (
                <IndexRow
                  disabled={disabled}
                  icon={<ListOrderedIcon />}
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
                icon={<SearchIcon />}
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
