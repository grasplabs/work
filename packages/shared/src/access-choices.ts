import type { AppDataAccess } from "./app-data.ts";
import type { DataModelRule, DataModelTable } from "./data-model.ts";

// Who can see and who can change a table's records, as one answer each,
// mapped exactly onto the definition's access (a mode and its row rules,
// `setAccess`) and back, as the App's store enforces it (core's
// store-host.ts): reading takes the read mode and the read rules; writing
// takes the write mode, the read rules, and the write rules (the read
// rules again where it has none), and never the read mode. So:
//
// - who changes is read from all that writing takes (`enforcedChange`),
//   never from the write direction alone;
// - who changes is never offered wider than who sees (`within`), and an
//   answer is saved so the write direction alone enforces it;
// - a change of who sees keeps who changes as it was enforced, or narrows
//   it to the new answer, and never widens it.
//
// An access no single answer says (rules combined by the App's code)
// reads as `code`, and is kept as it is unless an answer replaces it.

/** One answer to who can see, or change, a table's records. */
export type AccessChoice =
  | { kind: "everyone" }
  | { kind: "added" }
  | { kind: "person" | "team"; field: string }
  | { kind: "builders" }
  | { kind: "nobody" }
  | { kind: "code" };

/** An answer a person can give: every one but `code`. */
export type Answer = Exclude<AccessChoice, { kind: "code" }>;

/** One direction of a table's access: its mode, and the rules that narrow it. */
export interface Direction {
  mode: AppDataAccess;
  rules: DataModelRule[];
}

/**
 * Who changes a table's records, as the store enforces it: the write mode,
 * and each list of rules a record must pass (any rule of each).
 */
export interface Enforced {
  mode: AppDataAccess;
  conditions: DataModelRule[][];
}

/** The access `setAccess` takes. */
export interface Access {
  read: AppDataAccess;
  write: AppDataAccess;
  rows?: { read?: DataModelRule[]; write?: DataModelRule[] };
}

/** Rules as a key: two lists alike say the same. */
const keyOf = (rules: readonly DataModelRule[]): string =>
  JSON.stringify(rules);

/** Who sees a table's records. */
export const seeing = (table: DataModelTable): Direction => ({
  mode: table.access.read,
  rules: table.access.rows.read,
});

/** Who changes a table's records, as the store enforces it. */
export const enforcedChange = (table: DataModelTable): Enforced => {
  const { write, rows } = table.access;
  const written = rows.write.length > 0 ? rows.write : rows.read;
  const conditions = [rows.read, written].filter((rules) => rules.length > 0);
  const unique = conditions.filter(
    (rules, index) =>
      conditions.findIndex((other) => keyOf(other) === keyOf(rules)) === index
  );
  return { mode: write, conditions: unique };
};

/** Whether `rules` is exactly the one `rule`. */
const only = (rules: readonly DataModelRule[], rule: DataModelRule): boolean =>
  keyOf(rules) === keyOf([rule]);

/** The answer a mode and one list of rules (or none) is, or `code`. */
const answerOf = (
  mode: AppDataAccess,
  rules: readonly DataModelRule[] | undefined
): AccessChoice => {
  if (mode === "none") {
    return { kind: "nobody" };
  }
  if (rules === undefined) {
    if (mode === "appMembers") {
      return { kind: "everyone" };
    }
    return mode === "appBuilders" ? { kind: "builders" } : { kind: "added" };
  }
  const [rule] = rules;
  if (mode === "appMembers" && only(rules, { kind: "role", role: "user" })) {
    return { kind: "everyone" };
  }
  if (
    mode === "appBuilders" &&
    only(rules, { kind: "role", role: "builder" })
  ) {
    return { kind: "builders" };
  }
  if (
    mode === "appMembers" &&
    rules.length === 1 &&
    (rule?.kind === "person" || rule?.kind === "team")
  ) {
    return { kind: rule.kind, field: rule.field };
  }
  return { kind: "code" };
};

/** The one answer who sees is, or `code`. */
export const seeAnswer = ({ mode, rules }: Direction): AccessChoice =>
  answerOf(mode, rules.length === 0 ? undefined : rules);

/** The one answer who changes is, as enforced, or `code`. */
export const changeAnswer = ({ mode, conditions }: Enforced): AccessChoice => {
  if (mode === "none") {
    return { kind: "nobody" };
  }
  if (conditions.length > 1) {
    return { kind: "code" };
  }
  return answerOf(mode, conditions[0]);
};

/** The direction an answer is, enforcing it alone. */
export const directionOf = (choice: Answer): Direction => {
  switch (choice.kind) {
    case "everyone": {
      return { mode: "appMembers", rules: [] };
    }
    case "added": {
      return { mode: "owner", rules: [] };
    }
    case "person":
    case "team": {
      return {
        mode: "appMembers",
        rules: [{ kind: choice.kind, field: choice.field }],
      };
    }
    case "builders": {
      return { mode: "appBuilders", rules: [] };
    }
    case "nobody": {
      return { mode: "none", rules: [] };
    }
    default: {
      return { mode: "none", rules: [] };
    }
  }
};

