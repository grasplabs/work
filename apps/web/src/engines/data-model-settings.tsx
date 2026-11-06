import type { AppDataAccess } from "@grasp-os/shared/app-data";
import type {
  DataModelRule,
  DataModelTable,
} from "@grasp-os/shared/data-model";
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { Switch } from "@grasp-os/ui/components/switch";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ListOrderedIcon, SearchIcon, TrashIcon } from "lucide-react";
import { useId, useState } from "react";

import { formatList } from "../format.ts";
import type { ModelOperation } from "./data-model-changes.tsx";

// A table's access and indexes in an App's Data view: who can see and
// change its records, in plain words, with the rules that narrow them to
// each person's own; and the orders and the search its code reads them
// in. Each saved through the definition's own operations (`setAccess`,
// `addIndex`, `removeIndex`), reviewed first where they change access.

const modeLabels: Record<AppDataAccess, MessageDescriptor> = {
  owner: msg`Only the person who added each record`,
  appMembers: msg`Everyone who uses the App`,
  appBuilders: msg`Only the App's builders`,
  none: msg`Nobody`,
};

const modes = ["appMembers", "owner", "appBuilders", "none"] as const;

/** Whether row rules can narrow a mode: only one that reaches more than one person's. */
const narrows = (mode: AppDataAccess): boolean =>
  mode === "appMembers" || mode === "appBuilders";

/** A rule as one checkbox's value. */
const ruleKey = (rule: DataModelRule): string =>
  rule.kind === "owner" || rule.kind === "role"
    ? `${rule.kind}:${rule.kind === "role" ? rule.role : ""}`
    : `${rule.kind}:${rule.field}`;

/** A rule a person can tick, and what it says. */
interface RuleChoice {
  rule: DataModelRule;
  label: string;
}

/** The rules a table's fields allow, each with what it says. */
const useRuleChoices = (table: DataModelTable): RuleChoice[] => {
  const { t } = useLingui();
  const byField = table.fields.flatMap((field): RuleChoice[] => {
    const { name } = field;
    if (field.type.kind === "person") {
      return [
        {
          rule: { kind: "person", field: name },
          label: t`The records where ${name} is them`,
        },
      ];
    }
    if (field.type.kind === "text") {
      return [
        {
          rule: { kind: "team", field: name },
          label: t`The records where ${name} is their team`,
        },
      ];
    }
    return [];
  });
  return [
    { rule: { kind: "owner" }, label: t`The records they added` },
    ...byField,
    {
      rule: { kind: "role", role: "builder" },
      label: t`Every record, for the App's builders`,
    },
  ];
};

/** Who can see, or change, a table's records: a mode, and its rules. */
const AccessPart = ({
  legend,
  mode,
  rules,
  choices,
  onMode,
  onRules,
  disabled,
}: {
  legend: string;
  mode: AppDataAccess;
  rules: DataModelRule[];
  choices: RuleChoice[];
  onMode: (mode: AppDataAccess) => void;
  onRules: (rules: DataModelRule[]) => void;
  disabled: boolean;
}) => {
  const { i18n } = useLingui();
  const ids = useId();
  const items = modes.map((value) => ({
    value,
    label: i18n._(modeLabels[value]),
  }));
  const chosen = new Set(rules.map(ruleKey));
  return (
    <FieldSet>
      <FieldLegend>{legend}</FieldLegend>
      <Select
        disabled={disabled}
        items={items}
        onValueChange={(next: unknown) => {
          const picked = modes.find((each) => each === next);
          if (picked !== undefined) {
            onMode(picked);
          }
        }}
        value={mode}
      >
        <SelectTrigger aria-label={legend} className="w-full max-w-sm">
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
      {narrows(mode) ? (
        <div className="flex flex-col gap-3">
          <FieldDescription>
            <Trans>
              Narrow it to each person&apos;s own records, or leave all unticked
              for every record.
            </Trans>
          </FieldDescription>
          {choices.map(({ rule, label }) => {
            const key = ruleKey(rule);
            return (
              <Field key={key} orientation="horizontal">
                <Checkbox
                  checked={chosen.has(key)}
                  disabled={disabled}
                  id={`${ids}-${key}`}
                  onCheckedChange={(checked) => {
                    const rest = rules.filter((held) => ruleKey(held) !== key);
                    onRules(checked ? [...rest, rule] : rest);
                  }}
                />
                <FieldLabel htmlFor={`${ids}-${key}`}>{label}</FieldLabel>
              </Field>
            );
          })}
        </div>
      ) : null}
    </FieldSet>
  );
};

