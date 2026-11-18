// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { DocumentMarkdown } from "./markdown.tsx";

// A Knowledge document as the page draws it: nothing in it runs or loads,
// and a `[[link]]` to a document of the collection opens it here, while
// one in code, or to a path the page doesn't know, stays as written.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;

const paths = new Map([["handbook/pay.md", "doc-pay"]]);

/** The document drawn on its collection's page. */
const draw = async (text: string): Promise<HTMLElement> => {
  const rootRoute = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => rootRoute,
    path: "/knowledge/$collection",
    component: () => (
      <DocumentMarkdown
        resolve={(path) => paths.get(path)}
        text={text}
        title="Leave"
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/knowledge/handbook"] }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nProvider>
    );
    await router.load();
  });
  return host;
};

/** The document's text, as an `<article>`. */
const drawArticle = async (text: string): Promise<HTMLElement> => {
  const host = await draw(text);
  const article = host.querySelector("article");
  if (article === null) {
    throw new Error("The document wasn't drawn.");
  }
  return article;
};

const linkNamed = (article: HTMLElement, name: string) =>
  [...article.querySelectorAll("a")].find((link) =>
    link.textContent?.startsWith(name)
  );

describe("a document's text", () => {
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    document.body.replaceChildren();
  });

  it("drops raw HTML, and leaves an unsafe link as words", async () => {
    const article = await drawArticle(
      [
        "# Leave",
        "",
        "[Run this](javascript:alert(1)) and [the law](https://example.com/law).",
        "",
        '<img src="https://example.com/pixel.png" onerror="alert(1)">',
        "",
        "Inline <b>bold</b> too.",
      ].join("\n")
    );
    expect(article.querySelector("img")).toBeNull();
    expect(article.textContent).toMatch(
      /^Run this and the law[^<>]*\.Inline bold too\.$/u
    );
    expect(linkNamed(article, "Run this")).toBeUndefined();
  });

  it("opens a link that leaves in a tab of its own, and leaves out the title the page shows", async () => {
    const article = await drawArticle(
      "# Leave\n\nSee [the law](https://example.com/law).\n"
    );
    const law = linkNamed(article, "the law");
    expect(law?.getAttribute("target")).toBe("_blank");
    expect(law?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(article.querySelector("h1")).toBeNull();
  });

  it("opens a `[[link]]` it knows here, and leaves any other as written", async () => {
    const article = await drawArticle(
      [
        "Paid as in [[handbook/pay|the pay policy]]; see [[handbook/gone]].",
        "",
        "`[[handbook/pay]]` is how to write one.",
      ].join("\n")
    );
    const pay = linkNamed(article, "the pay policy");
    expect(pay?.getAttribute("href")).toBe("/knowledge/handbook?doc=doc-pay");
    expect(pay?.getAttribute("target")).toBeNull();
    expect(article.textContent).toContain("[[handbook/gone]]");
    expect(article.querySelector("code")?.textContent).toBe("[[handbook/pay]]");
  });

  it("says when it is empty", async () => {
    const host = await draw("# Leave\n");
    expect(host.querySelector("article")).toBeNull();
    expect(host.textContent).toContain("This document is empty.");
  });
});
