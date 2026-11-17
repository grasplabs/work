import { fieldCode, fieldKindCode } from "@grasp-os/shared/data-model";
import type {
  DataModelField,
  DataModelTable,
  FieldKind,
  FieldType,
} from "@grasp-os/shared/data-model";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId, useState } from "react";

import { announce } from "../grasp/announce/announce.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Field, FieldDescription, FieldLabel } from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { IconTile } from "../grasp/icon-tile/index.ts";
import {
  ArrowDown,
  ArrowUp,
  Cross,
  Database,
  Icon,
  Plus,
  Trash,
} from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import { RadioGroup, RadioGroupItem } from "../grasp/radio-group/index.ts";
import {
  RowList,
  RowListAction,
  RowListAdd,
  RowListItem,
} from "../grasp/row-list/index.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import type { ModelChange, ModelOperation } from "./data-model-changes.tsx";
import { kindIcon, pickedKinds, useFieldKinds } from "./field-kinds.tsx";
import type { KindOption } from "./field-kinds.tsx";
import { identifierOf } from "./identifier.ts";

// A table's fields in its Data view's Fields page, as a no-code tool
// shows them: the fields in a column of their own, in their order (each
// moved up or down to its place), and the one open beside them with an
// editor of its own kind: a choice's options as a list to add to, reorder
// and remove from, a number's decimals and bounds, a link's table. A new
// field starts from its kind, picked from every kind laid out with what it
// holds. Each editor offers only what the definition's types take
// (`FieldType`), and saves through the definition's own operations, as the
// chat's agent does.

const styles = stylex.create({
  view: {
    display: "flex",
    flexDirection: { default: "column", [media.fromTablet]: "row" },
    flexGrow: 1,
    gap: grasp.space6,
    minHeight: 0,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    flexShrink: 0,
    width: { default: null, [media.fromTablet]: grasp.frameSidebar },
    padding: grasp.space2,
    overflowY: "auto",
  },
  editor: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
    padding: grasp.space4,
    overflowY: "auto",
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space3,
    minWidth: 0,
  },
  grow: { flexGrow: 1, minWidth: 0 },
  bare: { margin: 0, padding: 0, listStyle: "none" },
  pair: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: grasp.space3,
  },
  stack: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
  },
  foot: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
  },
  kindWords: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
  },
});

/** A choice's option as it is edited: its value, and an ID it keeps while moved. */
interface Option {
  id: string;
  value: string;
}

/** A field as it is edited: its name as typed, its type, a choice's options. */
interface Draft {
  name: string;
  type: FieldType;
  options: Option[];
  required: boolean;
}

/** A field's type of `kind`, with nothing more set: a link's to the first table. */
const blankType = (kind: FieldKind, tables: readonly string[]): FieldType => {
  switch (kind) {
    case "text":
    case "email": {
      return { kind, trim: false, min: null, max: null };
    }
    case "number": {
      return { kind, integer: false, min: null, max: null };
    }
    case "boolean": {
      return { kind, default: null };
    }
    case "choice": {
      return { kind, values: [] };
    }
    case "link": {
      return { kind, table: tables[0] ?? "", cascade: false };
    }
    case "date":
    case "person":
    case "file":
    case "money": {
      return { kind };
    }
    case "other": {
      return { kind };
    }
    default: {
      return { kind: "other" };
    }
  }
};

/** Options for `values`, each with an ID of its own. */
const optionsOf = (values: readonly string[]): Option[] =>
  values.map((value) => ({ id: crypto.randomUUID(), value }));

/** A draft of `field` as it is; a new field's of `kind`. */
const draftOf = (
  field: DataModelField | undefined,
  kind: FieldKind,
  tables: readonly string[]
): Draft => ({
  name: field?.name ?? "",
  type: field?.type ?? blankType(kind, tables),
  options: optionsOf(field?.type.kind === "choice" ? field.type.values : []),
  required: field?.required ?? false,
});

/** A number as typed: none while the box is empty. */
const numberOf = (text: string): number | null =>
  text.trim() === "" || Number.isNaN(Number(text)) ? null : Number(text);

/** The type a draft declares; undefined while it lacks what its kind needs. */
const typeOf = (draft: Draft): FieldType | undefined => {
  const { type } = draft;
  if (type.kind === "choice") {
    const values = [
      ...new Set(
        draft.options
          .map(({ value }) => value.trim())
          .filter((value) => value !== "")
      ),
    ];
    return values.length === 0 ? undefined : { kind: "choice", values };
  }
  if (type.kind === "link") {
    return type.table === "" ? undefined : type;
  }
  if ("min" in type && type.min !== null && type.max !== null) {
    return type.min > type.max ? undefined : type;
  }
  return type;
};

