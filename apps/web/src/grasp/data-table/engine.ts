// The Data table's engine: TanStack Table (v9, pinned), with only the features a table uses.
// Sorting, search, choosing rows and pages are always in (they are what a Data table is); the rest
// are pieces a table takes when it needs them (pieces.ts), so a table that does not resize, pin,
// reorder, hide, expand or group does not carry their code.
//
//   import { DataTable, resizing, pinning } from "@/components/grasp/data-table";
//   <DataTable pieces={[resizing, pinning]} ... />
import {
  columnFilteringFeature,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
} from "@tanstack/react-table";

import type { allFeatures } from "./all-features";

/** One feature a table takes beyond its own: the TanStack features it registers, by name. */
export interface DataTablePiece {
  /** Its name, unique among pieces ("resizing"). */
  readonly name: string;
  /** The TanStack features and row models it registers, prerequisites first. */
  readonly features: Readonly<Record<string, unknown>>;
}

/**
 * The features as the types see them: every one, so each piece's API types. At run time a table
 * carries only its own, and reads a piece's API only while it holds that piece.
 */
export type Features = typeof allFeatures;

const base = {
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  rowSelectionFeature,
  rowPaginationFeature,
};
const models = {
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
};

// TanStack wants a features object that does not change while the table lives: one per set of
// pieces (in the order given), made once.
const made = new Map<string, Features>();

const isModel = ([name]: [string, unknown]) => name.endsWith("RowModel");

/**
 * A table's features as the types see them, once its base is checked: they are a part of every
 * feature, and the Data table reads a piece's API only while it holds that piece (`has`).
 */
const holdsBase = (features: object): features is Features =>
  Object.keys(base).every((name) => name in features) &&
  Object.keys(models).every((name) => name in features);

export const featuresFor = (pieces: readonly DataTablePiece[]): Features => {
  const key = pieces.map((piece) => piece.name).join(" ");
  const known = made.get(key);
  if (known !== undefined) {
    return known;
  }
  const extra = pieces.flatMap((piece) => Object.entries(piece.features));
  // Feature modules first, row models after their prerequisites.
  const built = {
    ...base,
    ...Object.fromEntries(extra.filter((entry) => !isModel(entry))),
    ...models,
    ...Object.fromEntries(extra.filter(isModel)),
  };
  if (!holdsBase(built)) {
    throw new Error(
      "A Data table's features lost their base: sorting, search, choosing and pages."
    );
  }
  made.set(key, built);
  return built;
};

export const has = (pieces: readonly DataTablePiece[], name: string) =>
  pieces.some((piece) => piece.name === name);
