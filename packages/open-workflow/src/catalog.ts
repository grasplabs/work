import type { ContractLookup } from "@grasp-os/workflow-schema/catalog";

// The host catalog's reader moved into @grasp-os/workflow-schema; this
// profile keeps only the options its own validation reads.

export {
  contractKinds as bindingKinds,
  createCatalogBudget,
  resolveContract,
} from "@grasp-os/workflow-schema/catalog";
export type {
  CatalogBudget,
  CatalogContract,
  ContractKind as BindingKind,
  ContractLookup,
  ContractResolution,
  ContractUse,
  DescriptorText,
  ResolvedContract,
} from "@grasp-os/workflow-schema/catalog";

/** One own data property, read once; a getter is refused, never called. */
const ownData = (value: unknown, key: string): unknown => {
  if (typeof value !== "object" || value === null) {
    throw new Error("not an object");
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) {
    return undefined;
  }
  if (!("value" in descriptor)) {
    throw new Error("an accessor where data belongs");
  }
  const data: unknown = descriptor.value;
  return data;
};

const refuse = (message: string): never => {
  throw new Error(message);
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
