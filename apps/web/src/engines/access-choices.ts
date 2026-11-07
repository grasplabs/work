import type { AppDataAccess } from "@grasp-os/shared/app-data";
import type {
  DataModelRule,
  DataModelTable,
} from "@grasp-os/shared/data-model";

// Who can see and who can change a table's records, as one answer each,
// mapped exactly onto the definition's access (a mode and its row rules,
// `setAccess`) and back. An access no single answer says (rules combined
// by the App's code) reads as `code`, and stays exactly as it is unless
// an answer replaces it. Saving one direction never widens the other:
// changes follow the read rules when they have none of their own, so a
// change of who sees pins the old ones on who changes.

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

/** The access `setAccess` takes. */
export interface Access {
  read: AppDataAccess;
  write: AppDataAccess;
  rows?: { read?: DataModelRule[]; write?: DataModelRule[] };
}

/** Whether rules can narrow a mode: one that reaches more than one person's. */
const narrows = (mode: AppDataAccess): boolean =>
  mode === "appMembers" || mode === "appBuilders";

/** Who sees a table's records. */
export const seeing = (table: DataModelTable): Direction => ({
  mode: table.access.read,
  rules: table.access.rows.read,
});

/**
 * Who changes a table's records, as the store reads it: without write
 * rules of their own, the read rules narrow changes too.
 */
export const changing = (table: DataModelTable): Direction => {
  const { write, rows } = table.access;
  if (rows.write.length > 0) {
    return { mode: write, rules: rows.write };
  }
  return { mode: write, rules: narrows(write) ? rows.read : [] };
};

/** Whether `rules` is exactly the one `rule`. */
const only = (rules: DataModelRule[], rule: DataModelRule): boolean =>
  rules.length === 1 && JSON.stringify(rules[0]) === JSON.stringify(rule);

/** The one answer a direction is, or `code` for what no answer says. */
export const choiceOf = ({ mode, rules }: Direction): AccessChoice => {
  const [rule] = rules;
  if (rule === undefined) {
    if (mode === "appMembers") {
      return { kind: "everyone" };
    }
    if (mode === "appBuilders") {
      return { kind: "builders" };
    }
    return mode === "owner" ? { kind: "added" } : { kind: "nobody" };
  }
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
    (rule.kind === "person" || rule.kind === "team")
  ) {
    return { kind: rule.kind, field: rule.field };
  }
  return { kind: "code" };
};

/**
 * The direction an answer is. `inherits` says the direction would take
 * the read rules without rules of its own (changes, under read rules):
 * then everyone and builders name themselves, so no read rule narrows
 * them unasked.
 */
export const directionOf = (choice: Answer, inherits = false): Direction => {
  switch (choice.kind) {
    case "everyone": {
      return {
        mode: "appMembers",
        rules: inherits ? [{ kind: "role", role: "user" }] : [],
      };
    }
    case "builders": {
      return {
        mode: "appBuilders",
        rules: inherits ? [{ kind: "role", role: "builder" }] : [],
      };
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
    case "nobody": {
      return { mode: "none", rules: [] };
    }
    default: {
      return { mode: "none", rules: [] };
    }
  }
};

/**
 * The access a table gets from the answers given (`read`, `write`; the
 * table's own for one not given), each mapped exactly. Who changes keeps
 * what it reaches now when only who sees changes.
 */
export const accessAfter = (
  table: DataModelTable,
  {
    read,
    write,
  }: {
    read?: Answer;
    write?: Answer;
  }
): Access => {
  const seen = read === undefined ? seeing(table) : directionOf(read);
  let changed: Direction;
  if (write !== undefined) {
    changed = directionOf(write, seen.rules.length > 0);
  } else if (read === undefined) {
    // Untouched: as the table declares it.
    changed = { mode: table.access.write, rules: table.access.rows.write };
  } else {
    // Pinned: what changes reached under the old read rules, they still
    // reach under the new.
    changed = changing(table);
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

/** An answer as a key: a radio's value. */
export const choiceKey = (choice: AccessChoice): string =>
  choice.kind === "person" || choice.kind === "team"
    ? `${choice.kind}:${choice.field}`
    : choice.kind;
