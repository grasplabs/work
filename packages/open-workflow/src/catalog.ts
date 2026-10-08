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
  /** event: the event types it admits. */
  eventTypes?: readonly string[];
  /** workflow: the exact workflow the binding pins. */
  workflow?: { namespace: string; name: string; version: string };
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
  eventTypes?: ReadonlySet<string>;
  workflow?: { namespace: string; name: string; version: string };
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

const readEventTypes = (value: unknown): ReadonlySet<string> | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return refuse("event types aren't a list");
  }
  // Read once: a proxy's length could change from one read to the next.
  const length = ownData(value, "length");
  if (typeof length !== "number" || length > catalogLimits.eventTypes) {
    return refuse("too many event types");
  }
  const types = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    types.add(text(ownData(value, String(index)), catalogLimits.nameLength));
  }
  return types;
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
  event: ["eventTypes"],
};

const checkComplete = (contract: ResolvedContract): void => {
  for (const field of requiredFields[contract.kind]) {
    if (contract[field] === undefined) {
      refuse(`a ${contract.kind} contract without ${field}`);
    }
  }
  if (contract.operations?.size === 0 || contract.eventTypes?.size === 0) {
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
  const eventTypes = readEventTypes(ownData(contract, "eventTypes"));
  const workflow = readWorkflow(ownData(contract, "workflow"));
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
  if (eventTypes !== undefined) {
    resolved.eventTypes = eventTypes;
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
