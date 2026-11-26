import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Form } from "@grasp-os/ui/components/form";
import { Input } from "@grasp-os/ui/components/input";
import {
  InputGroup,
  InputGroupButton,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { Item } from "@grasp-os/ui/components/item";
import { Link } from "@grasp-os/ui/components/link";
import { SheetClose, SheetFooter } from "@grasp-os/ui/components/sheet";
import {
  Icon,
  ChevronLeftIcon,
  EyeIcon,
  EyeOffIcon,
} from "@grasp-os/ui/lib/icons";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
// The key step of Add connection: a back control, the chosen provider's tile as its head, then its
// address (an endpoint of your own), the key (masked, with show and hide, and Paste while it is
// empty), an optional name where the host keeps one (`nameField`) and the link to where its keys are made. Connected, the form gives way to
// one line that says so. The sheet's foot holds Cancel and Connect, or Done.
import * as stylex from "@stylexjs/stylex";
import type { ClipboardEvent } from "react";

import type { AddConnectionProvider, AddConnectionStatus } from "./model.ts";
import { ProviderMark, ProviderWords } from "./parts.tsx";
import type { AddConnectionWords } from "./words.ts";

/** What the key step's fields hold. */
export interface KeyStepValues {
  key: string;
  name: string;
  address: string;
}

const styles = stylex.create({
  step: {
    display: "grid",
    rowGap: space["5"],
    paddingBlockEnd: space["2"],
  },
  // The back control on the body's start edge, its words lined up with the tile's mark.
  back: {
    justifySelf: "start",
    marginInlineStart: `calc(-1 * ${space["2"]})`,
  },
  form: { display: "grid", rowGap: space["5"] },
  optional: { fontWeight: font.weightNormal, color: colors.mutedForeground },
  link: { justifySelf: "start" },
});

// Each password manager's own mark for a field it must leave alone: 1Password, LastPass,
// Bitwarden, Dashlane (as SecretInput).
const unmanaged = {
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-bwignore": "",
  "data-form-type": "other",
} as const;

/** The clipboard's words, or null where the browser will not give them. */
export const readClipboard = async (): Promise<string | null> => {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
};

/** The key with a paste put in place of the selection, the spaces and line breaks round it taken off. */
const pasted = (event: ClipboardEvent<HTMLInputElement>) => {
  const field = event.currentTarget;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  return (
    field.value.slice(0, start) +
    event.clipboardData.getData("text").trim() +
    field.value.slice(end)
  );
};

/** Every prop the key step takes: the provider, what the fields hold, and where it stands. */
export interface KeyStepProps {
  provider: AddConnectionProvider;
  /** The optional name under the key. */
  nameField: boolean;
  values: KeyStepValues;
  onValues: (values: KeyStepValues) => void;
  status: AddConnectionStatus;
  /** Under the key while refused. */
  refusal: string;
  revealed: boolean;
  onReveal: () => void;
  onPaste: () => void;
  onBack: () => void;
  onSubmit: () => void;
  /** The form's id, so Connect in the sheet's foot sends it. */
  formId: string;
  words: AddConnectionWords;
}

/** The address, the key, the name and the link out. */
const KeyFields = ({
  provider,
  nameField,
  values,
  onValues,
  status,
  refusal,
  revealed,
  onReveal,
  onPaste,
  words,
}: Omit<KeyStepProps, "onBack" | "onSubmit" | "formId">) => {
  const working = status === "working";
  return (
    <>
      {provider.address === true && (
        <Field name="address">
          <FieldLabel>{words.address}</FieldLabel>
          <Input
            type="url"
            inputMode="url"
            dir="ltr"
            required
            readOnly={working}
            placeholder={words.addressPlaceholder}
            value={values.address}
            data-first=""
            onValueChange={(address: string) => {
              onValues({ ...values, address });
            }}
          />
          <FieldError match="valueMissing">{words.addressMissing}</FieldError>
          <FieldError match="typeMismatch">{words.addressWrong}</FieldError>
        </Field>
      )}
      {/* Invalid only when refused: left out, not false, so the browser's own check still says a missing key. */}
      <Field
        name="key"
        {...(status === "refused" ? { "data-invalid": true } : {})}
      >
        <FieldLabel>{words.key}</FieldLabel>
        <InputGroup>
          <InputGroupInput
            {...unmanaged}
            type={revealed ? "text" : "password"}
            dir="ltr"
            required
            readOnly={working}
            autoComplete="off"
            spellCheck={false}
            placeholder={provider.keyHint}
            value={values.key}
            data-agent-secret=""
            data-first={provider.address === true ? undefined : ""}
            onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
              event.preventDefault();
              onValues({ ...values, key: pasted(event) });
            }}
            onValueChange={(key: string) => {
              onValues({ ...values, key });
            }}
          />
          {values.key === "" && !working && (
            <InputGroupButton onClick={onPaste}>{words.paste}</InputGroupButton>
          )}
          <InputGroupButton
            aria-label={revealed ? words.hideKey : words.showKey}
            aria-pressed={revealed}
            onClick={onReveal}
          >
            <Icon icon={revealed ? EyeOffIcon : EyeIcon} />
          </InputGroupButton>
        </InputGroup>
        <FieldError match="valueMissing">{words.keyMissing}</FieldError>
        {status === "refused" && <FieldError match>{refusal}</FieldError>}
      </Field>
      {nameField && (
        <Field name="name">
          <FieldLabel>
            {words.name}{" "}
            <span {...stylex.props(styles.optional)}>{words.nameOptional}</span>
          </FieldLabel>
          <Input
            autoComplete="off"
            readOnly={working}
            value={values.name}
            onValueChange={(name: string) => {
              onValues({ ...values, name });
            }}
          />
          <FieldDescription>{words.nameNote}</FieldDescription>
        </Field>
      )}
      {provider.keyUrl !== undefined && provider.keyUrl !== "" && (
        <Link
          href={provider.keyUrl}
          external
          variant="plain"
          target="_blank"
          rel="noreferrer"
          style={styles.link}
        >
          {words.getKey(provider.name)}
        </Link>
      )}
    </>
  );
};

