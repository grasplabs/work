import type {
  FunctionArgs,
  FilesReference,
  FunctionReference,
  FunctionReturn,
} from "@grasp-os/runtime/app";
import { bindingOf } from "@grasp-os/runtime/forms";
import type { ValueDescriptor } from "@grasp-os/runtime/forms";
import { useQuery, useRetryFailed, useUpload } from "@grasp-os/runtime/react";
import type {
  Declaring,
  FormStatus,
  GraspForm,
  TextFieldName,
} from "@grasp-os/runtime/react";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { ButtonGroup } from "@grasp-os/ui/components/button-group";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@grasp-os/ui/components/combobox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Progress } from "@grasp-os/ui/components/progress";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Switch } from "@grasp-os/ui/components/switch";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { useSettled } from "@grasp-os/ui/hooks/use-settled";
import { cn } from "@grasp-os/ui/lib/utils";
import type { DeepKeys, DeepValue } from "@tanstack/react-form";
import {
  BoldIcon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  PaperclipIcon,
} from "lucide-react";
import { useId, useRef, useState, useSyncExternalStore } from "react";
import type * as React from "react";

import { pageText } from "./internal/language.ts";
import type { Texts } from "./internal/language.ts";
import { QueryBoundary } from "./internal/query-boundary.tsx";
import { applyMark, marks } from "./internal/rich-text-marks.ts";
import type { Mark } from "./internal/rich-text-marks.ts";

// The fields and parts of a form the SDK's `useForm` made (spec 10.2.2):
// one semantic form, a field for every kind of value (text, a choice or
// several, a number, a day or a moment, a yes or no, a record, a file,
// formatted text) with its label, description and error,
// the form's own error, and the submit button. They own what every form
// would otherwise write again: error IDs and `aria-invalid`, showing an
// error only once a field was left or a submit tried, the lock while a
// submission is in flight, focus on the first invalid field, and the
// submission itself.
//
// An App's page runs in a frame sandboxed without forms, where the
// browser submits nothing and fires no `submit` event: the submit button
// submits on its own click, which Enter in a field also fires.

/** Any Grasp form, whatever its values: what its submission parts need of it. */
type AnyForm = Pick<GraspForm<unknown, unknown>, "submit">;

/** The form's submission status, kept current. */
const useFormStatus = (form: object): FormStatus => {
  const binding = bindingOf(form);
  return useSyncExternalStore(
    (onChange) => binding.subscribe(onChange),
    () => binding.status()
  );
};

/** Moves focus to the first field `element` shows as invalid, once it shows it. */
const focusFirstInvalid = (element: HTMLFormElement | null): void => {
  requestAnimationFrame(() => {
    const invalid = element?.querySelector<HTMLElement>(
      '[aria-invalid="true"]'
    );
    invalid?.focus();
  });
};

/**
 * Submits `form`. Its failure is shown by the fields and `FormError`, so
 * the rejection is observed here; an invalid field gets focus.
 */
const submitFrom = async (
  form: AnyForm,
  element: HTMLFormElement | null
): Promise<void> => {
  // Not while a file field uploads: the form refuses it (`form.uploading`).
  if (bindingOf(form).status().uploading) {
    return;
  }
  try {
    await form.submit();
  } catch {
    focusFirstInvalid(element);
  }
};

/** One semantic form for `form`; its submit button submits it. */
const Form = ({
  form,
  className,
  ...props
}: Omit<React.ComponentProps<"form">, "onSubmit"> & {
  form: AnyForm;
}): React.JSX.Element => (
  <form
    {...props}
    className={cn("flex flex-col gap-6", className)}
    data-slot="form"
    noValidate
    onSubmit={(event) => {
      event.preventDefault();
      void submitFrom(form, event.currentTarget);
    }}
  />
);

/** What a field shows of its error: the field's own check, or the server's. */
const errorOf = (
  meta: { readonly errors: readonly unknown[]; readonly isBlurred: boolean },
  status: FormStatus,
  name: string
): string | undefined => {
  if (meta.isBlurred || status.attempted) {
    const [first] = meta.errors;
    if (typeof first === "string" && first !== "") {
      return first;
    }
  }
  return Object.hasOwn(status.fieldIssues, name)
    ? status.fieldIssues[name]
    : undefined;
};

/**
 * The names of a form's fields whose value is `Value`: what each field
 * helper binds, so a field of another type is a type error in the page.
 */
type FieldNameOf<Values, Value> = {
  [Name in DeepKeys<Values>]: DeepValue<Values, Name> extends Value
    ? Name
    : never;
}[DeepKeys<Values>];

/** A field that holds one choice: an enum's value, or a record's ID. */
type ChoiceFieldName<Values> = FieldNameOf<Values, string | null | undefined>;
/** A field that holds several choices: an array of an enum's values. */
type ChoicesFieldName<Values> = FieldNameOf<
  Values,
  readonly string[] | undefined
>;
/** A field that holds a number, a moment (`v.timestamp()`) among them. */
type NumberFieldName<Values> = FieldNameOf<Values, number | null | undefined>;
/** A field that holds a yes or no. */
type BooleanFieldName<Values> = FieldNameOf<Values, boolean | undefined>;
/** A field that holds a file's reference (`v.file()`). */
type FileFieldName<Values> = FieldNameOf<
  Values,
  { readonly id: string } | null | undefined
>;

