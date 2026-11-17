// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ComposerSettings } from "./composer-settings.tsx";

// The chat box at work, chosen by sight: each tile is a box at work in
// its look, and a press keeps that look for the person in this browser,
// its colour and its edge apart.

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

/** The tile a person knows by `name`. */
const tile = (name: string): HTMLLabelElement => {
  const found = [...document.querySelectorAll("label")].find(
    (label) => label.lastElementChild?.textContent === name
  );
  if (found === undefined) {
    throw new Error(`No ${name}`);
  }
  return found;
};

/** Chooses the tile `name`. */
const choose = (name: string): void => {
  act(() => {
    tile(name).querySelector("input")?.click();
  });
};

/** What each tile is, as drawn: chosen, and the edge its box draws. */
const tiles = () =>
  ["Light", "Mint", "Lavender", "Smooth", "Dither"].map((name) => ({
    name,
    chosen: tile(name).querySelector("input")?.checked,
    edge: tile(name).querySelector<HTMLElement>("[data-edge]")?.dataset.edge,
  }));

describe(ComposerSettings, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    localStorage.clear();
    document.body.replaceChildren();
  });

  it("keeps the colour and the edge a person picks, each tile a box at work in its look", async () => {
    shown();
    const first = tiles();
    choose("Mint");
    choose("Dither");
    await act(async () => {
      await Promise.resolve();
    });

    expect({
      first,
      kept: localStorage.getItem("grasp-composer:ada"),
      picked: tiles(),
    }).toStrictEqual({
      first: [
        { name: "Light", chosen: true, edge: "smooth" },
        { name: "Mint", chosen: false, edge: "smooth" },
        { name: "Lavender", chosen: false, edge: "smooth" },
        { name: "Smooth", chosen: true, edge: "smooth" },
        { name: "Dither", chosen: false, edge: "dither" },
      ],
      kept: "mint:dither",
      picked: [
        { name: "Light", chosen: false, edge: "dither" },
        { name: "Mint", chosen: true, edge: "dither" },
        { name: "Lavender", chosen: false, edge: "dither" },
        { name: "Smooth", chosen: false, edge: "smooth" },
        { name: "Dither", chosen: true, edge: "dither" },
      ],
    });
  });
});
