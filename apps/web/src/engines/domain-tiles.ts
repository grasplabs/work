import type { AppStatus } from "@grasp-os/shared/apps";
import type { Painting, Pattern } from "@grasp-os/ui/components/painted-field";

// How the Domains page lays out its tiles, as the prototype's Apps page
// (`components/apps/apps-overview.tsx`): each on a painted field, in turn,
// a row of tabs only when more than one status holds a domain, and a
// search only once there are enough to need one.

/** A painted field: always a painting and a pattern. */
export interface Field {
  painting: Painting;
  pattern: Pattern;
}

/**
 * The fields the tiles stand on, in turn, as the prototype's `FIELDS`: no
 * two of them share a painting or a pattern, so neither do two tiles side
 * by side or one above the other, in two columns or three; in dark mode
 * each light painting becomes one of the three dark ones.
 */
export const fields: readonly Field[] = [
  { painting: "dawn", pattern: "columns" },
  { painting: "sand", pattern: "rings" },
  { painting: "blush", pattern: "grid" },
  { painting: "mist", pattern: "horizon" },
  { painting: "sage", pattern: "mosaic" },
  { painting: "stone", pattern: "rows" },
];

/** The field of the tile at `index` in the list shown. */
export const fieldAt = (index: number): Field =>
  fields[index % fields.length] ?? { painting: "dawn", pattern: "columns" };

/** The statuses, in the prototype's order. */
const statusOrder = [
  "published",
  "draft",
  "archived",
] as const satisfies readonly AppStatus[];

/** Every domain at once, as the page opens. */
export const allStatuses = "all";
export type ShownStatus = AppStatus | typeof allStatuses;

/** The statuses that hold a domain, in order: a tab each, beside All, once there are two or more. */
export const heldStatuses = (
  statuses: readonly AppStatus[]
): readonly AppStatus[] =>
  statusOrder.filter((status) => statuses.includes(status));

/** From this many domains on, the page offers a search: with fewer, every name is in view anyway. */
export const searchFrom = 7;

/**
 * Whether `name` answers `query`, a search as typed: any part of the
 * name, in any case. An empty query, or only spaces, answers every name.
 */
export const nameMatches = (name: string, query: string): boolean => {
  const needle = query.trim().toLocaleLowerCase();
  return needle === "" || name.toLocaleLowerCase().includes(needle);
};
