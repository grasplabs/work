// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PlainMarkdown } from "./markdown.tsx";

// Markdown someone else wrote, as an export's page draws it: nothing in
// it runs or loads, and a link leaves in a tab of its own.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** `text` drawn. */
const draw = async (text: string): Promise<HTMLElement> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <PlainMarkdown text={text} />
      </I18nProvider>
    );
    await Promise.resolve();
  });
  return host;
};

const linkNamed = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll("a")].find((link) =>
    link.textContent.startsWith(name)
  );

describe(PlainMarkdown, () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("drops raw HTML, and leaves an unsafe link as words", async () => {
    const host = await draw(
      [
        "[Run this](javascript:alert(1)) and [the law](https://example.com/law).",
        "",
        '<img src="https://example.com/pixel.png" onerror="alert(1)">',
        "",
        "Inline <b>bold</b> too.",
      ].join("\n")
    );
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toMatch(
      /^Run this and the law[^<>]*\.Inline bold too\.$/u
    );
    expect(linkNamed(host, "Run this")).toBeUndefined();
  });

  it("opens a link in a tab of its own, without this page as its opener", async () => {
    const host = await draw("See [the law](https://example.com/law).\n");
    const law = linkNamed(host, "the law");
    expect(law?.getAttribute("target")).toBe("_blank");
    expect(law?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
