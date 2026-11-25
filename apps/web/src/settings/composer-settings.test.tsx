// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ComposerSettings } from "./composer-settings.tsx";

// Settings › Appearance's Chat box: the box at work in the person's look,
// its colour and its edge chosen as segments, kept in this browser for
// that person alone.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const shown = (userId: string): HTMLElement => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <ComposerSettings userId={userId} />
      </I18nProvider>
    );
  });
  return host;
};

const close = (): void => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

/** Where the box stands, as its form says it: at work. */
const boxOf = (host: HTMLElement) => host.querySelector("form")?.dataset.status;

/** Presses the segment that says `words`. */
const press = (host: HTMLElement, words: string): void => {
  const segment = [...host.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === words
  );
  if (segment === undefined) {
    throw new TypeError(`No segment ${words}`);
  }
  act(() => {
    segment.click();
  });
};

/** The segments pressed, by their words. */
const pressed = (host: HTMLElement): string[] =>
  [...host.querySelectorAll("button[aria-pressed=true]")].map(
    (each) => each.textContent?.trim() ?? ""
  );

describe("the chat box's look in Settings › Appearance", () => {
  afterEach(() => {
    close();
    localStorage.clear();
  });

  it("shows the box at work, and keeps the colour and edge chosen for that person alone", () => {
    const first = shown("user-ann");
    const before = { pressed: pressed(first), box: boxOf(first) };
    press(first, "Lavender");
    press(first, "Dither");
    const after = { pressed: pressed(first), box: boxOf(first) };
    close();
    const again = pressed(shown("user-ann"));
    close();
    const someoneElse = pressed(shown("user-bo"));

    expect({ before, after, again, someoneElse }).toStrictEqual({
      before: {
        pressed: ["Light", "Smooth"],
        box: "streaming",
      },
      after: {
        pressed: ["Lavender", "Dither"],
        box: "streaming",
      },
      again: ["Lavender", "Dither"],
      someoneElse: ["Light", "Smooth"],
    });
  });
});
