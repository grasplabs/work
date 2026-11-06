import { fieldCode, fieldKindCode } from "@grasp-os/shared/data-model";
import type {
  DataModelField,
  DataModelTable,
  FieldKind,
  FieldType,
} from "@grasp-os/shared/data-model";
import { Button } from "@grasp-os/ui/components/button";
import {
  FieldTypeGallery,
  FieldTypeIcon,
  FieldTypePicker,
  ModelFieldButton,
} from "@grasp-os/ui/components/data-model";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
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
import {
  SortableItem,
  SortableList,
} from "@grasp-os/ui/components/sortable-list";
import type { SortableWords } from "@grasp-os/ui/components/sortable-list";
import { Switch } from "@grasp-os/ui/components/switch";
import { Trans, useLingui } from "@lingui/react/macro";
import { PlusIcon, Table2Icon, TrashIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";

import type { ModelChange, ModelOperation } from "./data-model-changes.tsx";
import { KindIcon, pickedKinds, useFieldKinds } from "./field-kinds.tsx";
import { identifierOf } from "./identifier.ts";

// A table's fields in its Data view's Fields page, as a no-code tool
// shows them: the fields in a column of their own, in their order (each
// dragged, or moved from the keyboard, to its place), and the one open
// beside them with an editor of its own kind: a choice's options as a list
// to add to, reorder and remove from, a number's decimals and bounds, a
// link's table. A new field starts from its kind, picked from every kind
// laid out with what it holds. Each editor offers only what the
// definition's types take (`FieldType`), and saves through the
// definition's own operations, as the chat's agent does.

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
  const kept =
    field !== undefined &&
    JSON.stringify(type) === JSON.stringify(field.type) &&
    type.kind !== "boolean";
  if (kept) {
    return fieldCode(field.code, required);
  }
  const code = fieldKindCode(type) ?? field?.code;
  return code === undefined ? undefined : fieldCode(code, required);
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

/** What a screen reader hears as a list is put in order, in the page's language. */
const useSortableWords = (): SortableWords => {
  const { t } = useLingui();
  return {
    instructions: t`To move an item, press space or enter, then the arrow keys. Press space or enter again to put it down, or escape to cancel.`,
    picked: (name, place) => t`Picked up ${name}, at place ${place}.`,
    moved: (name, place) => t`${name} is now at place ${place}.`,
    dropped: (name, place) => t`Put ${name} down at place ${place}.`,
    cancelled: (name) => t`Put ${name} back where it was.`,
  };
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
  const id = useId();
  const crossed = min !== null && max !== null && min > max;
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field data-invalid={crossed || undefined}>
        <FieldLabel htmlFor={`${id}-min`}>{minLabel}</FieldLabel>
        <Input
          aria-invalid={crossed || undefined}
          disabled={disabled}
          id={`${id}-min`}
          inputMode={whole ? "numeric" : "decimal"}
          min={whole ? 0 : undefined}
          onChange={(event) => {
            onChange({ min: numberOf(event.target.value), max });
          }}
          step={whole ? 1 : "any"}
          type="number"
          value={min ?? ""}
        />
      </Field>
      <Field data-invalid={crossed || undefined}>
        <FieldLabel htmlFor={`${id}-max`}>{maxLabel}</FieldLabel>
        <Input
          aria-invalid={crossed || undefined}
          disabled={disabled}
          id={`${id}-max`}
          inputMode={whole ? "numeric" : "decimal"}
          min={whole ? 0 : undefined}
          onChange={(event) => {
            onChange({ min, max: numberOf(event.target.value) });
          }}
          step={whole ? 1 : "any"}
          type="number"
          value={max ?? ""}
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
}) => {
  const id = useId();
  return (
    <Field orientation="horizontal">
      <Switch
        checked={checked}
        disabled={disabled}
        id={id}
        onCheckedChange={onChange}
      />
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
    </Field>
  );
};

