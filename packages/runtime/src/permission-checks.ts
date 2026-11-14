import { originRefusal } from "@grasp-os/shared/app-link-limits";
import { resourceAliasPattern } from "@grasp-os/shared/function-limits";
import { identifierMaxLength } from "@grasp-os/shared/identifier";
import { deepFreeze, isPlainObject } from "@grasp-os/shared/json";

import { refuser } from "./declaration.ts";
import type { FilesOperation } from "./file-link-references.ts";
import { memberName } from "./member-names.ts";
import type {
  AnyPermission,
  BrainOperation,
  BrowserPermission,
  GuestsOperation,
  WorkflowPermission,
} from "./permission-types.ts";

/** Why a permission's declaration was refused. */
export class PermissionDefinitionError extends Error {
  readonly code = "permission.invalid_declaration";

  constructor(message: string) {
    super(message);
    this.name = "PermissionDefinitionError";
  }
}

export const refuse: (message: string) => never = refuser(
  PermissionDefinitionError
);

/** A contract and its major version, e.g. `grasp.mail@1`. */
const contractPattern =
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*@[1-9]\d{0,5}$/u;

/** An action, operation or collection name a declaration lists. */
const namePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

/** The most entries one declaration lists. */
const listMax = 32;

/** Every declaration an action reaches that `permission` made. */
const declarations = new WeakSet<object>();

/** Every browser-facing declaration `permission` made. */
const browserDeclarations = new WeakSet<object>();

/** Every workflow declaration `permission` made. */
const workflowDeclarations = new WeakSet<object>();

/** Whether `value` is a declaration `permission` made for actions. */
export const isPermission = (value: unknown): value is AnyPermission =>
  typeof value === "object" && value !== null && declarations.has(value);

/** Whether `value` is a workflow declaration `permission` made. */
export const isWorkflowPermission = (
  value: unknown
): value is WorkflowPermission =>
  typeof value === "object" &&
  value !== null &&
  workflowDeclarations.has(value);

/** Whether `value` is a files or links declaration `permission` made. */
export const isBrowserPermission = (
  value: unknown
): value is BrowserPermission =>
  typeof value === "object" && value !== null && browserDeclarations.has(value);

/** Every Brain operation, as a declaration names it. */
export const brainOperations: readonly BrainOperation[] = [
  "recall",
  "skills.select",
  "skills.read",
  "entities.get",
  "entities.find",
];

/** The operations a guests permission may declare. */
export const guestsOperations: readonly GuestsOperation[] = [
  "invite",
  "list",
  "read",
  "revoke",
];

/** The operations a files permission may declare. */
export const filesOperations: readonly FilesOperation[] = [
  "upload",
  "read",
  "attach",
  "delete",
];

/**
 * An exact HTTPS origin a links permission may list (`originRefusal`, in
 * the shared app-link-limits module: the same rule core holds every open
 * to): scheme, a host name and an optional port, in lower case, with
 * nothing after it; never an IP address or a private network's host.
 */
const checkedOrigin = (origin: unknown): string => {
  const refused = originRefusal(origin);
  if (refused === "ip_literal") {
    return refuse(
      `\`${String(origin)}\` is an IP address: a link origin is a public site's host name.`
    );
  }
  if (refused === "private_network") {
    return refuse(
      `\`${String(origin)}\` is on a private network: a link origin is a public site's.`
    );
  }
  if (refused !== undefined || typeof origin !== "string") {
    return refuse(
      typeof origin === "string"
        ? `\`${origin}\` isn't an exact HTTPS origin: \`https://\`, a host and an optional port, in lower case, with nothing after it.`
        : "A link origin is an HTTPS origin, e.g. `https://example.com`."
    );
  }
  return origin;
};

export const checkedAlias = (alias: unknown): string =>
  typeof alias === "string" && resourceAliasPattern.test(alias)
    ? alias
    : refuse(
        "A permission's alias is a letter, then letters, digits or underscores, at most 64."
      );

export const checkedConfig = (
  config: unknown,
  keys: readonly string[]
): Record<string, unknown> => {
  if (!isPlainObject(config)) {
    return refuse("A permission's config is an object.");
  }
  for (const key of Object.keys(config)) {
    if (!keys.includes(key)) {
      refuse(`A permission's config has no \`${key}\`.`);
    }
  }
  return config;
};

