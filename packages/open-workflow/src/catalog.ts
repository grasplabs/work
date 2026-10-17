import type { ValueSchema } from "@grasp-os/sdk";
import { schemaFromDescriptor } from "@grasp-os/sdk/host";

/**
 * What a binding's contract key resolves to. A definition names contracts;
 * the host's approved catalog (and, for `local:` keys, the module manifest
 * it extracted from the workflow's own code) says what each one is. A
 * source binding is a requirement, never a grant: this only checks that
 * the definition asks for something the host has, of the right kind, and
 * uses it as its contract allows.
 */

export const bindingKinds = [
  "operation",
  "connector",
  "model",
  "workflow",
  "compute",
  "decision",
  "event",
] as const;
export type BindingKind = (typeof bindingKinds)[number];

/** A value contract: the JSON text of an SDK value descriptor. */
export type DescriptorText = string;

export interface CatalogContract {
  kind: BindingKind;
  /** operation, compute, decision and workflow: what a call passes. */
  input?: DescriptorText;
  /** operation, compute and workflow: what it returns. */
  output?: DescriptorText;
  /** decision: what a recipient answers with. */
  response?: DescriptorText;
  /** connector: the operations it allows, by name. */
  operations?: Readonly<
    Record<string, { input: DescriptorText; output: DescriptorText }>
  >;
  /**
   * event: the event types it admits, each with the descriptor of its data
   * and whether a person's screen may send it (`browser`): only those
   * become App references. A type without its data isn't admitted.
   */
  events?: Readonly<
    Record<string, { readonly data: DescriptorText; readonly browser: boolean }>
  >;
  /** workflow: the exact workflow the binding pins. */
  workflow?: { namespace: string; name: string; version: string };
  /**
   * A workflow's own action (a `local:` operation): the workflow's other
   * bindings it reaches, by alias and kind. Validation counts each as
   * referenced, so it is sealed and approved like one a task names.
   */
  uses?: readonly { alias: string; kind: BindingKind }[];
}

/** Looks a contract key up; `undefined` when there is no such contract. */
export type ContractLookup = (key: string) => CatalogContract | undefined;

const catalogLimits = {
  descriptorChars: 256 * 1024,
  /** Descriptor text across every contract one validation resolves. */
  totalDescriptorChars: 4 * 1024 * 1024,
  operations: 256,
  eventTypes: 64,
  nameLength: 256,
} as const;

/** A contract as validation holds it: copied, checked, schemas compiled. */
export interface ResolvedContract {
  kind: BindingKind;
  input?: ValueSchema<unknown, unknown>;
  output?: ValueSchema<unknown, unknown>;
  response?: ValueSchema<unknown, unknown>;
  operations?: ReadonlyMap<
    string,
    {
      input: ValueSchema<unknown, unknown>;
      output: ValueSchema<unknown, unknown>;
    }
  >;
  /** event: the types it admits. */
  eventTypes?: ReadonlySet<string>;
  /** event: each admitted type's data schema, and whether a screen sends it. */
  events?: ReadonlyMap<
    string,
    { data: ValueSchema<unknown, unknown>; browser: boolean }
  >;
  workflow?: { namespace: string; name: string; version: string };
  /** A workflow's own action: the other bindings it reaches. */
  uses?: readonly { readonly alias: string; readonly kind: BindingKind }[];
}

class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogError";
  }
}

const refuse = (message: string): never => {
  throw new CatalogError(message);
};

/**
 * One own data property of a caller object, read once through its
 * descriptor. A getter is refused, never called. A proxy's traps
 * (getOwnPropertyDescriptor, ownKeys, getPrototypeOf) do run, but each
 * value is read once, so what was checked is what is used, and whatever a
 * trap throws is caught by resolveContract.
 */
const ownData = (value: unknown, key: string): unknown => {
  if (typeof value !== "object" || value === null) {
    return refuse("not an object");
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    return undefined;
  }
  if (!("value" in descriptor)) {
    return refuse("an accessor where data belongs");
  }
  const data: unknown = descriptor.value;
  return data;
};

const isPlain = (value: unknown): value is object => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** The string keys of a plain object, all charged before any is read. */
const ownStringKeys = (value: unknown, limit: number): string[] => {
  if (!isPlain(value)) {
    return refuse("not a plain object");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > limit) {
    return refuse("too many keys");
  }
  const names: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") {
      return refuse("a symbol key");
    }
    if (Reflect.getOwnPropertyDescriptor(value, key)?.enumerable !== true) {
      return refuse("a hidden key");
    }
    names.push(key);
  }
  return names;
};

