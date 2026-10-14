import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { chooseTheme, readTheme } from "./theme.ts";

// The theme a person chooses, kept in this browser, and theme.js, which
// paints it before the app runs. Tests run in Node: a browser here is its
// storage, its document's root class and the system's colour scheme.

const themeScript = readFileSync(
  new URL("../../public/theme.js", import.meta.url),
  "utf-8"
);

/** What blocked storage does on every read and write. */
const refuse = (): never => {
  throw new DOMException("Blocked", "SecurityError");
};

/** A browser's localStorage, or one that refuses every call (blocked). */
const storage = (blocked = false): Storage => {
  const kept = new Map<string, string>();
  return {
    get length() {
      return kept.size;
    },
    clear: () => {
      kept.clear();
    },
    key: (index) => [...kept.keys()][index] ?? null,
    getItem: (key) => (blocked ? refuse() : (kept.get(key) ?? null)),
    setItem: (key, value) => {
      if (blocked) {
        refuse();
      }
      kept.set(key, value);
    },
    removeItem: (key) => {
      kept.delete(key);
    },
  };
};

/** A browser tab: its storage, its document, and whether the system is dark. */
const browser = ({
  systemDark = false,
  blocked = false,
  localStorage = storage(blocked),
} = {}) => {
  const classes = new Set<string>();
  const document = Object.assign(new EventTarget(), {
    documentElement: {
      classList: {
        toggle: (name: string, on: boolean) => {
          if (on) {
            classes.add(name);
          } else {
            classes.delete(name);
          }
        },
      },
    },
  });
  const window = new EventTarget();
  const matchMedia = () =>
    Object.assign(new EventTarget(), { matches: systemDark });
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  return {
    localStorage,
    isDark: () => classes.has("dark"),
    /** Loads the page: theme.js runs, as in <head>. */
    load: () => {
      runInNewContext(themeScript, {
        localStorage,
        matchMedia,
        document,
        addEventListener: window.addEventListener.bind(window),
      });
    },
  };
};

const restoreGlobals = (): void => {
  vi.unstubAllGlobals();
};

describe("a person's theme", () => {
  afterEach(restoreGlobals);

  it("is the system's until they choose", () => {
    browser();
    expect(readTheme("ada")).toBe("system");
  });

  it("is kept for each person apart in one browser", () => {
    browser();
    chooseTheme("ada", "dark");
    chooseTheme("grace", "light");
    expect(readTheme("ada")).toBe("dark");
    expect(readTheme("grace")).toBe("light");
    expect(readTheme("alan")).toBe("system");
  });

  it("reads as the system's when what is kept is no theme", () => {
    const { localStorage } = browser();
    localStorage.setItem("grasp-theme:ada", "sepia");
    expect(readTheme("ada")).toBe("system");
  });

  it("follows the system where storage is blocked", () => {
    const tab = browser({ blocked: true, systemDark: true });
    chooseTheme("ada", "light");
    expect(readTheme("ada")).toBe("system");
    tab.load();
    expect(tab.isDark()).toBeTruthy();
  });
});

describe("theme.js", () => {
  afterEach(restoreGlobals);

  it("follows the system when nobody chose", () => {
    const light = browser();
    light.load();
    expect(light.isDark()).toBeFalsy();
    const dark = browser({ systemDark: true });
    dark.load();
    expect(dark.isDark()).toBeTruthy();
  });

  it("paints the choice made last before the app runs, over the system's", () => {
    const before = browser({ systemDark: true });
    chooseTheme("ada", "light");
    const reloaded = browser({
      systemDark: true,
      localStorage: before.localStorage,
    });
    reloaded.load();
    expect(reloaded.isDark()).toBeFalsy();
  });

  it("applies a choice at once, without a reload", () => {
    const tab = browser();
    tab.load();
    chooseTheme("ada", "dark");
    expect(tab.isDark()).toBeTruthy();
    chooseTheme("ada", "system");
    expect(tab.isDark()).toBeFalsy();
  });
});