/** What the fields say themselves, in the page's language unless the page says otherwise. */
interface FieldText {
  /** A select's choice of nothing. */
  readonly choose: string;
  /** A relation's list while its query loads, or its value while it is read. */
  readonly loading: string;
  /** A relation's list when the search answered nothing. */
  readonly noMatches: string;
  readonly showOptions: string;
  readonly clear: string;
  /** A relation's query, or a file's upload, that failed without saying why. */
  readonly failed: string;
  readonly tryAgain: string;
  /** Takes a file off its field (never deletes it). */
  readonly remove: string;
  /** A file the field held before the page opened. */
  readonly attached: string;
  readonly uploading: string;
  /** The rich text toolbar, and its buttons. */
  readonly formatting: string;
  readonly bold: string;
  readonly italic: string;
  readonly bullets: string;
  readonly numbers: string;
  /** Stops a file's upload that is taking too long. */
  readonly cancelUpload: string;
}

const fieldTexts: Texts<FieldText> = {
  en: {
    choose: "Choose…",
    loading: "Loading…",
    noMatches: "No matches.",
    showOptions: "Show options",
    clear: "Clear",
    failed: "This couldn't load.",
    tryAgain: "Try again",
    remove: "Remove",
    attached: "Attached file",
    uploading: "Uploading…",
    formatting: "Formatting",
    bold: "Bold",
    italic: "Italic",
    bullets: "Bulleted list",
    numbers: "Numbered list",
    cancelUpload: "Cancel upload",
  },
  de: {
    choose: "Auswählen…",
    loading: "Wird geladen…",
    noMatches: "Keine Treffer.",
    showOptions: "Optionen anzeigen",
    clear: "Leeren",
    failed: "Das konnte nicht geladen werden.",
    tryAgain: "Erneut versuchen",
    remove: "Entfernen",
    attached: "Angehängte Datei",
    uploading: "Wird hochgeladen…",
    formatting: "Formatierung",
    bold: "Fett",
    italic: "Kursiv",
    bullets: "Aufzählung",
    numbers: "Nummerierte Liste",
    cancelUpload: "Hochladen abbrechen",
  },
  nl: {
    choose: "Kiezen…",
    loading: "Laden…",
    noMatches: "Geen resultaten.",
    showOptions: "Opties tonen",
    clear: "Wissen",
    failed: "Dit kon niet worden geladen.",
    tryAgain: "Opnieuw proberen",
    remove: "Verwijderen",
    attached: "Bijgevoegd bestand",
    uploading: "Uploaden…",
    formatting: "Opmaak",
    bold: "Vet",
    italic: "Cursief",
    bullets: "Opsomming",
    numbers: "Genummerde lijst",
    cancelUpload: "Upload annuleren",
  },
  es: {
    choose: "Elegir…",
    loading: "Cargando…",
    noMatches: "Sin resultados.",
    showOptions: "Mostrar opciones",
    clear: "Borrar",
    failed: "No se ha podido cargar.",
    tryAgain: "Reintentar",
    remove: "Quitar",
    attached: "Archivo adjunto",
    uploading: "Subiendo…",
    formatting: "Formato",
    bold: "Negrita",
    italic: "Cursiva",
    bullets: "Lista con viñetas",
    numbers: "Lista numerada",
    cancelUpload: "Cancelar subida",
  },
  fr: {
    choose: "Choisir…",
    loading: "Chargement…",
    noMatches: "Aucun résultat.",
    showOptions: "Afficher les options",
    clear: "Effacer",
    failed: "Impossible de charger ceci.",
    tryAgain: "Réessayer",
    remove: "Retirer",
    attached: "Fichier joint",
    uploading: "Envoi en cours…",
    formatting: "Mise en forme",
    bold: "Gras",
    italic: "Italique",
    bullets: "Liste à puces",
    numbers: "Liste numérotée",
    cancelUpload: "Annuler l’envoi",
  },
};

/** What a field's control gets from the field around it. */
interface Control {
  id: string;
  name: string;
  value: unknown;
  disabled: boolean;
  invalid: boolean;
  /** Whether the schema needs a value the person must give. */
  required: boolean;
  describedBy: string | undefined;
  /** What the schema declares of the field, if it declares it. */
  descriptor: ValueDescriptor | undefined;
  /** The field's value once the person cleared it: null when the schema allows it. */
  empty: null | undefined;
  handleChange: (value: unknown) => void;
  handleBlur: () => void;
}

/**
 * What a text field holds as the person types `text`: left out once they
 * empty a field the schema lets them leave out, so an optional value that
 * must be well formed (an email) never goes as empty text; the text
 * otherwise, empty or not.
 */
const typedText = (control: Control, text: string): string | undefined =>
  text === "" && control.descriptor?.presence === "optional" ? undefined : text;

/** What every field takes. */
interface FieldProps<Values, Name> {
  /** The form the field belongs to, passed so its name is typed. */
  form: GraspForm<Values, unknown>;
  /** The field: one of the form's values, of the type this field edits. */
  name: Name;
  label: React.ReactNode;
  description?: React.ReactNode;
}

/** The IDs a control is described by, of those `shown`; undefined for none. */
const describedByOf = (
  shown: Readonly<Record<string, boolean>>
): string | undefined => {
  const ids = Object.keys(shown).filter((id) => shown[id] === true);
  return ids.length === 0 ? undefined : ids.join(" ");
};

/**
 * Whether `descriptor` needs a value the person must give: not one left
 * out, filled in by a default or null, nor text that may be empty.
 */
