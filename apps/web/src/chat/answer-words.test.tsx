// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { AnswerWords } from "./answer-words.tsx";

// An answer as the thread draws it: its Markdown with nothing of raw HTML
// or a picture that would load; a link out of Grasp that opens only once
// the person says so; and a link to a note or an unsafe address as its
// words alone.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;
let opened: { url: string; features: string }[] = [];

/** Lets the page's work run. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** A stored answer, `text`. */
const shown = async (text: string): Promise<void> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <AnswerWords text={text} writing={false} />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  await settled();
};

const press = async (element: HTMLElement | undefined): Promise<void> => {
  if (element === undefined) {
    throw new Error("Nothing to press");
  }
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** The button named `name`, by its label or its words. */
const button = (name: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name ||
      element.textContent.trim() === name
  );

describe(AnswerWords, () => {
  beforeEach(() => {
    window.open = (url?: string | URL, _target?: string, features?: string) => {
      opened.push({ url: String(url), features: features ?? "" });
      return null;
    };
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    opened = [];
    document.body.replaceChildren();
  });

  it("shows a link to a note or to an unsafe address as its words alone", async () => {
    await shown(
      'Leave is [sixteen weeks](grasp:note/doc-1 "Sixteen weeks"), [this](javascript:alert(1)) runs nothing and [that](data:text/html,hi) opens nothing.'
    );

    expect({
      followed: document.querySelector("a, button"),
      words: document.body.textContent.includes(
        "Leave is sixteen weeks, this runs nothing and that opens nothing."
      ),
    }).toStrictEqual({ followed: null, words: true });
  });

  it("asks before following a link to another host without a protocol", async () => {
    await shown("See [the form](//forms.example/leave).");
    const addressed = document.querySelector("a[href]");
    await press(button("the form"));

    expect({
      addressed,
      opened,
      asked: (
        document.querySelector("[role=alertdialog]")?.textContent ?? ""
      ).includes("//forms.example/leave"),
    }).toStrictEqual({ addressed: null, opened: [], asked: true });
  });

  it("draws nothing of raw HTML, and no picture that would load", async () => {
    await shown(
      'Before <script>alert(1)</script><img src="https://example.com/t.png"> after\n\n![A chart](https://example.com/chart.png)\n\n<iframe src="https://example.com"></iframe>'
    );

    expect({
      drawn: document.querySelector("script, img, iframe"),
      words: ["Before", "A chart"].filter((words) =>
        document.body.textContent.includes(words)
      ),
    }).toStrictEqual({ drawn: null, words: ["Before", "A chart"] });
  });
});
