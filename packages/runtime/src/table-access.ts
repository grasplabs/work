import { refuse } from "./schema-error.ts";
import { indexBase } from "./schema-fields.ts";
import type { TableState } from "./schema-types.ts";
import { isPlainObject } from "./value-descriptor.ts";

/**
 * A role in an App a row rule may name: `builder`, or `user`, which
 * everyone with a role in the App holds: its builders too, and whoever
 * calls the public operations of a store it serves (another App's or a
 * workflow's people, who are its members for those operations).
 */
export type RowRole = "builder" | "user";

/**
 * Who a row of a table reaches, for reading or for writing, as one rule:
 *
 * - `owner`: the person who inserted it (`_ownerId`);
 * - `person`: the person its `v.person()` field `field` names;
 * - `team`: a member of the team whose ID its text field `field` holds;
 * - `role`: whoever holds App role `role`, whatever the row holds.
 *
 * A row reaches whoever any of a table's rules admits.
 */
export type RowRule<Field extends string = string> =
  | { readonly kind: "owner" }
  | { readonly kind: "person"; readonly field: Field }
  | { readonly kind: "team"; readonly field: Field }
  | { readonly kind: "role"; readonly role: RowRole };

/** At least one rule, as a table's `.access` takes them. */
type RowRuleList<Field extends string = string> = readonly [
  RowRule<Field>,
  ...RowRule<Field>[],
];

/** A table's row rules: for reading, writing, or both. */
export interface RowRules<Field extends string = string> {
  readonly read?: RowRuleList<Field>;
  readonly write?: RowRuleList<Field>;
}

/**
 * Who a table's records reach, for reading or for writing: only their
 * owner, the App's members, its builders, or nobody.
 */
export type AccessMode = "owner" | "appMembers" | "appBuilders" | "none";

const accessModes: ReadonlySet<unknown> = new Set<AccessMode>([
  "owner",
  "appMembers",
  "appBuilders",
  "none",
]);

/**
 * A table's access, as `.access` takes it: a mode for reading and one for
 * writing (a mode left out is `none`), and the row rules that narrow them.
 */
export interface TableAccess<Field extends string = string> {
  readonly read?: AccessMode;
  readonly write?: AccessMode;
  readonly rows?: RowRules<Field>;
}

/** A table's access modes, both explicit. */
export interface AccessModes {
  readonly read: AccessMode;
  readonly write: AccessMode;
}

/** The most rules one direction of a table holds. */
const rowRuleMax = 8;

/**
 * The rules a table's `.access` takes:
 *
 * ```ts
 * defineTable({ title: v.string(), assignee: v.person(), team: v.string() })
 *   .access({
 *     read: [rows.owner(), rows.person("assignee"), rows.team("team"), rows.role("builder")],
 *     write: [rows.owner(), rows.person("assignee"), rows.role("builder")],
 *   });
 * ```
 */
export const rows = Object.freeze({
  /** The person who inserted the row. */
  owner: (): RowRule<never> => Object.freeze({ kind: "owner" as const }),
  /** The person the row's `v.person()` field `field` names. */
  person: <const Field extends string>(field: Field): RowRule<Field> =>
    Object.freeze({ kind: "person" as const, field }),
  /** A member of the team whose ID the row's text field `field` holds. */
  team: <const Field extends string>(field: Field): RowRule<Field> =>
    Object.freeze({ kind: "team" as const, field }),
  /** Whoever holds App role `role`: `builder`, or `user` for everyone. */
  role: (role: RowRole): RowRule<never> =>
    Object.freeze({ kind: "role" as const, role }),
});

const roleNames: ReadonlySet<unknown> = new Set<RowRole>(["builder", "user"]);

const isRowRole = (value: unknown): value is RowRole => roleNames.has(value);

const refuseRule = (message: string): never =>
  refuse("schema.invalid_rules", message);

/** A person or team rule's field, checked against its table. */
const checkedRuleField = (
  state: TableState,
  kind: "person" | "team",
  field: unknown
): string => {
  const descriptor =
    typeof field === "string" && Object.hasOwn(state.fields, field)
      ? state.fields[field]
      : undefined;
  if (typeof field !== "string" || descriptor === undefined) {
    return refuseRule(`A ${kind} rule names a field of its table.`);
  }
  if (kind === "person" && descriptor.kind !== "person") {
    return refuseRule(
      `A person rule names a \`v.person()\` field; \`${field}\` isn't one.`
    );
  }
  if (
    kind === "team" &&
    (descriptor.kind === "person" || indexBase(descriptor) !== "string")
  ) {
    return refuseRule(
      `A team rule names a text field holding a team's ID; \`${field}\` isn't one.`
    );
  }
  return field;
};

