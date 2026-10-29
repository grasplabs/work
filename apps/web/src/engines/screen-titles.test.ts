import type { SurfaceKind, SurfaceSummary } from "@grasp-os/shared/screens";
import { describe, expect, it } from "vite-plus/test";

import { screenTitles } from "./screen-titles.ts";

// What a domain's apps are called on its page (screen-titles.ts): the
// title of a surface that opens the screen, the plainest place first.

const surface = (
  screen: string,
  kind: SurfaceKind,
  title: string
): SurfaceSummary => ({
  name: `${screen}-${kind}`,
  kind,
  title,
  route: screen,
  screen,
  opensEmpty: true,
});

describe("an app's title", () => {
  it("is its surface's title", () => {
    const titles = screenTitles([surface("notes", "sidebar", "All notes")]);
    expect(titles.get("notes")).toBe("All notes");
  });

  it("is the sidebar's, then a panel's, a deep link's and the settings' last, whatever their order", () => {
    const titles = screenTitles([
      surface("note", "deepLink", "Shared note"),
      surface("note", "panel", "Peek"),
      surface("prefs", "settings", "Preferences"),
      surface("home", "settings", "Settings"),
      surface("home", "deepLink", "Home link"),
      surface("list", "panel", "Beside"),
      surface("list", "sidebar", "Everything"),
    ]);
    expect(titles.get("note")).toBe("Peek");
    expect(titles.get("prefs")).toBe("Preferences");
    expect(titles.get("home")).toBe("Home link");
    expect(titles.get("list")).toBe("Everything");
  });

  it("is missing for a screen no surface opens", () => {
    expect(screenTitles([]).get("counter")).toBeUndefined();
  });
});
