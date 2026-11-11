import type { ManifestTable, RowRule, RowRules } from "@grasp-os/runtime/host";
import { canonicalJson } from "@grasp-os/shared/json";
import type { StoreFields } from "@grasp-os/shared/stores";

import { textExpression } from "./store-expressions.ts";
import type { Fragment } from "./store-expressions.ts";

// A table's row rules (`defineTable(...).access`, runtime/src/define-table.ts) as the
// SQL a business store runs them as (store-queries.ts for reads,
// store-host.ts for writes). One function turns a direction's rules and
// the caller into one condition on a record's document and owner, so a
// read, a related record, a search, a group, a write and a reference are
// all decided by the same text.
//
// Threat model (who declares the rules: an App's builders, or the AI on
// their behalf, in the schema its sealed release pins; who is the caller:
// core, from its own records for the invocation, never App code):
//
// - App code names a caller, a team or a role it doesn't have: every input
//   here is core's (`ReadScope`, the commit's `principal` and `roles`, read
//   for each invocation from core's own D1, the teams with them), and the
//   rules come from the store's own record of the pinned schema, never
//   from a request.
// - A visitor (someone outside the organization an App was shared with)
//   matches a person or team rule: they hold no App role and are in no
//   team, and a person or team rule is only ever a condition for a member
//   (`appMember` or `appBuilder`), so a visitor's session ID written into a
//   person field reaches nothing. Visitors reach a ruled row only through
//   `owner`. (A table with rules is `appMembers` or `appBuilders`
//   besides, which admits no visitor in the first place.)
// - A field's value is not what the rule expects (a number, an object,
//   null, left out): only text compares, as `textExpression` reads it,
//   and SQL NULL is folded to false term by term (`IFNULL`), so no
//   comparison reaches a row through NULL and the condition is two-valued
//   wherever it is placed.
// - A field name or a team ID reaches SQL: a field only through the shared
//   emitter, which refuses anything but a declared identifier; the
//   principal and the teams only as bound parameters (the teams as one
//   JSON list, read with `json_each`).
// - A write reaches a row the table's row rules keep from its caller: a
//   patch, replacement or deletion needs the row to pass the table's read
//   and write rules both (its read rules are its write rules where it
//   declares none), or it is answered as a missing row (`data.conflict`),
//   and the row it leaves must pass both again (`data.write_denied`), as
//   Postgres's row security holds USING and WITH CHECK. So no write moves
//   a row the rules hide into sight, or probes or deletes one by its ID
//   (store-host.ts `#apply`). This is about rows the rules hide only: a
//   table whose access mode writes more widely than it reads (read by
//   `appBuilders`, written by `appMembers`) lets its writers reach rows by
//   ID they can't read, as before rules, by its builders' explicit choice.
// - A team membership changes: the teams are read when the invocation is
//   resolved (`operationRoles`) and again before each commit, so the next
//   read or write sees the change; nothing here caches them.
// - `role("user")` admits more than its name says: everyone with a role
//   in the App, its builders included, and whoever calls a public
//   operation of a store the App serves (another App's or a workflow's
//   person, a member of the store's App for those calls).
// - A migration's transform, which reads every row of its table whoever
//   may, moves a row into other people's sight or carries one row's
//   values into another's: a transform never changes a field a rule
//   reads (`rule_changed`, store-host.ts `applySchema`, by stable ID),
//   so a row's audience moves only through
//   writes, which pass the rules before and after; and each batch holds
//   rows of one audience (`audienceKey`), the module state of its call
//   ending with it, so whatever it carries between rows stays with the
//   rows the same people already see.
// - A rule changed while versions pinned to the old one still run: a
//   store reads and writes under one schema, its App's current version's,
//   applied as that version is published, and refuses a version pinned to
//   any other (store-host.ts, `migration.not_current`). So an older
//   version never reads on under looser rules, nor a newer one under its
//   own before it is current. A schema change never fills in a field a
//   rule reads (`rule_field_filled`, schema-changes.ts).

/** Who a rule is evaluated for: what core resolved for the invocation. */
export interface RuleCaller {
  readonly principal: string;
  readonly appMember: boolean;
  readonly appBuilder: boolean;
  /** The teams they are in; none when left out. */
  readonly teams?: readonly string[] | undefined;
}