/** Whether a field of `type` fills itself in: a yes or no with a default. */
const fillsItself = (type: FieldType): boolean =>
  type.kind === "boolean" && type.default !== null;

/**
 * The code a draft declares a field of, as the definition's operations
 * take it; undefined while it lacks what its kind needs. A field whose
 * type stays keeps its own code, so a change of `required` keeps every
 * constraint code gave it.
 */
const codeOf = (
  draft: Draft,
  field: DataModelField | undefined
): string | undefined => {
  const type = typeOf(draft);
  if (type === undefined) {
    return undefined;
  }
  const required = draft.required || fillsItself(type);
  // A field keeps what its editor doesn't say while it stays its kind:
  // whether it holds null, and its default while it stays required (a
  // yes or no's own default is its type's).
  const sameKind = field !== undefined && field.type.kind === type.kind;
  const nullable = sameKind && field.nullable ? ".nullable()" : "";
  const defaulted =
    sameKind && required && type.kind !== "boolean"
      ? (field.defaultCode ?? "")
      : "";
  const kept =
    field !== undefined &&
    JSON.stringify(type) === JSON.stringify(field.type) &&
    type.kind !== "boolean";
  if (kept) {
    return fieldCode(`${field.code}${defaulted}`, required);
  }
  const code = fieldKindCode(type) ?? field?.code;
  return code === undefined
    ? undefined
    : fieldCode(`${code}${nullable}${defaulted}`, required);
};

/** The operations that make `field` (none for a new one) what `draft` says. */
const operationsOf = (
  table: string,
  field: DataModelField | undefined,
  draft: Draft
): ModelOperation[] => {
  const name = identifierOf(draft.name);
  const code = codeOf(draft, field);
  if (code === undefined || name === "") {
    return [];
  }
  if (field === undefined) {
    return [{ op: "addField", table, name, type: code }];
  }
  const unchanged =
    draft.required === field.required &&
    JSON.stringify(typeOf(draft)) === JSON.stringify(field.type);
  return [
    ...(name === field.name
      ? []
      : [{ op: "renameField", table, field: field.name, name } as const]),
    ...(unchanged
      ? []
      : [{ op: "changeField", table, field: name, type: code } as const]),
  ];
};

/** `items` with the one at `from` put at `to`. */
const moved = <T,>(items: readonly T[], from: number, to: number): T[] => {
  const item = items[from];
  if (item === undefined) {
    return [...items];
  }
  const rest = items.filter((_, index) => index !== from);
  return [...rest.slice(0, to), item, ...rest.slice(to)];
};

/** Two number boxes side by side: the fewest and the most a field takes. */
const Bounds = ({
  min,
  max,
  minLabel,
  maxLabel,
  whole,
  disabled,
  onChange,
}: {
  min: number | null;
  max: number | null;
  minLabel: string;
  maxLabel: string;
  /** Whole numbers only, from 0: a count of characters. */
  whole: boolean;
  disabled: boolean;
  onChange: (bounds: { min: number | null; max: number | null }) => void;
}) => {
  const crossed = min !== null && max !== null && min > max;
  return (
    <div {...stylex.props(styles.pair)}>
      <Field invalid={crossed}>
        <FieldLabel>{minLabel}</FieldLabel>
        <Input
          aria-invalid={crossed || undefined}
          aria-label={minLabel}
          disabled={disabled}
          inputMode={whole ? "numeric" : "decimal"}
          onValueChange={(typed) => {
            onChange({ min: numberOf(typed), max });
          }}
          value={min === null ? "" : String(min)}
        />
      </Field>
      <Field invalid={crossed}>
        <FieldLabel>{maxLabel}</FieldLabel>
        <Input
          aria-invalid={crossed || undefined}
          aria-label={maxLabel}
          disabled={disabled}
          inputMode={whole ? "numeric" : "decimal"}
          onValueChange={(typed) => {
            onChange({ min, max: numberOf(typed) });
          }}
          value={max === null ? "" : String(max)}
        />
      </Field>
    </div>
  );
};

