/**
 * The words the admin gives Damsko's parts in place of their English
 * (`I18nProvider`'s catalogue, routes/__root.tsx). Only the parts whose
 * words the admin says its own way are here: the Flow's list of steps,
 * moved from the keyboard (flow.tsx), says each move as it always has.
 */
import type { I18nCatalog } from "@grasp-os/ui/lib/i18n";

export const uiWords: Partial<I18nCatalog> = {
  sortableList: {
    instructions:
      "Press space to pick a step up, the arrow keys to move it, space to put it down, escape to leave it where it was.",
    grabbed: (name, position) => `${name} picked up, at place ${position}.`,
    moved: (name, position) => `${name} moved to place ${position}.`,
    dropped: (name, position) => `${name} put down at place ${position}.`,
    cancelled: (name) => `${name} left where it was.`,
  },
};
