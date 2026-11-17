// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ThemeSwitch } from "../grasp/theme-switch/index.ts";
import { PersonTheme, usePersonTheme } from "./person-theme.tsx";
import { chooseTheme, readTheme, readThemeId } from "./theme.ts";

// The person's mode and colours as Settings › Appearance (the Theme
// switch) and the Sidebar's Appearance (which reads usePersonTheme and
// keeps its choice with chooseTheme) see them: one choice, kept for the
// person, on <html> at once, the same in both places.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** What the Sidebar's Appearance shows: the mode it reads. */
const MenuMode = ({ userId }: { userId: string }) => (
  <output>{usePersonTheme(userId).mode}</output>
);

const opened = async (userId: string) => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <PersonTheme userId={userId}>
        <ThemeSwitch variant="picker" label="Mode" themesLabel="Colours" />
        <MenuMode userId={userId} />
      </PersonTheme>
    );
    await Promise.resolve();
  });
  return host;
};

/** The radio of `value` in the group named `group`. */
const radio = (host: HTMLElement, group: string, value: string) => {
  const found = host
    .querySelector(`[role="radiogroup"][aria-label="${group}"]`)
    ?.querySelector<HTMLInputElement>(`input[value="${value}"]`);
  if (found === null || found === undefined) {
    throw new Error(`No ${value} in ${group}`);
  }
  return found;
};

describe("a person's appearance", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("is kept for the person and shown at once when chosen in Settings", async () => {
    const host = await opened("ada");
    await act(async () => {
      radio(host, "Colours", "pine").click();
      radio(host, "Mode", "dark").click();
      await Promise.resolve();
    });
    expect({
      kept: { mode: readTheme("ada"), theme: readThemeId("ada") },
      shown: {
        mode: document.documentElement.dataset.graspMode,
        theme: document.documentElement.dataset.graspTheme,
      },
      menu: host.querySelector("output")?.textContent,
    }).toStrictEqual({
      kept: { mode: "dark", theme: "pine" },
      shown: { mode: "dark", theme: "pine" },
      menu: "dark",
    });
  });

  it("follows a mode chosen in the Sidebar's menu", async () => {
    const host = await opened("ada");
    await act(async () => {
      chooseTheme("ada", "light");
      await Promise.resolve();
    });
    expect({
      checked: radio(host, "Mode", "light").checked,
      shown: document.documentElement.dataset.graspMode,
    }).toStrictEqual({ checked: true, shown: "light" });
  });
});
