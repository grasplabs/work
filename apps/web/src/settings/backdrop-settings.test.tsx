// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { BackdropSettings } from "./backdrop-settings.tsx";

// The chat background, chosen by sight: a tile press keeps that look for
// the person in this browser and, for a dither, offers its patterns and
// colours; Randomize keeps another look.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const shown = (): void => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <BackdropSettings userId="ada" />
      </I18nProvider>
    );
  });
};

/** The radio a person knows by `name`. */
const radio = (name: string): HTMLInputElement => {
  const found = [...document.querySelectorAll("label")].find(
    (label) => label.textContent === name
  );
  const input = found?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`No ${name}`);
  }
  return input;
};

/** The look kept for Ada in this browser. */
const kept = (): string | null => localStorage.getItem("grasp-backdrop:ada");

/** The rows' names shown. */
const rows = (): string[] =>
  [...document.querySelectorAll("legend")].map(
    (legend) => legend.textContent ?? ""
  );

describe(BackdropSettings, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    localStorage.clear();
    document.body.replaceChildren();
  });

  it("keeps the background pressed, and offers a dither's patterns and colours", () => {
    shown();
    const before = rows();
    act(() => {
      radio("Dusk").click();
    });
    const dusk = { look: kept(), rows: rows() };
    act(() => {
      radio("Lime").click();
    });

    expect({ before, dusk, lime: kept() }).toStrictEqual({
      before: ["Background"],
      dusk: {
        look: "dusk:bayer:aurora",
        rows: ["Background", "Pattern", "Colour"],
      },
      lime: "dusk:bayer:lime",
    });
  });

  it("randomizes to another background", () => {
    shown();
    const button = [...document.querySelectorAll("button")].find(
      (each) => each.textContent === "Randomize"
    );
    act(() => {
      button?.click();
    });
    const backdrop = kept()?.split(":")[0];

    expect(
      backdrop !== undefined && !["sand", "none"].includes(backdrop)
    ).toBeTruthy();
  });
});
