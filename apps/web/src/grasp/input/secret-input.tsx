// SecretInput: a key, a token, a secret someone pastes once: Input as a password, its words never
// shown, never offered to a password manager (autocomplete off and each manager's own ignore mark),
// never read back by an agent, and pasted whole, the spaces and line breaks round it taken off. Once
// it is saved the field never holds it again: it shows only its last four, read only, with Replace,
// which empties it and puts the caret in it, as Stripe, Linear and Zed keep a key.
//
//   <Field>
//     <FieldLabel>Key</FieldLabel>
//     <SecretInput placeholder="sk-ant-…" required />
//     <FieldDescription>Only its last four characters are shown again.</FieldDescription>
//   </Field>
//
//   <SecretInput saved="9c1e" onReplace={() => setReplacing(true)} />     once it is saved
"use client";

import type { ClipboardEvent } from "react";

import { InputGroup, InputGroupButton, InputGroupInput } from "../input-group";
import { useWords, withGiven } from "../words/words";
import { Input } from "./input";
import type { InputProps } from "./input";
import { inputWords } from "./words";

/** Every prop a SecretInput takes: an Input's, but never its type or its secret. */
export type SecretInputProps = Omit<
  InputProps,
  "type" | "secret" | "autoComplete"
> & {
  /**
   * The last characters of the key already saved ("9c1e"): the field then shows only them, read
   * only, with Replace. Never the key itself; the host keeps that.
   */
  saved?: string;
  /** Runs when Replace is pressed: the host clears `saved`, and the field is empty and focused. */
  onReplace?: () => void;
  /** The Replace button's words. @default "Replace" */
  replaceLabel?: string;
};

// Each password manager's own mark for a field it must leave alone: 1Password, LastPass,
// Bitwarden, Dashlane.
const unmanaged = {
  "data-1p-ignore": "",
  "data-lpignore": "true",
  "data-bwignore": "",
  "data-form-type": "other",
} as const;

/** Pastes the clipboard's words whole, the spaces and line breaks round them taken off. */
const pasteTrimmed = (event: ClipboardEvent<HTMLInputElement>) => {
  const words = event.clipboardData.getData("text");
  const trimmed = words.trim();
  if (trimmed === words) {
    return;
  }
  event.preventDefault();
  const field = event.currentTarget;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  field.setRangeText(trimmed, start, end, "end");
  // Told as typing is, so the form and the host's state hear it.
  field.dispatchEvent(new Event("input", { bubbles: true }));
};

/** A secret pasted once: masked, never captured, never shown again but for its last four. */
export const SecretInput = ({
  saved,
  onReplace,
  replaceLabel,
  ...rest
}: SecretInputProps) => {
  const { replace } = withGiven(useWords("input", inputWords), {
    replace: replaceLabel,
  });
  if (saved !== undefined && saved !== "") {
    return (
      <InputGroup layout={rest.layout}>
        <InputGroupInput
          readOnly
          dir="ltr"
          value={`…${saved}`}
          aria-label={rest["aria-label"]}
        />
        <InputGroupButton onClick={onReplace}>{replace}</InputGroupButton>
      </InputGroup>
    );
  }
  // A key reads left to right in every language: the field does too, in a right-to-left page.
  return (
    <Input
      {...rest}
      {...unmanaged}
      dir="ltr"
      type="password"
      secret
      autoComplete="off"
      spellCheck={false}
      onPaste={pasteTrimmed}
    />
  );
};