/** An answer as a key: a radio's value. */
export const choiceKey = (choice: AccessChoice): string =>
  choice.kind === "person" || choice.kind === "team"
    ? `${choice.kind}:${choice.field}`
    : choice.kind;

/**
 * Whether answer `inner` reaches no further than `outer`: the same, or
 * nobody, or anything within everyone.
 */
export const within = (inner: AccessChoice, outer: AccessChoice): boolean =>
  inner.kind === "nobody" ||
  outer.kind === "everyone" ||
  (inner.kind !== "code" && choiceKey(inner) === choiceKey(outer));

/** A field named for a team: `team`, `salesTeam`, `team_id`. */
const teamNamed = /team/iu;

/** Every answer a table's fields allow, in the order offered. */
export const choicesFor = (table: DataModelTable): Answer[] => [
  { kind: "everyone" },
  { kind: "added" },
  ...table.fields.flatMap((field): Answer[] => {
    if (field.type.kind === "person") {
      return [{ kind: "person", field: field.name }];
    }
    // A team rule reads a text field that holds a team's ID: offered for
    // one named for a team, never for every text field (a title).
    if (field.type.kind === "text" && teamNamed.test(field.name)) {
      return [{ kind: "team", field: field.name }];
    }
    return [];
  }),
  { kind: "builders" },
  { kind: "nobody" },
];

/** The answers who changes may take under who sees `see`: none wider. */
export const changeChoices = (
  table: DataModelTable,
  see: AccessChoice
): Answer[] => choicesFor(table).filter((answer) => within(answer, see));

/**
 * Who changes, kept as `enforced` under who now sees (`see`, its read
 * rules `seen`), or narrowed: an answer within the new one is kept; one
 * the new one is within narrows to it; rules of the App's code are kept
 * where the new read rules still apply or nothing narrows them, and
 * otherwise nobody changes records until someone answers again.
 */
const keptChange = (
  enforced: Enforced,
  see: AccessChoice,
  seen: Direction
): Direction => {
  const answer = changeAnswer(enforced);
  if (answer.kind !== "code") {
    if (within(answer, see)) {
      return directionOf(answer);
    }
    return see.kind !== "code" && within(see, answer)
      ? directionOf(see)
      : directionOf({ kind: "nobody" });
  }
  const [rules] = enforced.conditions;
  const narrowsByRules =
    see.kind === "everyone" || see.kind === "person" || see.kind === "team";
  if (
    enforced.conditions.length === 1 &&
    rules !== undefined &&
    (enforced.mode === "appMembers" || enforced.mode === "appBuilders") &&
    (narrowsByRules || (see.kind === "code" && seen.rules.length > 0))
  ) {
    return { mode: enforced.mode, rules };
  }
  if (
    enforced.conditions.length === 1 &&
    rules !== undefined &&
    (enforced.mode === "appMembers" || enforced.mode === "appBuilders") &&
    see.kind === "builders"
  ) {
    return { mode: "appBuilders", rules };
  }
  return directionOf({ kind: "nobody" });
};

/**
 * The access a table gets from the answers given (`read`, `write`; the
 * table's own for one not given), each mapped exactly: who changes never
 * reaches further than who sees, and keeps what it enforced when only
 * who sees changes.
 */
export const accessAfter = (
  table: DataModelTable,
  { read, write }: { read?: Answer; write?: Answer }
): Access => {
  const seen = read === undefined ? seeing(table) : directionOf(read);
  const see = read ?? seeAnswer(seen);
  let changed: Direction;
  if (write !== undefined) {
    // An answer wider than who sees narrows to it.
    changed = within(write, see)
      ? directionOf(write)
      : directionOf(see.kind === "code" ? { kind: "nobody" } : see);
  } else if (read === undefined) {
    changed = { mode: table.access.write, rules: table.access.rows.write };
  } else {
    changed = keptChange(enforcedChange(table), see, seen);
  }
  const rows = {
    ...(seen.rules.length > 0 ? { read: seen.rules } : {}),
    ...(changed.rules.length > 0 ? { write: changed.rules } : {}),
  };
  return {
    read: seen.mode,
    write: changed.mode,
    ...(Object.keys(rows).length > 0 ? { rows } : {}),
  };
};

/** `table` with `access` as its own: what it reads as once saved. */
export const withAccess = (
  table: DataModelTable,
  access: Access
): DataModelTable => ({
  ...table,
  access: {
    read: access.read,
    write: access.write,
    rows: { read: access.rows?.read ?? [], write: access.rows?.write ?? [] },
  },
});