/** A switch with its label beside it. */
const Toggle = ({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) => (
  <Switch
    checked={checked}
    disabled={disabled}
    label={label}
    onCheckedChange={(next) => {
      onChange(next);
    }}
  />
);

/**
 * A choice's options: each typed in place, moved up or down, removed; new
 * ones added under them. A list of boxes, not a RowList: a row there holds
 * words, and an option is edited where it stands.
 */
const ChoiceOptions = ({
  options,
  disabled,
  onChange,
}: {
  options: Option[];
  disabled: boolean;
  onChange: (options: Option[]) => void;
}) => {
  const { t } = useLingui();
  const id = useId();
  const [typed, setTyped] = useState("");
  const add = (): void => {
    const value = typed.trim();
    if (value === "") {
      return;
    }
    onChange([...options, { id: crypto.randomUUID(), value }]);
    setTyped("");
  };
  const move = (from: number, to: number): void => {
    const name = options[from]?.value ?? "";
    const place = to + 1;
    onChange(moved(options, from, to));
    announce(t`${name} is now at place ${place}.`);
  };
  return (
    <div {...stylex.props(styles.stack)}>
      <Text id={`${id}-options`} size="sm" weight="medium">
        <Trans>Options</Trans>
      </Text>
      <ol
        aria-labelledby={`${id}-options`}
        {...stylex.props(styles.stack, styles.bare)}
      >
        {options.map((option, index) => {
          const place = index + 1;
          const { value } = option;
          return (
            <li key={option.id} {...stylex.props(styles.row)}>
              <Input
                aria-label={t`Option ${place}`}
                disabled={disabled}
                layout={styles.grow}
                onValueChange={(next) => {
                  onChange(
                    options.map((each) =>
                      each.id === option.id ? { ...each, value: next } : each
                    )
                  );
                }}
                value={option.value}
              />
              <Button
                aria-label={t`Move ${value} up`}
                disabled={disabled || index === 0}
                icon={ArrowUp}
                onClick={() => {
                  move(index, index - 1);
                }}
                size="sm"
                type="button"
                variant="ghost"
              />
              <Button
                aria-label={t`Move ${value} down`}
                disabled={disabled || index === options.length - 1}
                icon={ArrowDown}
                onClick={() => {
                  move(index, index + 1);
                }}
                size="sm"
                type="button"
                variant="ghost"
              />
              <Button
                aria-label={t`Remove ${value}`}
                disabled={disabled}
                icon={Cross}
                onClick={() => {
                  onChange(options.filter((each) => each.id !== option.id));
                }}
                size="sm"
                type="button"
                variant="ghost"
              />
            </li>
          );
        })}
      </ol>
      <div {...stylex.props(styles.row)}>
        <Input
          aria-label={t`New option`}
          disabled={disabled}
          layout={styles.grow}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              // Adds the option; the field isn't saved until Save.
              event.preventDefault();
              add();
            }
          }}
          onValueChange={setTyped}
          placeholder={t`New option`}
          value={typed}
        />
        <Button
          disabled={disabled || typed.trim() === ""}
          icon={Plus}
          onClick={add}
          type="button"
          variant="quiet"
        >
          {t`Add option`}
        </Button>
      </div>
    </div>
  );
};

/** One choice of a radio group: the radio and its words. */
const RadioChoice = ({ value, label }: { value: string; label: string }) => (
  <Field orientation="horizontal">
    <RadioGroupItem value={value} />
    <FieldLabel>{label}</FieldLabel>
  </Field>
);

