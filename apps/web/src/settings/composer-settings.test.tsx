// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ComposerSettings } from "./composer-settings.tsx";

// The chat box at work, its look chosen beside it: one box at work in the
// chosen look, and a press on a colour or an edge keeps it for the person
// in this browser and shows it in the box at once.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const shown = (): void => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <ComposerSettings userId="ada" />
      </I18nProvider>
    );
  });
};

/** The choice a person knows by `name`. */
const choice = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll("button")].find(
    (button) => button.textContent.trim() === name
  );
  if (found === undefined) {
    throw new Error(`No ${name}`);
  }
  return found;
};

/** What shows: the choices pressed, and the edge the one box draws. */
const state = () => ({
  pressed: ["Light", "Mint", "Lavender", "Smooth", "Dither"].filter(
    (name) => choice(name).getAttribute("aria-pressed") === "true"
  ),
  boxes: document.querySelectorAll("[data-activity]").length,
  edge: document.querySelector<HTMLElement>("[data-edge]")?.dataset.edge,
});

describe(ComposerSettings, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    localStorage.clear();
    document.body.replaceChildren();
  });

  it("keeps the colour and the edge a person picks, and shows them in the one box at once", () => {
    shown();
    const first = state();
    act(() => {
      choice("Mint").click();
    });
    act(() => {
      choice("Dither").click();
    });

    expect({
      first,
      kept: localStorage.getItem("grasp-composer:ada"),
      picked: state(),
    }).toStrictEqual({
      first: { pressed: ["Light", "Smooth"], boxes: 1, edge: "smooth" },
      kept: "mint:dither",
      picked: { pressed: ["Mint", "Dither"], boxes: 1, edge: "dither" },
    });
  });
});