// No longer than an identifier, so the audit events that name a binding's
// contract can carry it.
export const checkedContract = (contract: unknown): string =>
  typeof contract === "string" &&
  contract.length <= identifierMaxLength &&
  contractPattern.test(contract)
    ? contract
    : refuse(
        `A contract is a dotted name and its major version, e.g. \`grasp.mail@1\`, of at most ${identifierMaxLength} characters.`
      );

export const checkedList = (
  list: unknown,
  what: string,
  allowed?: readonly string[]
): readonly string[] => {
  if (!Array.isArray(list) || list.length === 0 || list.length > listMax) {
    return refuse(`A permission lists between 1 and ${listMax} ${what}.`);
  }
  const items: readonly unknown[] = list;
  const names: string[] = [];
  for (const name of items) {
    // A fixed list is the platform's own names (the Brain's
    // `skills.select`), which it alone decides; any other is a name.
    const known =
      typeof name === "string" &&
      (allowed === undefined ? namePattern.test(name) : allowed.includes(name));
    if (!known) {
      return refuse(`A permission lists ${what} it can't have.`);
    }
    if (names.includes(name)) {
      refuse(`A permission lists \`${name}\` twice.`);
    }
    names.push(name);
  }
  return Object.freeze(names);
};

/**
 * Members the runtime calls on a value of its own accord: `await` reads
 * `then`, `JSON.stringify` `toJSON`, and a template literal or `+`
 * `toString` and `valueOf`. A client holding one would run an action
 * nobody called.
 */
const implicitMembers: ReadonlySet<string> = new Set([
  "then",
  "toJSON",
  "toString",
  "valueOf",
]);

/**
 * A connection's actions (`checkedList`), each a member of its client of
 * its own (member-names.ts): a member the runtime calls implicitly, and
 * two names with one member, are refused.
 */
export const checkedActions = (list: unknown): readonly string[] => {
  const actions = checkedList(list, "actions");
  const implicit = actions.find((action) =>
    implicitMembers.has(memberName(action))
  );
  if (implicit !== undefined) {
    return refuse(
      `A connection can't list \`${implicit}\`: its client would run it unasked, from \`await\`, \`JSON.stringify\` or turning it into text.`
    );
  }
  if (new Set(actions.map(memberName)).size !== actions.length) {
    return refuse(
      "A connection lists two actions that are called alike, such as `send-mail` and `sendMail`."
    );
  }
  return actions;
};

/** The names of `list` that are among `known`, typed as such. */
export const known = <Name extends string>(
  list: readonly string[],
  names: readonly Name[]
): Name[] =>
  list.filter((name): name is Name => names.some((each) => each === name));

/**
 * `declaration`, frozen all the way down, so nothing changes what was
 * checked before the App registers it, and registered as genuine.
 */
export const declared = (declaration: AnyPermission): AnyPermission => {
  const frozen = deepFreeze(declaration);
  declarations.add(frozen);
  return frozen;
};

/** A browser-facing declaration, frozen and registered as genuine. */
export const declaredForBrowser = (
  declaration: BrowserPermission
): BrowserPermission => {
  const frozen = deepFreeze(declaration);
  browserDeclarations.add(frozen);
  return frozen;
};

/** A workflow declaration, frozen and registered as genuine. */
export const declaredWorkflow = (
  declaration: WorkflowPermission
): WorkflowPermission => {
  const frozen = deepFreeze(declaration);
  workflowDeclarations.add(frozen);
  return frozen;
};

/** The origins a links permission lists: 1 to 32 exact HTTPS origins. */
export const checkedOrigins = (origins: unknown): readonly string[] => {
  if (
    !Array.isArray(origins) ||
    origins.length === 0 ||
    origins.length > listMax
  ) {
    return refuse(`A links permission lists between 1 and ${listMax} origins.`);
  }
  const listed: readonly unknown[] = origins;
  const checked: string[] = [];
  for (const origin of listed) {
    const exact = checkedOrigin(origin);
    if (checked.includes(exact)) {
      refuse(`A links permission lists \`${exact}\` twice.`);
    }
    checked.push(exact);
  }
  return Object.freeze(checked);
};
