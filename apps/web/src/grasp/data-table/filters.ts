// The Filter builder's fields, from the columns that can be filtered, and whether a value meets
// the condition it holds.
import type { FilterCondition, FilterField } from "../filter-builder";
import type { DataTableColumn } from "./types";
import type { DataTableFilterWords } from "./words";

export type { DataTableFilterWords } from "./words";
export { englishFilterWords } from "./words";

const fieldFor = <Row>(
  column: DataTableColumn<Row>,
  words: DataTableFilterWords
): FilterField => {
  const kind = column.filter ?? "text";
  if (kind === "number") {
    return {
      id: column.key,
      label: column.header,
      operators: [
        { id: "at-least", label: words.atLeast },
        { id: "at-most", label: words.atMost },
        { id: "is", label: words.is },
      ],
      defaultOperatorId: "at-least",
      value: { type: "number" },
    };
  }
  if (typeof kind === "object") {
    return {
      id: column.key,
      label: column.header,
      operators: [
        { id: "is", label: words.is },
        { id: "is-not", label: words.isNot },
      ],
      defaultOperatorId: "is",
      value: {
        type: "select",
        options: kind.options.map((option) => ({ id: option, label: option })),
      },
    };
  }
  return {
    id: column.key,
    label: column.header,
    operators: [
      { id: "contains", label: words.contains },
      { id: "lacks", label: words.lacks },
    ],
    defaultOperatorId: "contains",
    value: { type: "text" },
  };
};

export const fieldsFor = <Row>(
  columns: readonly DataTableColumn<Row>[],
  words: DataTableFilterWords
): FilterField[] =>
  columns
    .filter((column) => column.filter !== false)
    .map((column) => fieldFor(column, words));

/** The condition says something: a field and a value are chosen. */
export const isSet = (condition: FilterCondition) =>
  condition.fieldId !== null &&
  condition.value !== null &&
  condition.value !== "";

const asText = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

/** Whether a value meets the condition the Filter builder holds. */
export const passes = (value: unknown, condition: FilterCondition) => {
  const wanted = condition.value;
  if (wanted === null || wanted === "") {
    return true;
  }
  const words = String(wanted).toLowerCase();
  const { operatorId } = condition;
  if (operatorId === "at-least") {
    return Number(value) >= Number(wanted);
  }
  if (operatorId === "at-most") {
    return Number(value) <= Number(wanted);
  }
  if (operatorId === "is") {
    return asText(value) === String(wanted);
  }
  if (operatorId === "is-not") {
    return asText(value) !== String(wanted);
  }
  const holds = asText(value).toLowerCase().includes(words);
  return operatorId === "lacks" ? !holds : holds;
};
