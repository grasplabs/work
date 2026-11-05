import { describe, expect, it } from "vite-plus/test";

import {
  ModuleNotLoadedError,
  notLoaded,
  previewReceiver,
} from "../src/preview-updates.ts";
import type { PreviewFrame } from "../src/preview-updates.ts";
import type { PreviewLoad } from "../src/screen-runtime.ts";

// A chat's preview's frame taking its draft's updates: the ways it can
// fail, from its threat model (preview-updates.ts): a version that names
// anything but a module address of the frame's own, an update that
// doesn't evaluate, one that evaluates but fails to render, and one
// Refresh can't take. React Fast Refresh and the browser's module loader
// are outside: the frame here stands in for them, and its modules
// "render" what the test says each address renders.

/** What the modules render: a word, `throw`, or `syntax error`. */
const renders = ["one", "two", "throw", "syntax error"];

/** A module's address: core's hash of it, here one per thing it renders. */
const address = (what: string): string =>
  String(renders.indexOf(what)).repeat(64);

/** What each address renders. */
const rendered = new Map(renders.map((what) => [address(what), what]));

/** A version of the screen whose module renders `what`, as the page sends one. */
const load = (what: string, visit = 0): PreviewLoad => ({
  entry: address(what),
  visit,
  css: `.${what}{}`,
});

const screen = (): null => null;

/** A frame whose modules render what their address says. */
const fakeFrame = () => {
  const imported: string[] = [];
  const reported: string[] = [];
  const seen = { screen: "opened", css: ".opened{}", imported, reported };
  let staged = "";
  let failures = 0;
  const frame: PreviewFrame = {
    evaluate: async ({ entry, visit }) => {
      await Promise.resolve();
      seen.imported.push(`${visit}/${entry}`);
      const what = rendered.get(entry) ?? "";
      if (what === "syntax error") {
        throw new SyntaxError("Unexpected token");
      }
      staged = what;
      return { default: screen };
    },
    commit: () => {
      if (staged.startsWith("throw")) {
        failures += 1;
        seen.screen = "error boundary";
      } else if (staged !== "") {
        seen.screen = staged;
      }
      staged = "";
    },
    discard: () => {
      staged = "";
    },
    refresh: () => true,
    show: () => {},
    renderFailures: () => failures,
    settle: async () => {
      await Promise.resolve();
    },
    css: () => seen.css,
    setCss: (css) => {
      seen.css = css;
    },
    report: (value) => {
      seen.reported.push(value instanceof Error ? value.message : "?");
    },
  };
  return { frame, seen };
};

describe("a preview's frame taking its draft's updates", () => {
  it("swaps in each version it is handed, at its module's address and visit", async () => {
    const { frame, seen } = fakeFrame();
    const receive = previewReceiver(frame);
    const answers = [await receive(load("one")), await receive(load("two", 3))];
    expect({ answers, seen }).toStrictEqual({
      answers: ["applied", "applied"],
      seen: {
        screen: "two",
        css: ".two{}",
        imported: [`0/${address("one")}`, `3/${address("two")}`],
        reported: [],
      },
    });
  });

  it("imports nothing but a module address of its own", async () => {
    const { frame, seen } = fakeFrame();
    const receive = previewReceiver(frame);
    const honest = load("one");
    const answers = await Promise.all(
      [
        { ...honest, entry: "https://elsewhere.example/evil.js" },
        { ...honest, entry: `../${address("one")}` },
        { ...honest, entry: "A".repeat(64) },
        { ...honest, visit: -1 },
        { ...honest, visit: 1.5 },
        { ...honest, css: undefined },
        null,
      ].map(async (asked) => await receive(asked))
    );
    expect({ answers, imported: seen.imported }).toStrictEqual({
      answers: Array.from({ length: 7 }, () => "refused"),
      imported: [],
    });
  });

  it("keeps the version it shows when an update doesn't evaluate, its CSS too, and says why", async () => {
    const { frame, seen } = fakeFrame();
    const receive = previewReceiver(frame);
    await receive(load("one"));
    const broken = await receive(load("syntax error"));
    expect({
      broken,
      screen: seen.screen,
      css: seen.css,
      reported: seen.reported,
    }).toStrictEqual({
      broken: "failed",
      screen: "one",
      css: ".one{}",
      reported: ["Unexpected token"],
    });
  });

  it("says when an update evaluated and failed to render, for the page to swap the last version back", async () => {
    const { frame, seen } = fakeFrame();
    const receive = previewReceiver(frame);
    await receive(load("one"));
    const failing = await receive(load("throw"));
    const back = await receive(load("one", 1));
    expect({ failing, back, screen: seen.screen }).toStrictEqual({
      failing: "broken",
      back: "applied",
      screen: "one",
    });
  });

  it("asks for a fresh start once React Fast Refresh can't go on", async () => {
    const { frame } = fakeFrame();
    const receive = previewReceiver({ ...frame, refresh: () => false });
    await expect(receive(load("one"))).resolves.toBe("reset");
  });

  it("asks for a fresh start, reporting nothing of the draft, when the module doesn't load", async () => {
    const { frame, seen } = fakeFrame();
    const receive = previewReceiver({
      ...frame,
      // As after hours open: core refuses the frame's expired token.
      evaluate: async () => {
        await Promise.resolve();
        throw new ModuleNotLoadedError("The screen's module didn't load.");
      },
    });
    await receive(load("one"));
    const answer = await receive(load("two"));
    expect({ answer, seen }).toStrictEqual({
      answer: "reset",
      seen: { screen: "opened", css: ".opened{}", imported: [], reported: [] },
    });
  });

  it("tells a module that didn't load, in each engine's words, from the screen's own code throwing", () => {
    const directory = `https://acme.grasp.test/screen-modules/${"d".repeat(64)}/`;
    const imported = `${directory}${"e".repeat(64)}.js?token=1.x`;
    expect({
      chromium: notLoaded(
        new TypeError(
          `Failed to fetch dynamically imported module: ${imported}`
        ),
        directory
      ),
      firefox: notLoaded(
        new TypeError(`error loading dynamically imported module: ${imported}`),
        directory
      ),
      webkit: notLoaded(
        new TypeError("Importing a module script failed."),
        directory
      ),
      ownTypeError: notLoaded(
        new TypeError("Cannot read properties of undefined (reading 'x')"),
        directory
      ),
      ownSyntax: notLoaded(new SyntaxError("Unexpected token"), directory),
      thrownValue: notLoaded(imported, directory),
    }).toStrictEqual({
      chromium: true,
      firefox: true,
      webkit: true,
      ownTypeError: false,
      ownSyntax: false,
      thrownValue: false,
    });
  });
});