/** A choice's options: each typed in place, put in order, removed; new ones added under them. */
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
  const words = useSortableWords();
  const [typed, setTyped] = useState("");
  const add = (): void => {
    const value = typed.trim();
    if (value === "") {
      return;
    }
    onChange([...options, { id: crypto.randomUUID(), value }]);
    setTyped("");
  };
  return (
    <FieldSet>
      <FieldLegend variant="label">
        <Trans>Options</Trans>
      </FieldLegend>
      <SortableList
        aria-label={t`Options`}
        disabled={disabled}
        items={options.map(({ id, value }) => ({ id, name: value }))}
        onMove={(id, to) => {
          const moved = options.find((option) => option.id === id);
          if (moved === undefined) {
            return;
          }
          const rest = options.filter((option) => option.id !== id);
          onChange([...rest.slice(0, to), moved, ...rest.slice(to)]);
        }}
        words={words}
      >
        {options.map((option, index) => {
          const place = index + 1;
          const { value } = option;
          return (
            <SortableItem
              handleLabel={t`Move ${value}`}
              id={option.id}
              key={option.id}
            >
              <Input
                aria-label={t`Option ${place}`}
                className="flex-1"
                disabled={disabled}
                onChange={(event) => {
                  onChange(
                    options.map((each) =>
                      each.id === option.id
                        ? { ...each, value: event.target.value }
                        : each
                    )
                  );
                }}
                value={option.value}
              />
              <Button
                aria-label={t`Remove ${value}`}
                disabled={disabled}
                onClick={() => {
                  onChange(options.filter((each) => each.id !== option.id));
                }}
                size="icon-sm"
                title={t`Remove ${value}`}
                type="button"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </SortableItem>
          );
        })}
      </SortableList>
      <div className="flex gap-2">
        <Input
          aria-label={t`New option`}
          disabled={disabled}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              // Adds the option; the field isn't saved until Save.
              event.preventDefault();
              add();
            }
          }}
          placeholder={t`New option`}
          value={typed}
        />
        <Button
          disabled={disabled || typed.trim() === ""}
          onClick={add}
          type="button"
          variant="outline"
        >
          <PlusIcon data-icon="inline-start" />
          <Trans>Add option</Trans>
        </Button>
      </div>
    </FieldSet>
  );
};

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
  const items = tables.map((table) => ({ value: table, label: table }));
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-table`}>
          <Trans>Links to</Trans>
        </FieldLabel>
        <Select
          disabled={disabled}
          items={items}
          onValueChange={(next: unknown) => {
            if (typeof next === "string") {
              onChange({ ...type, table: next });
            }
          }}
          value={type.table === "" ? null : type.table}
        >
          <SelectTrigger
            aria-label={t`Links to`}
            className="w-full"
            id={`${id}-table`}
          >
            <SelectValue placeholder={t`Pick a table`} />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                <Table2Icon />
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <FieldSet>
        <FieldLegend variant="label">
          <Trans>When the linked record is deleted</Trans>
        </FieldLegend>
        <RadioGroup
          disabled={disabled}
          onValueChange={(next: unknown) => {
            onChange({ ...type, cascade: next === "cascade" });
          }}
          value={type.cascade ? "cascade" : "refuse"}
        >
          <Field orientation="horizontal">
            <RadioGroupItem id={`${id}-refuse`} value="refuse" />
            <FieldLabel htmlFor={`${id}-refuse`}>
              <Trans>Don’t allow it while this record links to it</Trans>
            </FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <RadioGroupItem id={`${id}-cascade`} value="cascade" />
            <FieldLabel htmlFor={`${id}-cascade`}>
              <Trans>Delete this record too</Trans>
            </FieldLabel>
          </Field>
        </RadioGroup>
      </FieldSet>
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
  const id = useId();
  const choices = [
    { value: "none", label: <Trans>Empty</Trans> },
    { value: "yes", label: <Trans>Yes</Trans> },
    { value: "no", label: <Trans>No</Trans> },
  ] as const;
  let picked = "none";
  if (type.default !== null) {
    picked = type.default ? "yes" : "no";
  }
  return (
    <FieldSet>
      <FieldLegend variant="label">
        <Trans>A new record starts as</Trans>
      </FieldLegend>
      <RadioGroup
        disabled={disabled}
        onValueChange={(next: unknown) => {
          onChange({
            ...type,
            default: next === "none" ? null : next === "yes",
          });
        }}
        value={picked}
      >
        {choices.map((choice) => (
          <Field key={choice.value} orientation="horizontal">
            <RadioGroupItem id={`${id}-${choice.value}`} value={choice.value} />
            <FieldLabel htmlFor={`${id}-${choice.value}`}>
              {choice.label}
            </FieldLabel>
          </Field>
        ))}
      </RadioGroup>
    </FieldSet>
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

/**
 * A field's editor: its name, its kind and what that kind takes, whether
 * every record needs it; Save makes its operations one after another,
 * and Remove removes one that exists. A new field's (`field` undefined)
 * starts as `kind`.
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
  const { options, label } = useFieldKinds();
  const id = useId();
  const [draft, setDraft] = useState(() => draftOf(field, kind, tables));
  const named = identifierOf(draft.name);
  const made = operationsOf(table.name, field, draft);
  const typeOptions =
    draft.type.kind === "other"
      ? [
          ...options,
          {
            value: "other",
            label: label("other"),
            icon: <KindIcon kind="other" />,
          },
        ]
      : options;
  return (
    <form
      aria-label={field === undefined ? t`New field` : field.name}
      className="flex flex-col gap-6"
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
      <header className="flex items-center gap-3">
        <FieldTypeIcon>
          <KindIcon kind={draft.type.kind} />
        </FieldTypeIcon>
        <h2 className="min-w-0 truncate text-base font-medium">
          {field === undefined ? <Trans>New field</Trans> : field.name}
        </h2>
      </header>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input
            aria-label={t`Field name`}
            autoFocus={field === undefined}
            disabled={disabled}
            id={`${id}-name`}
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
            }}
            value={draft.name}
          />
          {named !== "" && named !== draft.name.trim() ? (
            <FieldDescription>
              <Trans>Saved as {named}</Trans>
            </FieldDescription>
          ) : null}
        </Field>
        <Field>
          <FieldLabel>
            <Trans>Type</Trans>
          </FieldLabel>
          <FieldTypePicker
            className="w-full"
            disabled={disabled}
            label={t`Type`}
            onValueChange={(value) => {
              const picked = pickedKinds.find((each) => each === value);
              if (picked !== undefined) {
                setDraft({
                  ...draft,
                  type:
                    field?.type.kind === picked
                      ? field.type
                      : blankType(picked, tables),
                });
              }
            }}
            options={typeOptions}
            value={draft.type.kind}
          />
        </Field>
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
      </FieldGroup>
      <div className="flex items-center gap-2 border-t pt-4">
        {field === undefined ? (
          <Button onClick={onCancel} type="button" variant="ghost">
            <Trans>Cancel</Trans>
          </Button>
        ) : (
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
                  onCancel();
                }
              })();
            }}
            type="button"
            variant="destructive"
          >
            <TrashIcon data-icon="inline-start" />
            <Trans>Remove</Trans>
          </Button>
        )}
        <Button
          className="ms-auto"
          disabled={disabled || made.length === 0}
          type="submit"
        >
          {field === undefined ? <Trans>Add field</Trans> : <Trans>Save</Trans>}
        </Button>
      </div>
    </form>
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
    <section aria-label={t`New field`} className="flex flex-col gap-4">
      <header className="flex items-center gap-3">
        <h2 className="flex-1 text-base font-medium">
          <Trans>What kind of field?</Trans>
        </h2>
        {cancellable ? (
          <Button onClick={onCancel} size="sm" type="button" variant="ghost">
            <Trans>Cancel</Trans>
          </Button>
        ) : null}
      </header>
      <FieldTypeGallery
        label={t`Kinds of field`}
        onPick={(value) => {
          const picked = pickedKinds.find((each) => each === value);
          if (picked !== undefined) {
            onPick(picked);
          }
        }}
        options={options}
      />
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
  const words = useSortableWords();
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
  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="flex max-h-64 flex-none flex-col gap-2 overflow-y-auto border-b p-2 md:max-h-none md:w-72 md:border-e md:border-b-0">
        <Button
          disabled={disabled}
          onClick={() => {
            setOpened({ kind: "new", picked: undefined });
          }}
          size="sm"
          variant="outline"
        >
          <PlusIcon data-icon="inline-start" />
          <Trans>Add field</Trans>
        </Button>
        <SortableList
          aria-label={t`Fields`}
          disabled={disabled}
          items={table.fields.map(({ id, name }) => ({ id, name }))}
          onMove={(id, to) => {
            const moved = table.fields.find((each) => each.id === id);
            if (moved !== undefined) {
              void onChange({
                op: "moveField",
                table: table.name,
                field: moved.name,
                to,
              });
            }
          }}
          words={words}
        >
          {table.fields.map((each) => {
            const { name } = each;
            return (
              <SortableItem
                handleLabel={t`Move ${name}`}
                id={each.id}
                key={each.id}
              >
                <ModelFieldButton
                  active={each.id === field?.id}
                  className="flex-1"
                  description={describe(each.type)}
                  icon={<KindIcon kind={each.type.kind} />}
                  meta={each.required ? t`Required` : undefined}
                  onClick={() => {
                    setOpened({ kind: "field", id: each.id });
                  }}
                >
                  {name}
                </ModelFieldButton>
              </SortableItem>
            );
          })}
        </SortableList>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="max-w-xl p-4">
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
    </div>
  );
};
