import type { Json } from "@grasp-os/shared/json";
import { useLingui } from "@lingui/react/macro";

import { formatList } from "./format.ts";
import { KeyValueList } from "./grasp/key-value/index.ts";
import { Text } from "./grasp/text/index.ts";

// What a workflow passed (a decision's "About", a held start's input) as
// labelled fields rather than JSON: each field by its name in words
// ("invoiceNumber" reads "Invoice number"), its value as text. A list of
// plain values reads as a list; anything deeper as its fields, one level
// in. The names are the workflow's own, so they stay untranslated.

const camelBreak = /(?<before>[a-z0-9])(?<after>[A-Z])/gu;
const separators = /[_-]+/gu;

/** A field's name in words: "invoiceNumber", "invoice_number" and "invoice-number" read "Invoice number". */
export const fieldLabel = (key: string): string => {
  const words = key
    .replaceAll(camelBreak, "$<before> $<after>")
    .replaceAll(separators, " ")
    .trim()
    .split(" ")
    // An acronym ("IBAN", "VAT") keeps its capitals.
    .map((word) => (word === word.toUpperCase() ? word : word.toLowerCase()))
    .join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

type Fields = Readonly<Record<string, Json | undefined>>;

const isObject = (value: Json): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An object's fields that hold a value. */
const fieldsOf = (value: Fields): [string, Json][] =>
  Object.entries(value).flatMap(([key, each]) =>
    each === undefined ? [] : [[key, each]]
  );

/** A value as text: yes or no, a number, words, a list of plain values. */
const useValueText = () => {
  const { t } = useLingui();
  const text = (value: Json): string => {
    if (value === null) {
      return "–";
    }
    if (typeof value === "string") {
      return value;
    }
    // Exactly as passed: an amount, a rate or a year someone approves
    // is never rounded or grouped.
    if (typeof value === "number") {
      return String(value);
    }
    if (typeof value === "boolean") {
      return value ? t`Yes` : t`No`;
    }
    if (isObject(value)) {
      return fieldsOf(value)
        .map(([key, each]) => `${fieldLabel(key)}: ${text(each)}`)
        .join("; ");
    }
    return formatList(value.map(text));
  };
  return text;
};

/** `value` as labelled fields: an object's fields one by one, anything else as one line. */
export const JsonFields = ({ value }: { value: Json }) => {
  const text = useValueText();
  const fields = isObject(value) ? fieldsOf(value) : [];
  if (fields.length === 0) {
    return <Text size="sm">{isObject(value) ? "–" : text(value)}</Text>;
  }
  return (
    <KeyValueList
      items={fields.map(([key, each]) => ({
        // By the field's own name: two can read the same in words.
        id: key,
        key: fieldLabel(key),
        value: text(each),
      }))}
    />
  );
};