/** One row rule of unknown origin, checked against its table. */
const checkedRule = (state: TableState, rule: unknown): RowRule => {
  if (!isPlainObject(rule)) {
    return refuseRule("A row rule is one `rows` made.");
  }
  const keys = Object.keys(rule).toSorted().join(",");
  const { kind } = rule;
  if (kind === "owner" && keys === "kind") {
    return Object.freeze({ kind });
  }
  if (kind === "role" && keys === "kind,role") {
    const { role } = rule;
    if (!isRowRole(role)) {
      return refuseRule("A role rule names `builder` or `user`.");
    }
    return Object.freeze({ kind, role });
  }
  if ((kind === "person" || kind === "team") && keys === "field,kind") {
    return Object.freeze({
      kind,
      field: checkedRuleField(state, kind, rule.field),
    });
  }
  return refuseRule(
    "A row rule is `rows.owner()`, `rows.person(field)`, `rows.team(field)` or `rows.role(role)`."
  );
};

/** One direction's rules, checked: at least one, none twice. */
const checkedRuleList = (
  state: TableState,
  list: unknown
): RowRuleList | undefined => {
  if (list === undefined) {
    return undefined;
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > rowRuleMax) {
    return refuseRule(
      `Each direction of a table's rules lists between 1 and ${rowRuleMax} rules.`
    );
  }
  const seen = new Set<string>();
  const checked = list.map((rule: unknown) => {
    const one = checkedRule(state, rule);
    const key = JSON.stringify(one);
    if (seen.has(key)) {
      refuseRule("A table's rules name one rule twice.");
    }
    seen.add(key);
    return one;
  });
  const [first, ...others] = checked;
  if (first === undefined) {
    throw new Error("A checked rule list is empty");
  }
  return Object.freeze([first, ...others]);
};

/** A table's row rules of unknown origin, checked against it. */
const checkedRules = (state: TableState, rules: unknown): RowRules => {
  const known =
    isPlainObject(rules) &&
    Object.keys(rules).length > 0 &&
    Object.keys(rules).every((key) => key === "read" || key === "write");
  if (!known) {
    return refuseRule(
      "A table's rules are `{ read?, write? }`, at least one of them."
    );
  }
  const read = checkedRuleList(
    state,
    Object.hasOwn(rules, "read") ? rules.read : undefined
  );
  const write = checkedRuleList(
    state,
    Object.hasOwn(rules, "write") ? rules.write : undefined
  );
  return Object.freeze({
    ...(read === undefined ? {} : { read }),
    ...(write === undefined ? {} : { write }),
  });
};

/** A mode of unknown origin, checked: one left out is `none`. */
const checkedMode = (mode: unknown): AccessMode => {
  if (mode === undefined) {
    return "none";
  }
  if (!accessModes.has(mode)) {
    return refuse(
      "schema.invalid_access",
      "A table's `read` and `write` are each `owner`, `appMembers`, `appBuilders` or `none`."
    );
  }
  // SAFETY: one of the modes, checked just above.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return mode as AccessMode;
};

/**
 * A table's access of unknown origin, checked against it. Row rules choose
 * rows among those a mode lets someone reach, so a direction with rules
 * has a mode that reaches every row (`appMembers` or `appBuilders`):
 * `owner` already narrows to one person's rows (`rows.owner()` says it
 * among the rules), and `none` reaches no row.
 */
export const checkedAccess = (
  state: TableState,
  access: unknown
): { access: AccessModes; rules?: RowRules } => {
  if (
    !isPlainObject(access) ||
    !Object.keys(access).every((key) => ["read", "write", "rows"].includes(key))
  ) {
    return refuse(
      "schema.invalid_access",
      "A table's access is `{ read?, write?, rows? }`."
    );
  }
  const modes: AccessModes = Object.freeze({
    read: checkedMode(access.read),
    write: checkedMode(access.write),
  });
  if (access.rows === undefined) {
    return { access: modes };
  }
  const rules = checkedRules(state, access.rows);
  for (const direction of ["read", "write"] as const) {
    const mode = modes[direction];
    if (
      rules[direction] !== undefined &&
      (mode === "owner" || mode === "none")
    ) {
      refuseRule(
        `A table with row rules for ${direction === "read" ? "reading" : "writing"} has \`${direction}\` access \`appMembers\` or \`appBuilders\`: the rules choose among the rows it reaches (\`rows.owner()\` among the rules says \`owner\`).`
      );
    }
  }
  return { access: modes, rules };
};