const isRequired = (descriptor: ValueDescriptor | undefined): boolean => {
  if (
    descriptor === undefined ||
    descriptor.presence !== "required" ||
    descriptor.nullable
  ) {
    return false;
  }
  if (descriptor.kind === "string") {
    return (descriptor.min ?? 0) > 0;
  }
  if (descriptor.kind === "array") {
    return (descriptor.min ?? 0) > 0;
  }
  return descriptor.kind !== "boolean";
};

/**
 * How a field sits around its control: its label above it (`stacked`),
 * beside a checkbox or switch (`inline`), or as the legend of a group of
 * controls (`group`).
 */
type Layout = "stacked" | "inline" | "group";

/** A field's label, description and error around its control. */
const FieldShell = <Values,>({
  form,
  name,
  label,
  description,
  layout = "stacked",
  render,
}: FieldProps<Values, string> & {
  layout?: Layout;
  render: (control: Control) => React.ReactNode;
}): React.JSX.Element => {
  const status = useFormStatus(form);
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const descriptor = bindingOf(form).fieldDescriptor(name);
  const { locked } = status;
  return (
    // SAFETY: a field's name is one of the form's keys (FieldNameOf).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    <form.Field name={name as never}>
      {(field) => {
        const error = errorOf(field.state.meta, status, name);
        const invalid = error !== undefined;
        const control: Control = {
          id,
          name,
          value: field.state.value,
          disabled: locked,
          invalid,
          required: isRequired(descriptor),
          describedBy: describedByOf({
            [descriptionId]: description !== undefined,
            [errorId]: invalid,
          }),
          descriptor,
          empty: descriptor?.nullable === true ? null : undefined,
          handleChange: (next) => {
            // SAFETY: each field hands on a value of the type its name
            // admits (FieldNameOf), or one the validator then refuses.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            field.handleChange(next as never);
          },
          handleBlur: field.handleBlur,
        };
        const shownDescription =
          description === undefined ? null : (
            <FieldDescription id={descriptionId}>
              {description}
            </FieldDescription>
          );
        const shownError = <FieldError id={errorId}>{error}</FieldError>;
        if (layout === "group") {
          return (
            <FieldSet
              aria-describedby={control.describedBy}
              data-invalid={invalid}
              disabled={locked}
            >
              <FieldLegend variant="label">{label}</FieldLegend>
              {shownDescription}
              {render(control)}
              {shownError}
            </FieldSet>
          );
        }
        if (layout === "inline") {
          return (
            <Field data-invalid={invalid} orientation="horizontal">
              {render(control)}
              <FieldContent>
                <FieldLabel htmlFor={id}>{label}</FieldLabel>
                {shownDescription}
                {shownError}
              </FieldContent>
            </Field>
          );
        }
        return (
          <Field data-invalid={invalid}>
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            {render(control)}
            {shownDescription}
            {shownError}
          </Field>
        );
      }}
    </form.Field>
  );
};

/** What a field passes to its control, of the props it was given. */
type ControlProps<Element extends "input" | "textarea"> = Omit<
  React.ComponentProps<Element>,
  | "form"
  | "name"
  | "value"
  | "defaultValue"
  | "onChange"
  | "onBlur"
  | "id"
  | "type"
>;

/** A control's text: text as it is, anything else as nothing. */
const textOf = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** A one-line text field of `form`, with its label, description and error. */
const TextField = <Values,>({
  form,
  name,
  label,
  description,
  type,
  ...props
}: FieldProps<Values, TextFieldName<Values>> &
  ControlProps<"input"> & {
    type?: "text" | "email" | "url" | "tel" | "search" | "password";
  }): React.JSX.Element => (
  <FieldShell
    description={description}
    form={form}
    label={label}
    name={name}
    render={(control) => (
      <Input
        {...props}
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid}
        aria-required={control.required}
        disabled={control.disabled || props.disabled}
        id={control.id}
        name={control.name}
        onBlur={control.handleBlur}
        onChange={(event) => {
          control.handleChange(typedText(control, event.target.value));
        }}
        type={type}
        value={textOf(control.value)}
      />
    )}
  />
);

/** A multi-line text field of `form`, with its label, description and error. */
const TextareaField = <Values,>({
  form,
  name,
  label,
  description,
  ...props
}: FieldProps<Values, TextFieldName<Values>> &
  ControlProps<"textarea">): React.JSX.Element => (
  <FieldShell
    description={description}
    form={form}
    label={label}
    name={name}
    render={(control) => (
      <Textarea
        {...props}
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid}
        aria-required={control.required}
        disabled={control.disabled || props.disabled}
        id={control.id}
        name={control.name}
        onBlur={control.handleBlur}
        onChange={(event) => {
          control.handleChange(typedText(control, event.target.value));
        }}
        value={textOf(control.value)}
      />
    )}
  />
);

/** The values an enum, or an array of one, declares, in its order. */
const enumValuesOf = (
  descriptor: ValueDescriptor | undefined
): readonly string[] => {
  if (descriptor?.kind === "enum") {
    return descriptor.values;
  }
  if (descriptor?.kind === "array" && descriptor.item.kind === "enum") {
    return descriptor.item.values;
  }
  return [];
};

/**
 * The choices a field offers: the schema's enum values, each named by
 * `options` where it names it; or `options` alone, for a field whose
 * schema is text.
 */
const choicesOf = (
  descriptor: ValueDescriptor | undefined,
  options: Readonly<Record<string, string>> | undefined
): readonly { readonly value: string; readonly label: string }[] => {
  const declared = enumValuesOf(descriptor);
  const values = declared.length > 0 ? declared : Object.keys(options ?? {});
  return values.map((value) => ({
    value,
    label:
      options !== undefined && Object.hasOwn(options, value)
        ? (options[value] ?? value)
        : value,
  }));
};

