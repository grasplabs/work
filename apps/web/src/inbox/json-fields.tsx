import type { Json } from "@grasp-os/shared/json";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import { Text } from "@grasp-os/ui/components/text";
import { useLingui } from "@lingui/react/macro";

import { formatList } from "../format.ts";

// What a decision is about, as its run passed it, read as labelled fields
// rather than as JSON: an object's fields one by one, each named in words,
// anything else as one line.

const camelBreak = /(?<before>[a-z0-9])(?<after>[A-Z])/gu;
const separators = /[_-]+/gu;

/** A field's name in words: "invoiceNumber", "invoice_number" and "invoice-number" read "Invoice number". */
export const fieldLabel = (key: string): string => {
  const words = key
    .replaceAll(camelBreak, "$<before> $<after>")
    .replaceAll(separators, " ")
    .trim()
    .split(" ")
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
        id: key,
        label: fieldLabel(key),
        value: text(each),
      }))}
    />
  );
};
