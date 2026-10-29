import type { SurfaceKind, SurfaceSummary } from "@grasp-os/shared/screens";

// What a domain's apps (core's screens) are called on its page: the title
// its builders gave a surface that opens the screen (spec 34.1), never its
// file's name, which is code's. A screen several surfaces open takes the
// title of the one the host shows most plainly: the sidebar's first, then
// a panel's, a deep link's, and the settings' last.

/** The kinds, the plainest place first. */
const plainestFirst: readonly SurfaceKind[] = [
  "sidebar",
  "panel",
  "deepLink",
  "settings",
];

/** Each screen's title by its file name, for the screens a surface opens. */
export const screenTitles = (
  surfaces: readonly SurfaceSummary[]
): ReadonlyMap<string, string> => {
  const titles = new Map<string, string>();
  for (const kind of plainestFirst) {
    for (const surface of surfaces) {
      if (surface.kind === kind && !titles.has(surface.screen)) {
        titles.set(surface.screen, surface.title);
      }
    }
  }
  return titles;
};