/**
 * A field of `form` that holds one of a fixed set of values: an enum's
 * (`v.enum([...])`), each shown by its label in `options`, or itself.
 * Choosing nothing clears it (null where the schema allows it).
 */
const SelectField = <Values,>({
  form,
  name,
  label,
  description,
  options,
  placeholder,
}: FieldProps<Values, ChoiceFieldName<Values>> & {
  /** Each value's label, by value; or the values, for a text field. */
  options?: Readonly<Record<string, string>>;
  /** What the select shows while nothing is chosen. */
  placeholder?: string;
}): React.JSX.Element => (
  <FieldShell
    description={description}
    form={form}
    label={label}
    name={name}
    render={(control) => (
      <NativeSelect
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid}
        aria-required={control.required}
        className="w-full"
        disabled={control.disabled}
        id={control.id}
        name={control.name}
        onBlur={control.handleBlur}
        onChange={(event) => {
          const { value } = event.target;
          control.handleChange(value === "" ? control.empty : value);
        }}
        value={textOf(control.value)}
      >
        <NativeSelectOption value="">
          {placeholder ?? pageText(fieldTexts).choose}
        </NativeSelectOption>
        {choicesOf(control.descriptor, options).map((choice) => (
          <NativeSelectOption key={choice.value} value={choice.value}>
            {choice.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    )}
  />
);

/** A field's values, as a list of text. */
const listOf = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/**
 * A field of `form` that holds several of a fixed set of values: an array
 * of an enum (`v.array(v.enum([...]))`), a checkbox each, in the enum's
 * order.
 */
const MultiSelectField = <Values,>({
  form,
  name,
  label,
  description,
  options,
}: FieldProps<Values, ChoicesFieldName<Values>> & {
  /** Each value's label, by value; or the values, for an array of text. */
  options?: Readonly<Record<string, string>>;
}): React.JSX.Element => (
  <FieldShell
    description={description}
    form={form}
    label={label}
    layout="group"
    name={name}
    render={(control) => {
      const chosen = listOf(control.value);
      const choices = choicesOf(control.descriptor, options);
      return (
        <FieldGroup data-slot="checkbox-group">
          {choices.map((choice) => {
            const id = `${control.id}-${choice.value}`;
            return (
              <Field key={choice.value} orientation="horizontal">
                <Checkbox
                  aria-invalid={control.invalid}
                  checked={chosen.includes(choice.value)}
                  disabled={control.disabled}
                  id={id}
                  name={control.name}
                  onCheckedChange={(checked) => {
                    // Kept in the schema's order, whatever order they were picked in.
                    const next = new Set(chosen);
                    if (checked) {
                      next.add(choice.value);
                    } else {
                      next.delete(choice.value);
                    }
                    control.handleChange(
                      choices
                        .map(({ value }) => value)
                        .filter((value) => next.has(value))
                    );
                    control.handleBlur();
                  }}
                  value={choice.value}
                />
                <FieldLabel htmlFor={id}>{choice.label}</FieldLabel>
              </Field>
            );
          })}
        </FieldGroup>
      );
    }}
  />
);

/** A number's text as an input shows it. */
const numberText = (value: unknown): string => {
  if (typeof value === "number") {
    return String(value);
  }
  return typeof value === "string" ? value : "";
};

/**
 * What the person typed, as a number field holds it: a number, the
 * cleared value, or the text itself, which the validator refuses as the
 * wrong type rather than it being lost.
 */
const parsedNumber = (text: string, empty: null | undefined): unknown => {
  if (text.trim() === "") {
    return empty;
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : text;
};

/** A number input that keeps what the person types ("1.") while it is a number already. */
const NumberInput = ({
  control,
  ...props
}: ControlProps<"input"> & { control: Control }): React.JSX.Element => {
  const [typed, setTyped] = useState(() => numberText(control.value));
  // The field's value changed elsewhere (a reset, a record arrived): shown as it is.
  const shown =
    Object.is(parsedNumber(typed, control.empty), control.value) ||
    (typed.trim() === "" &&
      (control.value === null || control.value === undefined))
      ? typed
      : numberText(control.value);
  const { descriptor } = control;
  const integer = descriptor?.kind === "number" && descriptor.integer;
  return (
    <Input
      inputMode={integer ? "numeric" : "decimal"}
      max={descriptor?.kind === "number" ? descriptor.max : undefined}
      min={descriptor?.kind === "number" ? descriptor.min : undefined}
      step={integer ? 1 : "any"}
      {...props}
      aria-describedby={control.describedBy}
      aria-invalid={control.invalid}
      aria-required={control.required}
      disabled={control.disabled || props.disabled}
      id={control.id}
      name={control.name}
      onBlur={control.handleBlur}
      onChange={(event) => {
        setTyped(event.target.value);
        control.handleChange(parsedNumber(event.target.value, control.empty));
      }}
      type="number"
      value={shown}
    />
  );
};

/** A field of `form` that holds a number, bounded and whole as the schema says. */
const NumberField = <Values,>({
  form,
  name,
  label,
  description,
  ...props
}: FieldProps<Values, NumberFieldName<Values>> &
  ControlProps<"input">): React.JSX.Element => (
  <FieldShell
    description={description}
    form={form}
    label={label}
    name={name}
    render={(control) => <NumberInput {...props} control={control} />}
  />
);

/** Pads a part of a date to two digits. */
const twoDigits = (part: number): string => String(part).padStart(2, "0");

/** A moment's calendar day in UTC, as a date input shows it: `2026-11-03`. */
const dayText = (value: unknown): string =>
  typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString().slice(0, "yyyy-mm-dd".length)
    : "";

/** A moment in the person's own time zone, as a date-and-time input shows it. */
const localText = (value: unknown): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }
  const date = new Date(value);
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
};

/**
 * A field of `form` that holds a day (`v.timestamp()`): the moment that
 * day starts in UTC, so it is the same day wherever it is read.
 */
const DateField = <Values,>({
  form,
  name,
  label,
  description,
  ...props
}: FieldProps<Values, NumberFieldName<Values>> &
  ControlProps<"input">): React.JSX.Element => (
  <FieldShell
    description={description}
    form={form}
    label={label}
    name={name}
    render={(control) => (
      <Input
        {...props}
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid}
        aria-required={control.required}
        disabled={control.disabled || props.disabled}
        id={control.id}
        name={control.name}
        onBlur={control.handleBlur}
        onChange={(event) => {
          const { value } = event.target;
          control.handleChange(
            value === "" ? control.empty : Date.parse(`${value}T00:00:00Z`)
          );
        }}
        type="date"
        value={dayText(control.value)}
      />
    )}
  />
);

/**
 * A field of `form` that holds a moment (`v.timestamp()`), entered in the
 * person's own time zone, to the minute.
 */
const DateTimeField = <Values,>({
  form,
  name,
  label,
  description,
  ...props
}: FieldProps<Values, NumberFieldName<Values>> &
  ControlProps<"input">): React.JSX.Element => (
  <FieldShell
    description={description}
    form={form}
    label={label}
    name={name}
    render={(control) => (
      <Input
        {...props}
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid}
        aria-required={control.required}
        disabled={control.disabled || props.disabled}
        id={control.id}
        name={control.name}
        onBlur={control.handleBlur}
        onChange={(event) => {
          const { value } = event.target;
          // Read in the person's time zone: no `Z`.
          control.handleChange(
            value === "" ? control.empty : new Date(value).getTime()
          );
        }}
        type="datetime-local"
        value={localText(control.value)}
      />
    )}
  />
);

