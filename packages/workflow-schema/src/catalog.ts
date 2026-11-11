import type { ValueSchema } from "@grasp-os/runtime/app";
import { schemaFromDescriptor } from "@grasp-os/runtime/host";
import { isEventType } from "@grasp-os/shared/sealed-builds";
import { catalogBindingKinds } from "@grasp-os/shared/workflow-resources";
import type { CatalogBindingKind } from "@grasp-os/shared/workflow-resources";

import type { BindingKind } from "./format.ts";

// The host catalog's contracts, as a definition's bindings resolve them:
// a definition names contracts; the host's approved catalog says what
// each one is. A binding is a requirement, never a grant: this reads what
// the host has, within its limits, so a check can hold a
// definition to it.

/** Every kind of contract the host catalog holds. */
export type ContractKind = CatalogBindingKind;

/**
 * The kind of contract a binding of `kind` names in the catalog: its own,
 * but for a `brain` binding, whose collection the catalog and the
 * approvals know as `knowledge`.
 */
export const contractKindOf = (kind: BindingKind): ContractKind =>
  kind === "brain" ? "knowledge" : kind;

/** A value contract: the JSON text of an SDK value descriptor. */
export type DescriptorText = string;

export interface CatalogContract {
  kind: ContractKind;
  /** decision: what a call passes. */
  input?: DescriptorText;
  /** decision: what a recipient answers with. */
  response?: DescriptorText;
  /** connector: the operations it allows, by name. */
  operations?: Readonly<
    Record<
      string,
      {
        input: DescriptorText;
        output: DescriptorText;
        /** That it only reads, as its publisher states (never checked here). */
        readOnly?: boolean;
        /** That it answers a file, as its host confirmed (never checked here). */
        answersFile?: true;
        /** That it attaches files, as its host confirmed (never checked here). */
        takesFiles?: true;
      }
    >
  >;
  /**
   * event: the event types it admits, each with the descriptor of its data
   * and whether a person's page may send it (`browser`): only those
   * become App references. A type without its data isn't admitted.
   */
  events?: Readonly<
    Record<string, { readonly data: DescriptorText; readonly browser: boolean }>
  >;
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
  kind: ContractKind;
  input?: ValueSchema<unknown, unknown>;
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
  /** event: each admitted type's data schema, and whether a page sends it. */
  events?: ReadonlyMap<
    string,
    { data: ValueSchema<unknown, unknown>; browser: boolean }
  >;
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
  key: "input" | "response",
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
      return refuse("an event type that doesn't say whether a page sends it");
    }
    if (!isEventType(type)) {
      return refuse("an event type no run's inbox takes");
    }
    if (browser && [...events.values()].some((known) => known.browser)) {
      // A binding's alias names the one type a page may send.
      return refuse("more than one event type a page sends");
    }
    events.set(type, {
      // Required: an event type is admitted only with its data's contract.
      data: schemaOf(ownData(event, "data"), budget),
      browser,
    });
  }
  return events;
};

const isContractKind = (value: unknown): value is ContractKind =>
  catalogBindingKinds.some((kind) => kind === value);

/**
 * The fields each kind can't do without. A contract missing one would
 * allow anything where it should allow its list (any operation, event
 * type or child): it is refused instead.
 */
const requiredFields: Readonly<
  Record<ContractKind, readonly (keyof ResolvedContract)[]>
> = {
  connector: ["operations"],
  model: [],
  decision: ["input", "response"],
  event: ["events"],
  // Served by the host's own contract (search, read and recall).
  knowledge: [],
  // The run's own files (GRA-724): the host's own contract too.
  files: [],
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
  if (!isContractKind(kind)) {
    return refuse("an unknown contract kind");
  }
  const resolved: ResolvedContract = { kind };
  const input = optionalSchema(contract, "input", budget);
  const response = optionalSchema(contract, "response", budget);
  const operations = readOperations(ownData(contract, "operations"), budget);
  const events = readEvents(ownData(contract, "events"), budget);
  if (input !== undefined) {
    resolved.input = input;
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