const text = (value: unknown, limit: number): string =>
  typeof value === "string" && value.length <= limit
    ? value
    : refuse("not text within its limit");

/** What the contracts of one validation may still cost, in descriptor text. */
export interface CatalogBudget {
  chars: number;
}

export const createCatalogBudget = (): CatalogBudget => ({
  chars: catalogLimits.totalDescriptorChars,
});

const schemaOf = (
  value: unknown,
  budget: CatalogBudget
): ValueSchema<unknown, unknown> => {
  const descriptor = text(value, catalogLimits.descriptorChars);
  // Charged before it is parsed: many contracts can't add up past it.
  budget.chars -= descriptor.length;
  if (budget.chars < 0) {
    return refuse("the contracts' descriptors are too large together");
  }
  // The SDK reads the descriptor text as untrusted, within its own limits.
  return schemaFromDescriptor(descriptor);
};

const optionalSchema = (
  contract: unknown,
  key: "input" | "output" | "response",
  budget: CatalogBudget
): ValueSchema<unknown, unknown> | undefined => {
  const value = ownData(contract, key);
  return value === undefined ? undefined : schemaOf(value, budget);
};

const readOperations = (
  value: unknown,
  budget: CatalogBudget
): ResolvedContract["operations"] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const operations = new Map<
    string,
    {
      input: ValueSchema<unknown, unknown>;
      output: ValueSchema<unknown, unknown>;
    }
  >();
  for (const name of ownStringKeys(value, catalogLimits.operations)) {
    const operation = ownData(value, name);
    operations.set(text(name, catalogLimits.nameLength), {
      input: schemaOf(ownData(operation, "input"), budget),
      output: schemaOf(ownData(operation, "output"), budget),
    });
  }
  return operations;
};

const readEvents = (
  value: unknown,
  budget: CatalogBudget
): ResolvedContract["events"] | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const events = new Map<
    string,
    { data: ValueSchema<unknown, unknown>; browser: boolean }
  >();
  for (const type of ownStringKeys(value, catalogLimits.eventTypes)) {
    const event = ownData(value, type);
    const browser = ownData(event, "browser");
    if (typeof browser !== "boolean") {
      return refuse("an event type that doesn't say whether a screen sends it");
    }
    if (type.length === 0) {
      return refuse("an empty event type");
    }
    if (browser && [...events.values()].some((known) => known.browser)) {
      // A binding's alias names the one type a screen may send.
      return refuse("more than one event type a screen sends");
    }
    events.set(text(type, catalogLimits.nameLength), {
      // Required: an event type is admitted only with its data's contract.
      data: schemaOf(ownData(event, "data"), budget),
      browser,
    });
  }
  return events;
};

const readWorkflow = (value: unknown): ResolvedContract["workflow"] => {
  if (value === undefined) {
    return undefined;
  }
  return {
    namespace: text(ownData(value, "namespace"), catalogLimits.nameLength),
    name: text(ownData(value, "name"), catalogLimits.nameLength),
    version: text(ownData(value, "version"), catalogLimits.nameLength),
  };
};

const isBindingKind = (value: unknown): value is BindingKind =>
  bindingKinds.some((kind) => kind === value);

/** The most bindings one action reaches. */
const maxUses = 32;
/** An alias, as the profile's bindings name them. */
const aliasPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/** An action's `uses`: each an alias and a binding kind, each alias once. */
const readUses = (value: unknown): ResolvedContract["uses"] => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > maxUses) {
    return refuse(`more than ${maxUses} uses, or uses that aren't a list`);
  }
  const seen = new Set<string>();
  return Object.freeze(
    Array.from(value, (use: unknown) => {
      const alias = ownData(use, "alias");
      const kind = ownData(use, "kind");
      if (
        typeof alias !== "string" ||
        !aliasPattern.test(alias) ||
        !isBindingKind(kind) ||
        seen.has(alias)
      ) {
        return refuse("a use that isn't an alias and a kind, each alias once");
      }
      seen.add(alias);
      return Object.freeze({ alias, kind });
    })
  );
};

/**
 * The fields each kind can't do without. A contract missing one would
 * allow anything where it should allow its list (any operation, event
 * type or child): it is refused instead.
 */
const requiredFields: Readonly<
  Record<BindingKind, readonly (keyof ResolvedContract)[]>