/** A field of `form` that holds a yes or no (`v.boolean()`), as a checkbox. */
const CheckboxField = <Values,>({
  form,
  name,
  label,
  description,
}: FieldProps<Values, BooleanFieldName<Values>>): React.JSX.Element => (
  <FieldShell
    description={description}
    form={form}
    label={label}
    layout="inline"
    name={name}
    render={(control) => (
      <Checkbox
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid}
        checked={control.value === true}
        disabled={control.disabled}
        id={control.id}
        name={control.name}
        onCheckedChange={(checked) => {
          control.handleChange(checked);
          control.handleBlur();
        }}
      />
    )}
  />
);

/** A field of `form` that holds a yes or no (`v.boolean()`), as a switch. */
const SwitchField = <Values,>({
  form,
  name,
  label,
  description,
}: FieldProps<Values, BooleanFieldName<Values>>): React.JSX.Element => (
  <FieldShell
    description={description}
    form={form}
    label={label}
    layout="inline"
    name={name}
    render={(control) => (
      <Switch
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid}
        checked={control.value === true}
        disabled={control.disabled}
        id={control.id}
        name={control.name}
        onCheckedChange={(checked) => {
          control.handleChange(checked);
          control.handleBlur();
        }}
      />
    )}
  />
);

/** A query, as a relation field reads its records with. */
type AnyQuery = FunctionReference<"query">;

/** The records `Reference` answers: a list of them, or a page of them. */
type RecordOf<Reference> =
  FunctionReturn<Reference> extends readonly (infer Item)[]
    ? Item
    : FunctionReturn<Reference> extends {
          readonly items: readonly (infer Item)[];
        }
      ? Item
      : never;

/** The ID of a record `Reference` answers. */
type IdOf<Reference> =
  RecordOf<Reference> extends { readonly _id: infer Id } ? Id : string;

/** The records a query answered: its list, or its page's. */
const recordsOf = (answer: unknown): readonly unknown[] => {
  if (Array.isArray(answer)) {
    return answer;
  }
  if (
    typeof answer === "object" &&
    answer !== null &&
    "items" in answer &&
    Array.isArray(answer.items)
  ) {
    return answer.items;
  }
  return [];
};

/** A record's `_id`, if it has one. */
const idOf = (record: unknown): string | undefined =>
  typeof record === "object" &&
  record !== null &&
  "_id" in record &&
  typeof record._id === "string"
    ? record._id
    : undefined;

/**
 * Marks the record a relation field stands in for the one its value names
 * while no query has answered it yet: named by its ID until one does.
 */
const standIn = Symbol("standIn");

/** How long typing settles before a search is read: one query, not one per key. */
const searchSettleMs = 250;

/**
 * How a relation field reads the record it holds, by its ID: a query of
 * one record (`api.people.get`), and its arguments for the ID.
 */
interface RelationLookup<Reference, Lookup extends AnyQuery> {
  readonly query: Lookup;
  readonly args: (id: IdOf<Reference>) => FunctionArgs<Lookup>;
}

/** What a relation field's picker takes. */
interface RelationProps<
  Reference extends AnyQuery,
  Lookup extends AnyQuery = AnyQuery,