/** Where a statement finds a record's document and its owner. */
export interface RuleColumns {
  readonly document: string;
  readonly owner: string;
}

/** The columns of `sdk_records`, as a statement over it names them. */
export const recordColumns: RuleColumns = {
  document: "value_json",
  owner: "owner_id",
};

/** The fields `rules` read (person and team rules), each once, in order. */
export const fieldsRead = (rules: readonly RowRule[] | undefined): string[] => [
  ...new Set(
    (rules ?? []).flatMap((rule) => ("field" in rule ? [rule.field] : []))
  ),
];

/** The fields a table's rules read, for reading or writing. */
export const ruleFieldsOf = (rules: RowRules | undefined): string[] =>
  fieldsRead([...(rules?.read ?? []), ...(rules?.write ?? [])]);

/**
 * What decides which people a table's rows reach, besides App roles: the
 * row's owner, when its access mode or a rule reads it, and the fields its
 * rules read. Rows alike in these reach the same people.
 */
export interface Audience {
  readonly owner: boolean;
  readonly fields: readonly string[];
}

/** The audience of rows of `table` (see `Audience`). */
export const audienceOf = (
  table: Pick<ManifestTable, "access" | "rules">
): Audience => {
  const { access, rules } = table;
  const owner =
    access.read === "owner" ||
    access.write === "owner" ||
    [...(rules?.read ?? []), ...(rules?.write ?? [])].some(
      (rule) => rule.kind === "owner"
    );
  return { owner, fields: ruleFieldsOf(rules) };
};

/**
 * A row's audience as one text: equal for two rows exactly when its
 * owner (where `audience` reads it) and each field its rules read hold the
 * same value (absent and null alike: neither admits anyone).
 */
export const audienceKey = (
  audience: Audience,
  row: { readonly owner: string; readonly fields: StoreFields }
): string =>
  canonicalJson([
    audience.owner ? row.owner : null,
    ...audience.fields.map((field) =>
      Object.hasOwn(row.fields, field) ? (row.fields[field] ?? null) : null
    ),
  ]);

/** Whether the caller is a member of the App, never a visitor. */
const isMember = (caller: RuleCaller): boolean =>
  caller.appMember || caller.appBuilder;

/** Whether `rule` admits the caller to every row, whatever it holds. */
const admitsEveryRow = (rule: RowRule, caller: RuleCaller): boolean =>
  rule.kind === "role" &&
  (rule.role === "builder" ? caller.appBuilder : isMember(caller));

/** The condition one rule sets on a row, or none when it admits no row. */
const termOf = (
  rule: RowRule,
  caller: RuleCaller,
  columns: RuleColumns
): Fragment | undefined => {
  if (rule.kind === "owner") {
    return { sql: `${columns.owner} = ?`, params: [caller.principal] };
  }
  if (rule.kind === "role" || !isMember(caller)) {
    return undefined;
  }
  const value = textExpression(columns.document, rule.field);
  if (rule.kind === "person") {
    return { sql: `${value} = ?`, params: [caller.principal] };
  }
  const teams = caller.teams ?? [];
  return teams.length === 0
    ? undefined
    : {
        sql: `${value} IN (SELECT value FROM json_each(?))`,
        params: [JSON.stringify(teams)],
      };
};

/**
 * The condition `rules` (one direction of a table's) set on a row for
 * `caller`, over `columns`: true for a row any rule admits, false for any
 * other, never NULL. Undefined when there is no condition: no rules, or a
 * role rule the caller holds, which admits every row.
 */
export const ruleSql = (
  rules: readonly RowRule[] | undefined,
  caller: RuleCaller,
  columns: RuleColumns = recordColumns
): Fragment | undefined => {
  if (
    rules === undefined ||
    rules.some((rule) => admitsEveryRow(rule, caller))
  ) {
    return undefined;
  }
  const terms = rules
    .map((rule) => termOf(rule, caller, columns))
    .filter((term) => term !== undefined);
  if (terms.length === 0) {
    return { sql: "0", params: [] };
  }
  return {
    sql: `(${terms.map(({ sql }) => `IFNULL(${sql}, 0)`).join(" OR ")})`,
    params: terms.flatMap(({ params }) => params),
  };
};
