import {
  filterMaxDepth,
  filterMaxInValues,
  filterMaxNodes,
} from "@grasp-os/shared/store-limits";
import { filterChildren } from "@grasp-os/shared/store-reads";
import type { FilterNode, QueryScalar } from "@grasp-os/shared/store-reads";

import { refuse } from "./query-error.ts";
import { baseOf, fits, isPlainRecord, nullableField } from "./query-values.ts";
import type { IndexBase } from "./schema-fields.ts";
import type { TableState } from "./schema-types.ts";

const comparisonOps = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;

/** One condition of `field.op`, checked against the field's type. */
const conditionNode = (
  table: TableState,
  field: string,
  base: IndexBase,
  op: string,
  operand: unknown
): FilterNode => {
  const nullable = nullableField(table, field);
  if (op === "exists") {
    if (typeof operand !== "boolean") {
      return refuse(
        "query.invalid_filter",
        `\`${field}.exists\` is a boolean.`
      );
    }
    return { field, op, value: operand };
  }
  if (op === "in") {
    if (
      !Array.isArray(operand) ||
      operand.length > filterMaxInValues ||
      !operand.every((item) => fits(item, base, nullable))
    ) {
      return refuse(
        "query.invalid_filter",
        `\`${field}.in\` lists at most ${filterMaxInValues} values, each a ${base}${nullable ? " or null" : ""}.`
      );
    }
    const values: readonly unknown[] = operand;
    return {
      field,
      op,
      // A copy, so the caller's array can't change the descriptor later.
      // SAFETY: each item was checked to be a scalar of the field's type.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      values: values.map((item) => item as QueryScalar),
    };
  }
  const compared = comparisonOps.find((known) => known === op);
  if (compared === undefined) {
    return refuse(
      "query.invalid_filter",
      `\`${field}\` takes \`eq\`, \`neq\`, \`gt\`, \`gte\`, \`lt\`, \`lte\`, \`in\` or \`exists\`.`
    );
  }
  const allowNull = (compared === "eq" || compared === "neq") && nullable;
  if (!fits(operand, base, allowNull)) {
    return refuse(
      "query.invalid_filter",
      allowNull
        ? `\`${field}.${op}\` is a ${base} or null.`
        : `\`${field}.${op}\` is a ${base}, never null.`
    );
  }
  // SAFETY: `fits` checked it is a scalar of the field's type (or null).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return { field, op: compared, value: operand as QueryScalar };
};

/** The conditions a filter object states of `field`: at least one. */
const fieldNodes = (
  table: TableState,
  field: string,
  value: unknown
): FilterNode[] => {
  const base = baseOf(table, field);
  if (base === undefined) {
    return refuse(
      "query.invalid_filter",
      `A filter names scalar fields of the table: \`${field}\` isn't one.`
    );
  }
  if (!isPlainRecord(value)) {
    return [conditionNode(table, field, base, "eq", value)];
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return refuse(
      "query.invalid_filter",
      `\`${field}\` states no condition: leave it out instead.`
    );
  }
  return entries.map(([op, operand]) => {
    if (operand === undefined) {
      return refuse(
        "query.invalid_filter",
        `\`${field}.${op}\` is undefined: leave it out instead.`
      );
    }
    return conditionNode(table, field, base, op, operand);
  });
};

/** The nodes a query's filters may still add, counted as they are built. */
export interface NodeBudget {
  nodes: number;
}

/** Counts `count` more nodes against `budget`, refusing past the bound. */
const spend = (budget: NodeBudget, count: number): void => {
  budget.nodes += count;
  if (budget.nodes > filterMaxNodes) {
    refuse(
      "query.invalid_filter",
      `A query's filters hold at most ${filterMaxNodes} nodes, all together.`
    );
  }
};

/**
 * An author's filter object, as the tree a descriptor holds: every node
 * counted against `budget` as it is built, and a list's length before any
 * of its members, so no filter is built past the bound.
 */
export const filterTree = (
  table: TableState,
  filter: unknown,
  depth: number,
  budget: NodeBudget
): FilterNode => {
  if (depth > filterMaxDepth) {
    return refuse(
      "query.invalid_filter",
      `A filter nests at most ${filterMaxDepth} deep.`
    );
  }
  if (!isPlainRecord(filter) || Object.keys(filter).length === 0) {
    return refuse(
      "query.invalid_filter",
      "A filter is an object of at least one field, `AND`, `OR` or `NOT`."
    );
  }
  const nodes: FilterNode[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) {
      return refuse(
        "query.invalid_filter",
        `\`${key}\` is undefined: leave it out instead.`
      );
    }
    if (key === "AND" || key === "OR") {
      if (!Array.isArray(value) || value.length === 0) {
        return refuse(
          "query.invalid_filter",
          `\`${key}\` is a list of at least one filter.`
        );
      }
      // Counted before any member is built: a list too long fails at once.
      if (budget.nodes + 1 + value.length > filterMaxNodes) {
        spend(budget, 1 + value.length);
      }
      spend(budget, 1);
      const children = value.map((child) =>
        filterTree(table, child, depth + 1, budget)
      );
      nodes.push(key === "AND" ? { and: children } : { or: children });
    } else if (key === "NOT") {
      spend(budget, 1);
      nodes.push({ not: filterTree(table, value, depth + 1, budget) });
    } else {
      const conditions = fieldNodes(table, key, value);
      spend(budget, conditions.length);
      nodes.push(...conditions);
    }
  }
  const [only, ...others] = nodes;
  if (only !== undefined && others.length === 0) {
    return only;
  }
  spend(budget, 1);
  return { and: nodes };
};

/** How many nodes `filters` hold, all told, counted without recursion. */
export const nodeCount = (filters: readonly FilterNode[]): number => {
  let count = 0;
  const stack = [...filters];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    count += 1;
    stack.push(...filterChildren(node));
  }
  return count;
};

/** A query's filters as one tree, or null for none. */
export const filterOf = (filters: readonly FilterNode[]): FilterNode | null => {
  const [only, ...others] = filters;
  if (only === undefined) {
    return null;
  }
  return others.length === 0 ? only : { and: [...filters] };
};
