// @vitest-environment happy-dom
// React Fast Refresh must hook into React before React DOM loads (as the
// preview runtime orders it): the Refresh runtime is imported first, and
// React DOM only inside the test.
import {
  commit,
  discard,
  refresh,
  register,
} from "@grasp-os/sdk/preview-refresh";
import { previewReceiver } from "@grasp-os/sdk/preview-updates";
import type { ScreenComponent } from "@grasp-os/sdk/screen-runtime";
import { act, createElement, useState } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

// A chat's preview taking an update of its screen, with React and React
// Fast Refresh themselves: the screen's module evaluated (its components
// registered by file and name, as the compiler's instrumentation does),
// swapped in by Refresh, and its default export shown as the screen
// (screen-runtime.ts `ShownScreen`). The way it can fail: an update that
// renames the screen's component registers a family nothing renders, so
// Refresh swaps nothing, and the old screen stays while the update counts
// as applied. A component of the same name must keep its state.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** How many times a `Desk` was mounted, which its state remembers. */
let mounts = 0;

/** A desk screen saying `word`, whose state is the mount it was made in. */
const desk = (name: string, word: string) => {
  const Screen = () => {
    const [mount, setMount] = useState(() => {
      mounts += 1;
      return mounts;
    });
    // A click keeps it: state that is the screen's own, as a form's is.
    return createElement(
      "p",
      {
        onClick: () => {
          setMount(mount);
        },
      },
      `${word} (mount ${String(mount)})`
    );
  };
  // As the compiler's instrumentation registers it: its file and name.
  register(Screen, `screens/desk.tsx ${name}`);
  return { default: Screen };
};

/**
 * The screen's modules by their code, each evaluated anew as a browser
 * evaluates a new module address: new components, registered again.
 */
const modules: Record<string, () => { default: ScreenComponent }> = {
  first: () => desk("Desk", "First"),
  edited: () => desk("Desk", "Edited"),
  renamed: () => desk("RenamedDesk", "Renamed"),
};

/** The address of the module of `code`, as core would serve it. */
const addressOf = (code: string): string =>
  String(Object.keys(modules).indexOf(code)).repeat(64);

/** Each module's code, by its address. */
const addressed: Record<string, string> = Object.fromEntries(
  Object.keys(modules).map((code) => [addressOf(code), code])
);

let root: Root | undefined;

describe("a preview's screen as its updates come", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
  });

  it("shows a screen renamed in an update, and keeps the state of one only edited", async () => {
    const { createRoot } = await import("react-dom/client");
    const { ShownScreen } = await import("@grasp-os/sdk/screen-runtime");
    const container = document.createElement("div");
    document.body.append(container);
    // The screen as the frame first loaded it.
    const first = modules.first?.();
    commit();
    const showing: { screen?: (screen: ScreenComponent) => void } = {};
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(ShownScreen, {
          first: first?.default ?? (() => null),
          input: {},
          onShow: (show) => {
            showing.screen = show;
          },
        })
      );
    });
    const receive = previewReceiver({
      evaluate: async ({ entry }) => {
        await Promise.resolve();
        return modules[addressed[entry] ?? ""]?.();
      },
      commit,
      discard,
      refresh,
      show: (screen) => {
        showing.screen?.(screen);
      },
      renderFailures: () => 0,
      settle: async () => {
        await Promise.resolve();
      },
      css: () => "",
      setCss: () => {},
      report: () => {},
    });
    const shown = [container.textContent ?? ""];
    for (const code of ["edited", "renamed"]) {
      // oxlint-disable-next-line no-await-in-loop -- one update after another
      await act(async () => {
        await receive({ entry: addressOf(code), visit: 0, css: "" });
      });
      shown.push(container.textContent ?? "");
    }
    expect(shown).toStrictEqual([
      // As it opened, then edited: its state, its first mount.
      "First (mount 1)",
      "Edited (mount 1)",
      // Renamed: another component, mounted afresh, but shown.
      "Renamed (mount 2)",
    ]);
  });
});