> = {
  operation: ["input", "output"],
  compute: ["input", "output"],
  connector: ["operations"],
  model: [],
  workflow: ["workflow", "input", "output"],
  decision: ["input", "response"],
  event: ["events"],
};

const checkComplete = (contract: ResolvedContract): void => {
  for (const field of requiredFields[contract.kind]) {
    if (contract[field] === undefined) {
      refuse(`a ${contract.kind} contract without ${field}`);
    }
  }
  if (contract.operations?.size === 0 || contract.events?.size === 0) {
    refuse("an empty list of operations or event types");
  }
};

const readContract = (
  contract: unknown,
  budget: CatalogBudget
): ResolvedContract => {
  const kind = ownData(contract, "kind");
  if (!isBindingKind(kind)) {
    return refuse("an unknown contract kind");
  }
  const resolved: ResolvedContract = { kind };
  const input = optionalSchema(contract, "input", budget);
  const output = optionalSchema(contract, "output", budget);
  const response = optionalSchema(contract, "response", budget);
  const operations = readOperations(ownData(contract, "operations"), budget);
  const events = readEvents(ownData(contract, "events"), budget);
  const workflow = readWorkflow(ownData(contract, "workflow"));
  const uses = readUses(ownData(contract, "uses"));
  if (uses !== undefined) {
    // Only an operation (an action) reaches other bindings.
    if (kind !== "operation") {
      return refuse("uses on a contract that isn't an operation");
    }
    resolved.uses = uses;
  }
  if (input !== undefined) {
    resolved.input = input;
  }
  if (output !== undefined) {
    resolved.output = output;
  }
  if (response !== undefined) {
    resolved.response = response;
  }
  if (operations !== undefined) {
    resolved.operations = operations;
  }
  if (events !== undefined) {
    resolved.events = events;
    resolved.eventTypes = new Set(events.keys());
  }
  if (workflow !== undefined) {
    resolved.workflow = workflow;
  }
  checkComplete(resolved);
  return resolved;
};

export type ContractResolution =
  | { found: true; contract: ResolvedContract }
  | { found: false; reason: string };

/**
 * Resolves `key` through `lookup`: the host's code, so whatever it returns
 * is copied out through own data properties, its descriptors compiled by
 * the SDK, and anything it throws is a contract that couldn't be resolved.
 */
export const resolveContract = (
  lookup: unknown,
  key: string,
  budget: CatalogBudget
): ContractResolution => {
  if (typeof lookup !== "function") {
    return { found: false, reason: "no catalog to resolve it against" };
  }
  try {
    const contract: unknown = Reflect.apply(lookup, undefined, [key]);
    if (contract === undefined) {
      return { found: false, reason: "no such contract" };
    }
    return { found: true, contract: readContract(contract, budget) };
  } catch (error) {
    // Our own refusals say what is missing; what the catalog itself threw
    // stays with the host.
    return {
      found: false,
      reason:
        error instanceof CatalogError
          ? `the catalog's entry is unusable: ${error.message}`
          : "the catalog's entry couldn't be read",
    };
  }
};

/** The host's ceilings a definition's limits may only lower. */
export interface LimitCeilings {
  maxSteps: number;
  maxModelCalls: number;
  maxActiveMs: number;
}

export interface ValidateOptions {
  /** The approved host catalog: every contract key but `local:` ones. */
  catalog: ContractLookup;
  /** The module manifest of the workflow's own code: `local:` keys only. */
  modules?: ContractLookup;
  /** Host ceilings; limits above them are refused. */
  ceilings?: LimitCeilings;
}

export interface ReadOptions {
  catalog: unknown;
  modules: unknown;
  ceilings?: LimitCeilings;
}

const readCeiling = (ceilings: unknown, key: keyof LimitCeilings): number => {
  const value = ownData(ceilings, key);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : refuse("a ceiling that isn't a positive whole number");
};

/** The options, read once through own data properties. */
export const readOptions = (options: unknown): ReadOptions => {
  const ceilings = ownData(options, "ceilings");
  const read: ReadOptions = {
    catalog: ownData(options, "catalog"),
    modules: ownData(options, "modules"),
  };
  if (ceilings !== undefined) {
    read.ceilings = {
      maxSteps: readCeiling(ceilings, "maxSteps"),
      maxModelCalls: readCeiling(ceilings, "maxModelCalls"),
      maxActiveMs: readCeiling(ceilings, "maxActiveMs"),
    };
  }
  return read;
};