/** Who can see and change a table's records, saved with `setAccess`. */
export const AccessPanel = ({
  table,
  disabled,
  onChange,
}: {
  table: DataModelTable;
  disabled: boolean;
  onChange: (operation: ModelOperation) => void;
}) => {
  const { t } = useLingui();
  const choices = useRuleChoices(table);
  const [read, setRead] = useState(table.access.read);
  const [write, setWrite] = useState(table.access.write);
  const [readRules, setReadRules] = useState(table.access.rows.read);
  const [writeRules, setWriteRules] = useState(table.access.rows.write);
  const [sensitive, setSensitive] = useState(table.sensitive);
  const ids = useId();
  const rows = {
    ...(narrows(read) && readRules.length > 0 ? { read: readRules } : {}),
    ...(narrows(write) && writeRules.length > 0 ? { write: writeRules } : {}),
  };
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        onChange({
          op: "setAccess",
          table: table.name,
          access: {
            read,
            write,
            ...(Object.keys(rows).length === 0 ? {} : { rows }),
          },
          ...(sensitive ? { sensitive: true } : {}),
        });
      }}
    >
      <AccessPart
        choices={choices}
        disabled={disabled}
        legend={t`Who can see these records`}
        mode={read}
        onMode={setRead}
        onRules={setReadRules}
        rules={readRules}
      />
      <AccessPart
        choices={choices}
        disabled={disabled}
        legend={t`Who can change these records`}
        mode={write}
        onMode={setWrite}
        onRules={setWriteRules}
        rules={writeRules}
      />
      <Field orientation="horizontal">
        <Switch
          checked={sensitive}
          // A table stays sensitive once it is: its history kept no values.
          disabled={disabled || table.sensitive}
          id={`${ids}-sensitive`}
          onCheckedChange={setSensitive}
        />
        <div className="flex flex-col gap-0.5">
          <FieldLabel htmlFor={`${ids}-sensitive`}>
            <Trans>Sensitive</Trans>
          </FieldLabel>
          <FieldDescription>
            <Trans>
              Its history keeps no values, and every read is recorded. A table
              stays sensitive once it is.
            </Trans>
          </FieldDescription>
        </div>
      </Field>
      <div>
        <Button disabled={disabled} type="submit" variant="outline">
          <Trans>Save access</Trans>
        </Button>
      </div>
    </form>
  );
};

/** The fields an index can order by, by name: its own scalar fields, and when records were added or changed. */
const orderable = (table: DataModelTable): string[] => [
  ...table.fields.flatMap(({ name, type }) =>
    ["other", "file", "money"].includes(type.kind) ? [] : [name]
  ),
  "_createdAt",
  "_updatedAt",
];

/** A table's indexes and its search, added and removed. */
export const IndexesPanel = ({
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
  const [name, setName] = useState("");
  const [by, setBy] = useState(fields[0] ?? "");
  const texts = table.fields.flatMap(({ name: field, type }) =>
    type.kind === "text" ? [field] : []
  );
  const [searched, setSearched] = useState<string[]>([]);
  const items = fields.map((field) => ({ value: field, label: field }));
  return (
    <div className="flex flex-col gap-6">
      {table.indexes.length === 0 && table.searchIndex === null ? null : (
        <ItemGroup render={<ul />} variant="card">
          {table.indexes.map((index) => {
            const order = formatList(index.fields);
            const indexName = index.name;
            return (
              <Item key={index.name} render={<li />} size="sm" variant="row">
                <ItemMedia variant="icon">
                  <ListOrderedIcon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{index.name}</ItemTitle>
                  <ItemDescription>
                    <Trans>In order of {order}</Trans>
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button
                    aria-label={t`Remove the index ${indexName}`}
                    disabled={disabled}
                    onClick={() => {
                      void onChange({
                        op: "removeIndex",
                        table: table.name,
                        name: index.name,
                      });
                    }}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <TrashIcon />
                  </Button>
                </ItemActions>
              </Item>
            );
          })}
          {table.searchIndex === null ? null : (
            <Item render={<li />} size="sm" variant="row">
              <ItemMedia variant="icon">
                <SearchIcon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  <Trans>Search</Trans>
                </ItemTitle>
                <ItemDescription>
                  {formatList(table.searchIndex)}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  aria-label={t`Remove the search`}
                  disabled={disabled}
                  onClick={() => {
                    void onChange({
                      op: "removeIndex",
                      table: table.name,
                      search: true,
                    });
                  }}
                  size="icon-sm"
                  variant="ghost"
                >
                  <TrashIcon />
                </Button>
              </ItemActions>
            </Item>
          )}
        </ItemGroup>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void (async () => {
            const made = await onChange({
              op: "addIndex",
              table: table.name,
              name: name.trim(),
              fields: [by],
            });
            if (made) {
              setName("");
            }
          })();
        }}
      >
        <FieldSet>
          <FieldLegend>
            <Trans>Add an order</Trans>
          </FieldLegend>
          <FieldDescription>
            <Trans>
              An index lets the App list records in an order quickly, however
              many it holds.
            </Trans>
          </FieldDescription>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t`Index name`}
              className="w-48"
              disabled={disabled}
              onChange={(event) => {
                setName(event.target.value);
              }}
              placeholder="by_due"
              value={name}
            />
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
              <SelectTrigger aria-label={t`Order by`} className="w-48">
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
            <Button
              disabled={disabled || name.trim() === "" || by === ""}
              type="submit"
              variant="outline"
            >
              <Trans>Add index</Trans>
            </Button>
          </div>
        </FieldSet>
      </form>
      {table.searchIndex !== null || texts.length === 0 ? null : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void onChange({
              op: "addIndex",
              table: table.name,
              fields: searched,
              search: true,
            });
          }}
        >
          <FieldSet>
            <FieldLegend>
              <Trans>Add search</Trans>
            </FieldLegend>
            <FieldDescription>
              <Trans>
                Lets people find records by the words in these text fields.
              </Trans>
            </FieldDescription>
            <div className="flex flex-col gap-3">
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
            </div>
            <div>
              <Button
                disabled={disabled || searched.length === 0}
                type="submit"
                variant="outline"
              >
                <Trans>Add search</Trans>
              </Button>
            </div>
          </FieldSet>
        </form>
      )}
    </div>
  );
};