/** A link's table, and what deleting the record it links to does. */
const LinkOptions = ({
  type,
  tables,
  disabled,
  onChange,
}: {
  type: Extract<FieldType, { kind: "link" }>;
  tables: readonly string[];
  disabled: boolean;
  onChange: (type: FieldType) => void;
}) => {
  const { t } = useLingui();
  const id = useId();
  return (
    <>
      <Field>
        <FieldLabel>
          <Trans>Links to</Trans>
        </FieldLabel>
        <Select
          disabled={disabled}
          items={[...tables]}
          onValueChange={(next) => {
            if (next !== null) {
              onChange({ ...type, table: next });
            }
          }}
          value={type.table === "" ? null : type.table}
        >
          <SelectTrigger aria-label={t`Links to`}>
            <SelectValue placeholder={t`Pick a table`} />
          </SelectTrigger>
          <SelectContent>
            {tables.map((table) => (
              <SelectItem key={table} label={table} value={table}>
                <span {...stylex.props(styles.kindWords)}>
                  <Icon icon={Database} />
                  {table}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div {...stylex.props(styles.stack)}>
        <Text id={`${id}-deleted`} size="sm" weight="medium">
          <Trans>When the linked record is deleted</Trans>
        </Text>
        <RadioGroup
          aria-labelledby={`${id}-deleted`}
          disabled={disabled}
          onValueChange={(next) => {
            onChange({ ...type, cascade: next === "cascade" });
          }}
          value={type.cascade ? "cascade" : "refuse"}
        >
          <RadioChoice
            label={t`Don’t allow it while this record links to it`}
            value="refuse"
          />
          <RadioChoice label={t`Delete this record too`} value="cascade" />
        </RadioGroup>
      </div>
    </>
  );
};

/** What a yes or no starts as on a record that doesn't say. */
const BooleanOptions = ({
  type,
  disabled,
  onChange,
}: {
  type: Extract<FieldType, { kind: "boolean" }>;
  disabled: boolean;
  onChange: (type: FieldType) => void;
}) => {
  const { t } = useLingui();
  const id = useId();
  let picked = "none";
  if (type.default !== null) {
    picked = type.default ? "yes" : "no";
  }
  return (
    <div {...stylex.props(styles.stack)}>
      <Text id={`${id}-starts`} size="sm" weight="medium">
        <Trans>A new record starts as</Trans>
      </Text>
      <RadioGroup
        aria-labelledby={`${id}-starts`}
        disabled={disabled}
        onValueChange={(next) => {
          onChange({
            ...type,
            default: next === "none" ? null : next === "yes",
          });
        }}
        value={picked}
      >
        <RadioChoice label={t`Empty`} value="none" />
        <RadioChoice label={t`Yes`} value="yes" />
        <RadioChoice label={t`No`} value="no" />
      </RadioGroup>
    </div>
  );
};

/** The editor of what a field's kind takes, in plain words; nothing for a kind that takes nothing. */
const KindOptions = ({
  draft,
  tables,
  disabled,
  onChange,
}: {
  draft: Draft;
  tables: readonly string[];
  disabled: boolean;
  onChange: (draft: Draft) => void;
}) => {
  const { t } = useLingui();
  const { type } = draft;
  const retyped = (next: FieldType): void => {
    onChange({ ...draft, type: next });
  };
  switch (type.kind) {
    case "text":
    case "email": {
      return (
        <>
          <Toggle
            checked={type.trim}
            disabled={disabled}
            label={t`Remove spaces at the start and end`}
            onChange={(trim) => {
              retyped({ ...type, trim });
            }}
          />
          <Bounds
            disabled={disabled}
            max={type.max}
            maxLabel={t`Most characters`}
            min={type.min}
            minLabel={t`Fewest characters`}
            onChange={(bounds) => {
              retyped({ ...type, ...bounds });
            }}
            whole
          />
        </>
      );
    }
    case "number": {
      return (
        <>
          <Toggle
            checked={!type.integer}
            disabled={disabled}
            label={t`Allow decimals`}
            onChange={(decimals) => {
              retyped({ ...type, integer: !decimals });
            }}
          />
          <Bounds
            disabled={disabled}
            max={type.max}
            maxLabel={t`Highest`}
            min={type.min}
            minLabel={t`Lowest`}
            onChange={(bounds) => {
              retyped({ ...type, ...bounds });
            }}
            whole={false}
          />
        </>
      );
    }
    case "boolean": {
      return (
        <BooleanOptions disabled={disabled} onChange={retyped} type={type} />
      );
    }
    case "choice": {
      return (
        <ChoiceOptions
          disabled={disabled}
          onChange={(options) => {
            onChange({ ...draft, options });
          }}
          options={draft.options}
        />
      );
    }
    case "link": {
      return (
        <LinkOptions
          disabled={disabled}
          onChange={retyped}
          tables={tables}
          type={type}
        />
      );
    }
    case "date":
    case "person":
    case "file":
    case "money":
    case "other": {
      return null;
    }
    default: {
      return null;
    }
  }
};

/** The kind picker: every kind with its icon, and what it holds under its words. */
const KindSelect = ({
  value,
  options,
  disabled,
  onPick,
}: {
  value: FieldKind;
  options: KindOption[];
  disabled: boolean;
  onPick: (kind: FieldKind) => void;
}) => {
  const { t } = useLingui();
  return (
    <Field>
      <FieldLabel>
        <Trans>Type</Trans>
      </FieldLabel>
      <Select
        disabled={disabled}
        items={options.map(({ value: each, label }) => ({
          value: each,
          label,
        }))}
        onValueChange={(next) => {
          const picked = pickedKinds.find((each) => each === next);
          if (picked !== undefined) {
            onPick(picked);
          }
        }}
        value={value}
      >
        <SelectTrigger aria-label={t`Type`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              description={option.description}
              key={option.value}
              label={option.label}
              value={option.value}
            >
              <span {...stylex.props(styles.kindWords)}>
                <Icon icon={option.icon} />
                {option.label}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
};

/**
 * A field's editor: its name, its kind and what that kind takes, whether
 * every record needs it; Save makes its operations one after another,
 * and Remove removes one that exists (its review asks first). A new
 * field's (`field` undefined) starts as `kind`.
 */
const FieldEditor = ({
  table,
  field,
  kind,
  tables,
  disabled,
  onChange,
  onDone,
  onCancel,
}: {
  table: DataModelTable;
  field: DataModelField | undefined;
  kind: FieldKind;
  tables: readonly string[];
  disabled: boolean;
  onChange: (change: ModelChange) => Promise<boolean>;
  /** Hears the field's name once it's saved. */
  onDone?: (name: string) => void;
  onCancel: () => void;
}) => {
  const { t } = useLingui();
  const { options, option } = useFieldKinds();
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(field, kind, tables));
  const named = identifierOf(draft.name);
  const made = operationsOf(table.name, field, draft);
  const typeOptions =
    draft.type.kind === "other" ? [...options, option("other")] : options;
  return (
    <Form
      aria-label={field === undefined ? t`New field` : field.name}
      onSubmit={(event) => {
        event.preventDefault();
        const [only] = made;
        if (only === undefined) {
          return;
        }
        void (async () => {
          // A rename and a retype are one change, made or reviewed whole;
          // the form stays as typed until it's made.
          if (await onChange(made.length === 1 ? only : made)) {
            onDone?.(named);
          }
        })();
      }}
    >
      <header {...stylex.props(styles.head)}>
        <IconTile icon={kindIcon(draft.type.kind)} />
        <Heading level={2} size="ui">
          {field === undefined ? t`New field` : field.name}
        </Heading>
      </header>
      <Field>
        <FieldLabel htmlFor={`${id}-name`}>
          <Trans>Name</Trans>
        </FieldLabel>
        <Input
          aria-label={t`Field name`}
          autoFocus={field === undefined}
          disabled={disabled}
          id={`${id}-name`}
          onValueChange={(name) => {
            setDraft({ ...draft, name });
          }}
          value={draft.name}
        />
        {named !== "" && named !== draft.name.trim() ? (
          <FieldDescription>
            <Trans>Saved as {named}</Trans>
          </FieldDescription>
        ) : null}
      </Field>
      <KindSelect
        disabled={disabled}
        onPick={(picked) => {
          setDraft({
            ...draft,
            type:
              field?.type.kind === picked
                ? field.type
                : blankType(picked, tables),
          });
        }}
        options={typeOptions}
        value={draft.type.kind}
      />
      <KindOptions
        disabled={disabled}
        draft={draft}
        onChange={setDraft}
        tables={tables}
      />
      {fillsItself(draft.type) ? null : (
        <Toggle
          checked={draft.required}
          disabled={disabled}
          label={t`Required`}
          onChange={(required) => {
            setDraft({ ...draft, required });
          }}
        />
      )}
      <div {...stylex.props(styles.foot)}>
        {field === undefined ? (
          <Button onClick={onCancel} type="button" variant="ghost">
            {t`Cancel`}
          </Button>
        ) : (
          <Button
            disabled={disabled}
            icon={Trash}
            onClick={() => {
              void (async () => {
                if (
                  await onChange({
                    op: "removeField",
                    table: table.name,
                    field: field.name,
                  })
                ) {
                  onCancel();
                }
              })();
            }}
            type="button"
            variant="danger"
          >
            {t`Remove`}
          </Button>
        )}
        <Button
          disabled={disabled || made.length === 0}
          type="submit"
          variant="ink"
        >
          {field === undefined ? t`Add field` : t`Save`}
        </Button>
      </div>
    </Form>
  );
};

/** A new field's first step: its kind, picked from every kind laid out with what it holds. */
const KindStep = ({
  onPick,
  onCancel,
  cancellable,
}: {
  onPick: (kind: FieldKind) => void;
  onCancel: () => void;
  cancellable: boolean;
}) => {
  const { t } = useLingui();
  const { options } = useFieldKinds();
  return (
    <section aria-label={t`New field`} {...stylex.props(styles.stack)}>
      <header {...stylex.props(styles.foot)}>
        <Heading level={2} size="ui">
          {t`What kind of field?`}
        </Heading>
        {cancellable ? (
          <Button onClick={onCancel} size="sm" type="button" variant="ghost">
            {t`Cancel`}
          </Button>
        ) : null}
      </header>
      <RowList aria-label={t`Kinds of field`}>
        {options.map((option) => (
          <RowListItem
            detail={option.description}
            icon={option.icon}
            key={option.value}
            name={option.label}
            onPress={() => {
              onPick(option.value);
            }}
          />
        ))}
      </RowList>
    </section>
  );
};

/**
 * What the Fields page has open: a field (its ID, or its name for one just
 * added), or a new one, its kind picked or not.
 */
type Opened =
  | { kind: "field"; id: string }
  | { kind: "new"; picked: FieldKind | undefined };

/**
 * A table's fields: the list, in order, on one side, and the field open
 * on the other; a new one starts from its kind.
 */
export const FieldsView = ({
  table,
  tables,
  disabled,
  onChange,
}: {
  table: DataModelTable;
  tables: readonly string[];
  disabled: boolean;
  onChange: (change: ModelChange) => Promise<boolean>;
}) => {
  const { t } = useLingui();
  const { describe } = useFieldKinds();
  const first = table.fields.at(0);
  const [opened, setOpened] = useState<Opened>(
    first === undefined
      ? { kind: "new", picked: undefined }
      : { kind: "field", id: first.id }
  );
  // The open field, as the model now has it: none once it's removed.
  const field =
    opened.kind === "field"
      ? (table.fields.find(
          ({ id, name }) => id === opened.id || name === opened.id
        ) ?? first)
      : undefined;
  const openFirst = (): void => {
    setOpened(
      first === undefined
        ? { kind: "new", picked: undefined }
        : { kind: "field", id: first.id }
    );
  };
  const last = table.fields.length - 1;
  const move = (name: string, to: number): void => {
    void (async () => {
      const place = to + 1;
      if (
        await onChange({ op: "moveField", table: table.name, field: name, to })
      ) {
        announce(t`${name} is now at place ${place}.`);
      }
    })();
  };
  return (
    <div {...stylex.props(styles.view)}>
      <div {...stylex.props(styles.list)}>
        <RowList aria-label={t`Fields`}>
          {table.fields.map((each, index) => {
            const { name } = each;
            return (
              <RowListItem
                actions={
                  <>
                    <RowListAction
                      aria-label={t`Move ${name} up`}
                      disabled={disabled || index === 0}
                      icon={ArrowUp}
                      onPress={() => {
                        move(name, index - 1);
                      }}
                    />
                    <RowListAction
                      aria-label={t`Move ${name} down`}
                      disabled={disabled || index === last}
                      icon={ArrowDown}
                      onPress={() => {
                        move(name, index + 1);
                      }}
                    />
                  </>
                }
                detail={describe(each.type)}
                icon={kindIcon(each.type.kind)}
                key={each.id}
                mark={
                  each.required ? (
                    <Badge size="sm">{t`Required`}</Badge>
                  ) : undefined
                }
                name={name}
                onPress={() => {
                  setOpened({ kind: "field", id: each.id });
                }}
              />
            );
          })}
          <RowListAdd
            disabled={disabled}
            onPress={() => {
              setOpened({ kind: "new", picked: undefined });
            }}
          >
            {t`Add field`}
          </RowListAdd>
        </RowList>
      </div>
      <div {...stylex.props(styles.editor)}>
        {opened.kind === "new" && opened.picked === undefined ? (
          <KindStep
            cancellable={first !== undefined}
            onCancel={openFirst}
            onPick={(picked) => {
              setOpened({ kind: "new", picked });
            }}
          />
        ) : null}
        {opened.kind === "new" && opened.picked !== undefined ? (
          <FieldEditor
            disabled={disabled}
            field={undefined}
            key={`new/${opened.picked}`}
            kind={opened.picked}
            onCancel={openFirst}
            onChange={onChange}
            onDone={(name) => {
              setOpened({ kind: "field", id: name });
            }}
            table={table}
            tables={tables}
          />
        ) : null}
        {opened.kind === "field" && field !== undefined ? (
          <FieldEditor
            disabled={disabled}
            field={field}
            // Starts again from the field as the model now has it.
            key={JSON.stringify(field)}
            kind={field.type.kind}
            onCancel={openFirst}
            onChange={onChange}
            table={table}
            tables={tables}
          />
        ) : null}
      </div>
    </div>
  );
};
