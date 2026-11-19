import type { App } from "@grasp-os/shared/apps";

import { defaultLook } from "../grasp/backdrop/index.ts";
import type { BackdropLook } from "../grasp/backdrop/index.ts";

// Each App card's ground on the Apps page: one of the library's Backdrop
// looks, its six night scenes (sand and the dithers fade out where a card
// shows its ground, round the window's top and sides), chosen by the App's ID so an App keeps its own wherever it is
// listed. Apps are given theirs oldest first; one whose look an older App
// already holds takes the next free one, so no two cards share a ground
// until every look is taken.

const LOOKS: readonly BackdropLook[] = [
  { backdrop: "aurora", pattern: "bayer", tone: "light" },
  { backdrop: "wave", pattern: "bayer", tone: "light" },
  { backdrop: "fuji", pattern: "bayer", tone: "light" },
  { backdrop: "starry", pattern: "bayer", tone: "light" },
  { backdrop: "cliffs", pattern: "bayer", tone: "light" },
  { backdrop: "wanderer", pattern: "bayer", tone: "light" },
];

/** A whole number from `id`, the same on every load. */
const hashOf = (id: string): number => {
  let hash = 7;
  for (const char of id) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return hash;
};

/** Each App's ground, by its ID. */
export const groundsOf = (
  apps: readonly Pick<App, "id" | "createdAt">[]
): Map<string, BackdropLook> => {
  const grounds = new Map<string, BackdropLook>();
  const taken = new Set<number>();
  const oldestFirst = apps.toSorted((one, other) =>
    one.createdAt.localeCompare(other.createdAt)
  );
  for (const app of oldestFirst) {
    let at = hashOf(app.id) % LOOKS.length;
    for (let tries = 0; tries < LOOKS.length && taken.has(at); tries += 1) {
      at = (at + 1) % LOOKS.length;
    }
    // Every look taken: they repeat from here, still by the App's ID.
    if (taken.size >= LOOKS.length) {
      taken.clear();
    }
    taken.add(at);
    grounds.set(app.id, LOOKS[at] ?? defaultLook);
  }
  return grounds;
};
