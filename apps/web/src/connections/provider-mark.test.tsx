// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ProviderMark } from "./provider-mark.tsx";

// Which mark an app gets beside its name: the logo the server provides;
// where it provides none, the product's own drawing for a connector whose
// id is exactly one it has; else the neutral first letter, as for a logo
// that doesn't load. A name or an id that only starts like a brand's gets
// the letter.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

/** What the mark of `props` draws: the served image, the own drawing, or the letter. */
const drawn = (props: ComponentProps<typeof ProviderMark>) => {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <ProviderMark {...props} />
      </I18nProvider>
    );
  });
  const shown = () => ({
    image: host.querySelector("img")?.getAttribute("src") ?? null,
    drawing: host.querySelector("svg") !== null,
    letter: host.querySelector("[data-fallback]")?.textContent.trim() ?? null,
  });
  return { host, shown };
};

describe("an app's mark", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
  });

  it("is the logo the server provides, even for a connector the product draws", () => {
    const { shown } = drawn({
      id: "microsoft",
      name: "Microsoft 365",
      logo: "https://logos.example/microsoft.svg",
    });

    expect(shown()).toStrictEqual({
      image: "https://logos.example/microsoft.svg",
      drawing: false,
      letter: null,
    });
  });

  it("is the product's own drawing only where the server has none and the id is exactly the connector's", () => {
    const own = drawn({ id: "microsoft", name: "Microsoft 365", logo: null });
    const ownShown = own.shown();
    act(() => {
      root?.unmount();
    });
    const near = drawn({
      id: "microsoft-teams",
      name: "Microsoft Teams",
      logo: null,
    });

    expect({ own: ownShown, near: near.shown() }).toStrictEqual({
      own: { image: null, drawing: true, letter: null },
      near: { image: null, drawing: false, letter: "M" },
    });
  });

  it("is the neutral letter where the server's logo doesn't load", () => {
    const { host, shown } = drawn({
      id: "google",
      name: "Google Workspace",
      logo: "https://logos.example/missing.svg",
    });
    act(() => {
      host.querySelector("img")?.dispatchEvent(new Event("error"));
    });

    expect(shown()).toStrictEqual({ image: null, drawing: false, letter: "G" });
  });
});