/** The key step: back, the provider's tile, and its fields, or the line that says it connected. */
export const KeyStep = ({
  provider,
  onBack,
  onSubmit,
  formId,
  words,
  ...fields
}: KeyStepProps) => (
  <div data-slot="add-connection-step" {...stylex.props(styles.step)}>
    <Button
      variant="ghost"
      size="xs"
      disabled={fields.status === "working"}
      onClick={onBack}
      style={styles.back}
    >
      <Icon icon={ChevronLeftIcon} />
      {words.back}
    </Button>
    <Item variant="outline" size="sm">
      <ProviderMark provider={provider} />
      <ProviderWords provider={provider} />
    </Item>
    {fields.status === "done" ? (
      <Alert variant="success">
        <AlertTitle>{words.connectedTitle(provider.name)}</AlertTitle>
        <AlertDescription>{words.connectedDetail}</AlertDescription>
      </Alert>
    ) : (
      <Form
        id={formId}
        aria-label={words.stepName(provider.name)}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div {...stylex.props(styles.form)}>
          <KeyFields provider={provider} words={words} {...fields} />
        </div>
      </Form>
    )}
  </div>
);

/** The sheet's foot on the key step: Cancel and Connect, or Done once connected. */
export const StepFoot = ({
  status,
  formId,
  words,
}: {
  status: AddConnectionStatus;
  formId: string;
  words: AddConnectionWords;
}) => (
  <SheetFooter>
    {status === "done" ? (
      <SheetClose data-done="" variant="default">
        {words.done}
      </SheetClose>
    ) : (
      <>
        <SheetClose disabled={status === "working"}>{words.cancel}</SheetClose>
        <Button
          errorText={words.connect}
          form={formId}
          loadingText={words.connecting}
          status={status === "working" ? "loading" : "idle"}
          type="submit"
        >
          {words.connect}
        </Button>
      </>
    )}
  </SheetFooter>
);
