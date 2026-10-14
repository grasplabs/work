import { bindingOf } from "@grasp-os/sdk/form-binding";
import type { FormStatus, GraspForm, TextFieldName } from "@grasp-os/sdk/react";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { cn } from "@grasp-os/ui/lib/utils";
import { useId, useState, useSyncExternalStore } from "react";
import type * as React from "react";

// The fields and parts of a form the SDK's `useForm` made (spec 10.2.2):
// one semantic form, text fields with their label, description and error,
// the form's own error, and the submit button. They own what every form
// would otherwise write again: error IDs and `aria-invalid`, showing an
// error only once a field was left or a submit tried, the lock while a
// submission is in flight, focus on the first invalid field, and the
// submission itself.
//
// An App's screen runs in a frame sandboxed without forms, where the
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

/** What a text field shows of its error: the field's own check, or the server's. */
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

/** What a text field's control gets from the field around it. */
interface Control {
  id: string;
  name: string;
  value: string;
  disabled: boolean;
  invalid: boolean;
  describedBy: string | undefined;
  handleChange: (value: string) => void;
  handleBlur: () => void;
}

/** What every text field takes. */
interface TextFieldProps<Values> {
  /** The form the field belongs to, passed so its name is typed. */
  form: GraspForm<Values, unknown>;
  /** The field: one of the form's text values. */
  name: TextFieldName<Values>;
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

/** A text field's label, description and error around its control. */
const TextFieldShell = <Values,>({
  form,
  name,
  label,
  description,
  render,
}: TextFieldProps<Values> & {
  render: (props: Control) => React.JSX.Element;
}): React.JSX.Element => {
  const status = useFormStatus(form);
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const locked = status.phase === "submitting" || status.phase === "uncertain";
  return (
    // SAFETY: a text field's name is one of the form's keys (TextFieldName).
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    <form.Field name={name as never}>
      {(field) => {
        const error = errorOf(field.state.meta, status, name);
        const describedBy = describedByOf({
          [descriptionId]: description !== undefined,
          [errorId]: error !== undefined,
        });
        const { value } = field.state;
        return (
          <Field data-invalid={error !== undefined}>
            <FieldLabel htmlFor={id}>{label}</FieldLabel>
            {render({
              id,
              name,
              value: typeof value === "string" ? value : "",
              disabled: locked,
              invalid: error !== undefined,
              describedBy,
              handleChange: (next) => {
                // SAFETY: a text field's value is text (TextFieldName).
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
                field.handleChange(next as never);
              },
              handleBlur: field.handleBlur,
            })}
            {description === undefined ? null : (
              <FieldDescription id={descriptionId}>
                {description}
              </FieldDescription>
            )}
            <FieldError id={errorId}>{error}</FieldError>
          </Field>
        );
      }}
    </form.Field>
  );
};

/** What a text field passes to its control, of the props it was given. */
type ControlProps<Element extends "input" | "textarea"> = Omit<
  React.ComponentProps<Element>,
  "form" | "name" | "value" | "defaultValue" | "onChange" | "onBlur" | "id"
>;

/** A one-line text field of `form`, with its label, description and error. */
const TextField = <Values,>({
  form,
  name,
  label,
  description,
  ...props
}: TextFieldProps<Values> & ControlProps<"input">): React.JSX.Element => (
  <TextFieldShell
    render={(control) => (
      <Input
        {...props}
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid}
        disabled={control.disabled || props.disabled}
        id={control.id}
        name={control.name}
        onBlur={control.handleBlur}
        onChange={(event) => {
          control.handleChange(event.target.value);
        }}
        value={control.value}
      />
    )}
    description={description}
    form={form}
    label={label}
    name={name}
  />
);

/** A multi-line text field of `form`, with its label, description and error. */
const TextareaField = <Values,>({
  form,
  name,
  label,
  description,
  ...props
}: TextFieldProps<Values> & ControlProps<"textarea">): React.JSX.Element => (
  <TextFieldShell
    render={(control) => (
      <Textarea
        {...props}
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid}
        disabled={control.disabled || props.disabled}
        id={control.id}
        name={control.name}
        onBlur={control.handleBlur}
        onChange={(event) => {
          control.handleChange(event.target.value);
        }}
        value={control.value}
      />
    )}
    description={description}
    form={form}
    label={label}
    name={name}
  />
);

/**
 * What `form`'s last submission came to, when there is something to say:
 * why it failed or was refused (a conflict among them), that its outcome
 * is unknown (submitting sends it again; discarding it, once confirmed,
 * unlocks the fields), that a save committed and waits
 * for its record, or that what came after a save failed. Each message is
 * the platform's or the App's own, safe to show.
 */
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

const FormError = ({
  form,
  syncing = "Saved. Waiting for the saved version to arrive.",
  savedButFailed = "Saved, but what should happen next failed:",
  discardLabel = "Discard",
  keepLabel = "Keep it",
  confirmDiscard = "Whether it went through stays unknown. Discard it and edit again?",
  className,
}: {
  form: AnyForm;
  /** What shows while a save waits for its record. */
  syncing?: string;
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
  if (status.phase === "syncing") {
    return (
      <Alert className={className} live="polite">
        <AlertDescription>{syncing}</AlertDescription>
      </Alert>
    );
  }
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
  const busy = status.phase === "submitting";
  return (
    <Button
      {...props}
      aria-busy={busy}
      disabled={busy || status.phase === "syncing" || props.disabled}
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

export { Form, FormError, SubmitButton, TextareaField, TextField };