> {
  /** The query that answers the records to choose from: a list, or a page. */
  query: Reference;
  /** The query's arguments for what the person typed (empty at first). */
  args: (search: string) => FunctionArgs<Reference>;
  /**
   * How the field reads the record it holds by its ID, to name a value it
   * started with, which a search needn't list: without it, that value
   * shows as its ID until the person picks another.
   */
  lookup?: RelationLookup<Reference, Lookup>;
  /** How a record is named in the list and once chosen. */
  optionLabel: (record: RecordOf<Reference>) => string;
  /** What the input shows while nothing is typed. */
  placeholder?: string;
  /** What it says, in the page's language. */
  text?: Partial<FieldText>;
}

/** The searchable list a relation field picks a record from. */
const RelationPicker = <
  Reference extends AnyQuery,
  Lookup extends AnyQuery = AnyQuery,
>({
  control,
  query,
  args,
  lookup,
  optionLabel,
  placeholder,
  text,
}: RelationProps<Reference, Lookup> & {
  control: Control;
  text: FieldText;
}): React.JSX.Element => {
  const [search, setSearch] = useState("");
  const settled = useSettled(search, searchSettleMs);
  const answer = useQuery(query, args(settled));
  // The record chosen here, kept while a later search no longer lists it.
  const [picked, setPicked] = useState<unknown>(null);
  const records = recordsOf(answer);
  const chosenId = typeof control.value === "string" ? control.value : null;
  const listed =
    chosenId === null
      ? undefined
      : (records.find((record) => idOf(record) === chosenId) ??
        (idOf(picked) === chosenId ? picked : undefined));
  // A value the field started with, which neither the search nor the
  // person's pick holds: read by its ID, to name it.
  let unlisted: IdOf<Reference> | null = null;
  if (listed === undefined && chosenId !== null) {
    // SAFETY: the field holds the ID of a record the query answers.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    unlisted = chosenId as IdOf<Reference>;
  }
  const looked = useQuery<FunctionReference<"query">>(
    lookup?.query ?? query,
    unlisted === null || lookup === undefined ? "skip" : lookup.args(unlisted)
  );
  // The lookup's answer: the record, or a list holding it.
  const lookedUp =
    idOf(looked) === chosenId
      ? looked
      : recordsOf(looked).find((record) => idOf(record) === chosenId);
  let chosen: unknown = null;
  if (chosenId !== null) {
    chosen = listed ??
      lookedUp ?? {
        _id: chosenId,
        [standIn]: true,
      };
  }
  const labelOf = (record: unknown): string => {
    if (typeof record === "object" && record !== null && standIn in record) {
      return lookup !== undefined && looked === undefined
        ? text.loading
        : (idOf(record) ?? "");
    }
    // SAFETY: every other record here came from the query's answer.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    return optionLabel(record as RecordOf<Reference>);
  };
  return (
    <Combobox
      disabled={control.disabled}
      filter={null}
      isItemEqualToValue={(item: unknown, value: unknown) =>
        idOf(item) === idOf(value)
      }
      itemToStringLabel={labelOf}
      items={records}
      onInputValueChange={(typed) => {
        setSearch(typed);
      }}
      onValueChange={(record: unknown) => {
        setPicked(record);
        control.handleChange(idOf(record) ?? control.empty);
        control.handleBlur();
      }}
      value={chosen}
    >
      <ComboboxInput
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid}
        aria-required={control.required}
        clearLabel={text.clear}
        disabled={control.disabled}
        id={control.id}
        placeholder={placeholder}
        showClear={!control.required}
        triggerLabel={text.showOptions}
      />
      <ComboboxContent>
        <ComboboxEmpty>
          {answer === undefined ? text.loading : text.noMatches}
        </ComboboxEmpty>
        <ComboboxList>
          {(record: unknown) => (
            <ComboboxItem key={idOf(record)} value={record}>
              {labelOf(record)}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
};

/** A relation's query that failed, in the picker's place, and a way to read it again. */
const RelationFailure = ({
  id,
  error,
  again,
  text,
}: {
  id: string;
  error: unknown;
  again: () => void;
  text: FieldText;
}): React.JSX.Element => {
  const retryFailed = useRetryFailed();
  return (
    <Alert id={id} live="assertive" variant="destructive">
      <AlertDescription>
        <p>{error instanceof Error ? error.message : text.failed}</p>
        <p>
          <Button
            onClick={() => {
              retryFailed();
              again();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {text.tryAgain}
          </Button>
        </p>
      </AlertDescription>
    </Alert>
  );
};

/**
 * A field of `form` that holds a record's ID (`v.id("table")`): a
 * searchable list of the records `query` answers for what the person
 * types (`args`), each named by `optionLabel`, and the record the field
 * holds read by its ID through a query of one record (`lookup`, optional:
 * without it a value the search doesn't list shows as its ID). A failed
 * query shows in its place.
 */
const RelationField = <
  Values,
  Reference extends AnyQuery,
  Lookup extends AnyQuery = AnyQuery,
>({
  form,
  name,
  label,
  description,
  text,
  ...picker
}: FieldProps<Values, ChoiceFieldName<Values>> &
  RelationProps<Reference, Lookup>): React.JSX.Element => {
  const said = { ...pageText(fieldTexts), ...text };
  return (
    <FieldShell
      description={description}
      form={form}
      label={label}
      name={name}
      render={(control) => (
        <QueryBoundary
          renderFailure={(error, again) => (
            <RelationFailure
              again={again}
              error={error}
              id={control.id}
              text={said}
            />
          )}
          reading={control.name}
        >
          <RelationPicker {...picker} control={control} text={said} />
        </QueryBoundary>
      )}
    />
  );
};

/** A file picked and uploaded here: what the field shows of it. */
interface UploadedFile {
  readonly id: string;
  readonly name: string;
}

/** The upload control of a file field of `form`, through `resource`. */
const FileUpload = <Reference extends FilesReference>({
  form,
  control,
  resource,
  accept,
  text,
}: {
  form: object;
  control: Control;
  resource: Declaring<Reference, "upload">;
  accept: string | undefined;
  text: FieldText;
}): React.JSX.Element => {
  const upload = useUpload(resource);
  const [uploaded, setUploaded] = useState<UploadedFile>();
  const [failure, setFailure] = useState<string>();
  const held =
    typeof control.value === "object" &&
    control.value !== null &&
    "id" in control.value &&
    typeof control.value.id === "string"
      ? control.value.id
      : undefined;
  const busy = upload.status === "uploading" || upload.status === "verifying";
  /** Cancels the upload, which then fails as cancelled and so ends. */
  const stopUpload = (): void => {
    const stop = async (): Promise<void> => {
      try {
        await upload.cancel();
      } catch {
        // Nothing to cancel any more: it ended on its own.
      }
    };
    void stop();
  };
  /** Uploads `file`, picked or dropped, and holds its reference. */
  const take = (file: File): void => {
    setFailure(undefined);
    // The form doesn't submit until the upload ends; discarding the
    // draft cancels it.
    const hold = bindingOf(form).startUpload(stopUpload);
    const send = async (): Promise<void> => {
      try {
        const ref = await upload.upload(file);
        // A draft discarded meanwhile: the file isn't the new one's.
        if (hold.current()) {
          setUploaded({ id: ref.id, name: file.name });
          control.handleChange(ref);
        }
      } catch (error) {
        // Cancelled by the person: nothing went wrong to say.
        const cancelled =
          error instanceof Error &&
          "code" in error &&
          error.code === "file.cancelled";
        if (!cancelled) {
          setFailure(error instanceof Error ? error.message : text.failed);
        }
      }
      const current = hold.current();
      hold.end();
      if (current) {
        control.handleBlur();
      }
    };
    void send();
  };
  if (held !== undefined) {
    return (
      <div className="flex items-center gap-2">
        <PaperclipIcon aria-hidden />
        <span className="truncate text-sm">
          {uploaded?.id === held ? uploaded.name : text.attached}
        </span>
        <Button
          disabled={control.disabled}
          onClick={() => {
            control.handleChange(control.empty);
            control.handleBlur();
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          {text.remove}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <Input
        accept={accept}
        aria-busy={busy}
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid || failure !== undefined}
        aria-required={control.required}
        disabled={control.disabled || busy}
        id={control.id}
        name={control.name}
        onChange={(event) => {
          const [file] = event.currentTarget.files ?? [];
          // Picking the same file again, after a failure, is a change too.
          event.currentTarget.value = "";
          if (file !== undefined) {
            take(file);
          }
        }}
        // A file dropped on the field is taken here: a page's frame
        // cancels the browser's own handling of every drop (core's
        // page-frame.ts), which is what would otherwise hand it over.
        onDrop={(event) => {
          event.preventDefault();
          const [file] = event.dataTransfer.files;
          if (file !== undefined && !(control.disabled || busy)) {
            take(file);
          }
        }}
        type="file"
      />
      {busy ? (
        <div className="flex items-center gap-2">
          <Progress
            aria-label={text.uploading}
            className="flex-1"
            value={
              upload.bytesTotal === 0
                ? null
                : (upload.bytesUploaded / upload.bytesTotal) * 100
            }
          />
          <Button
            onClick={() => {
              stopUpload();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {text.cancelUpload}
          </Button>
        </div>
      ) : null}
      {failure === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
};

/**
 * A field of `form` that holds a file's reference (`v.file()`): the file
 * the person picks is uploaded through `resource`, a files resource the
 * App declares with `upload`, and the field holds its reference. The form
 * doesn't submit while it uploads. Removing it only takes it off the field.
 */
const FileField = <Values, Reference extends FilesReference>({
  form,
  name,
  label,
  description,
  resource,
  accept,
  text,
}: FieldProps<Values, FileFieldName<Values>> & {
  resource: Declaring<Reference, "upload">;
  /** The kinds of file the picker offers, as an input's `accept`. */
  accept?: string;
  /** What it says, in the page's language. */
  text?: Partial<FieldText>;
}): React.JSX.Element => (
  <FieldShell
    description={description}
    form={form}
    label={label}
    name={name}
    render={(control) => (
      <FileUpload
        accept={accept}
        control={control}
        form={form}
        resource={resource}
        text={{ ...pageText(fieldTexts), ...text }}
      />
    )}
  />
);

const markIcons: Readonly<Record<Mark, React.ComponentType>> = {
  bold: BoldIcon,
  italic: ItalicIcon,
  bullets: ListIcon,
  numbers: ListOrderedIcon,
};

/**
 * A field of `form` that holds formatted text, as Markdown: bold, italic
 * and lists, which its toolbar puts around what is selected (a link the
 * person types in Markdown is kept). It
 * holds text alone, never HTML: show it with `RichText`
 * (`@grasp-os/ui/components/rich-text`), which renders the Markdown and
 * drops any HTML in it.
 */
const RichTextField = <Values,>({
  form,
  name,
  label,
  description,
  text,
  ...props
}: FieldProps<Values, TextFieldName<Values>> &
  ControlProps<"textarea"> & {
    /** What it says, in the page's language. */
    text?: Partial<FieldText>;
  }): React.JSX.Element => {
  const editor = useRef<HTMLTextAreaElement>(null);
  const said = { ...pageText(fieldTexts), ...text };
  return (
    <FieldShell
      description={description}
      form={form}
      label={label}
      name={name}
      render={(control) => (
        <div className="flex flex-col gap-2">
          <ButtonGroup aria-label={said.formatting}>
            {marks.map((mark) => {
              const Icon = markIcons[mark];
              return (
                <Button
                  aria-controls={control.id}
                  aria-label={said[mark]}
                  disabled={control.disabled}
                  key={mark}
                  onClick={() => {
                    const element = editor.current;
                    if (element === null) {
                      return;
                    }
                    const marked = applyMark(
                      element.value,
                      element.selectionStart,
                      element.selectionEnd,
                      mark
                    );
                    control.handleChange(marked.text);
                    requestAnimationFrame(() => {
                      element.focus();
                      element.setSelectionRange(marked.start, marked.end);
                    });
                  }}
                  size="icon-sm"
                  title={said[mark]}
                  type="button"
                  variant="outline"
                >
                  <Icon />
                </Button>
              );
            })}
          </ButtonGroup>
          <Textarea
            {...props}
            aria-describedby={control.describedBy}
            aria-invalid={control.invalid}
            aria-required={control.required}
            disabled={control.disabled || props.disabled}
            id={control.id}
            name={control.name}
            onBlur={control.handleBlur}
            onChange={(event) => {
              control.handleChange(event.target.value);
            }}
            ref={editor}
            value={textOf(control.value)}
          />
        </div>
      )}
    />
  );
};

/**
 * A submission whose outcome is unknown: what is known of it, and a way to
 * give it up that asks first, since whether it ran stays unknown.
 */
const UncertainSubmission = ({
  form,
  message,
  code,
  discardLabel,
  keepLabel,
  confirmDiscard,
  className,
}: {
  form: AnyForm;
  message: string;
  code: string;
  discardLabel: string;
  keepLabel: string;
  confirmDiscard: string;
  className?: string;
}): React.JSX.Element => {
  const [confirming, setConfirming] = useState(false);
  return (
    <Alert className={className} data-code={code} live="polite">
      <AlertDescription>
        <p>{message}</p>
        {confirming ? (
          <p className="flex flex-wrap items-center gap-2">
            <span>{confirmDiscard}</span>
            <Button
              onClick={() => {
                bindingOf(form).discard();
              }}
              size="sm"
              type="button"
              variant="destructive"
            >
              {discardLabel}
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {keepLabel}
            </Button>
          </p>
        ) : (
          <p>
            <Button
              onClick={() => {
                setConfirming(true);
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {discardLabel}
            </Button>
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
};

/**
 * What `form`'s last submission came to, when there is something to say:
 * why it failed or was refused (a stale save's `data.conflict` among them), that its outcome
 * is unknown (submitting sends it again; discarding it, once confirmed,
 * unlocks the fields), or that what came after a save failed. Each message is
 * the platform's or the App's own, safe to show.
 */
const FormError = ({
  form,
  savedButFailed = "Saved, but what should happen next failed:",
  discardLabel = "Discard",
  keepLabel = "Keep it",
  confirmDiscard = "Whether it went through stays unknown. Discard it and edit again?",
  className,
}: {
  form: AnyForm;
  /** What leads the message of a failed `onSuccess`. */
  savedButFailed?: string;
  /** The button that gives up a submission whose outcome is unknown. */
  discardLabel?: string;
  /** What asks the person to confirm giving it up. */
  confirmDiscard?: string;
  /** The button that keeps it, waiting to be sent again. */
  keepLabel?: string;
  className?: string;
}): React.JSX.Element | null => {
  const status = useFormStatus(form);
  if (status.failure !== undefined && status.phase === "uncertain") {
    return (
      <UncertainSubmission
        className={className}
        code={status.failure.code}
        confirmDiscard={confirmDiscard}
        discardLabel={discardLabel}
        form={form}
        keepLabel={keepLabel}
        message={status.failure.message}
      />
    );
  }
  if (status.failure !== undefined) {
    return (
      <Alert
        className={className}
        data-code={status.failure.code}
        live="assertive"
        variant="destructive"
      >
        <AlertDescription>{status.failure.message}</AlertDescription>
      </Alert>
    );
  }
  if (status.applicationError !== undefined) {
    return (
      <Alert className={className} variant="destructive">
        <AlertDescription>
          {savedButFailed} {status.applicationError}
        </AlertDescription>
      </Alert>
    );
  }
  return null;
};

/**
 * `form`'s submit button: it submits on its own click (and so on Enter in
 * a field), shows when a submission is in flight, and takes no second
 * click while one is.
 */
const SubmitButton = ({
  form,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "form" | "type" | "onClick"> & {
  form: AnyForm;
}): React.JSX.Element => {
  const status = useFormStatus(form);
  const busy = status.phase === "submitting" || status.uploading;
  return (
    <Button
      {...props}
      aria-busy={busy}
      disabled={busy || props.disabled}
      onClick={(event) => {
        event.preventDefault();
        void submitFrom(form, event.currentTarget.form);
      }}
      type="submit"
    >
      {busy ? <Spinner aria-hidden /> : null}
      {children}
    </Button>
  );
};

export {
  CheckboxField,
  DateField,
  DateTimeField,
  FileField,
  Form,
  FormError,
  MultiSelectField,
  NumberField,
  RelationField,
  RichTextField,
  SelectField,
  SubmitButton,
  SwitchField,
  TextareaField,
  TextField,
};
