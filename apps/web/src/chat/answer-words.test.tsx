// @vitest-environment happy-dom
import type { ChatCitedDocument } from "@grasp-os/shared/chat";
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
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { AnswerWords } from "./answer-words.tsx";
import { AnswerCited, useCitedDocuments } from "./sources.tsx";

// An answer as the thread draws it, against core's chats as the page
// reaches them over RPC, faked: its Markdown with nothing of raw HTML or a
// picture that would load; a link out of Grasp that opens only once the
// person says so; and, where core says the answer cites documents, each
// cited span marked with its source's number, the documents listed under
// it in that order, each opening on its collection's page.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;
let opened: { url: string; features: string }[] = [];

/** A stored answer's words, with what core says it cites. */
const Stored = ({ text }: { text: string }) => (
  <AnswerWords cited={useCitedDocuments()} text={text} writing={false} />
);

/** Lets the page's work after a core answer run. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

/** Answer 7 of a chat, `text`, which core says cites `cited`. */
const shown = async (text: string, cited: ChatCitedDocument[] = []) => {
  const asked: string[] = [];
  const chats = {
    cited: async (chat: string, message: number) => {
      asked.push(`${chat}/${message}`);
      await Promise.resolve();
      return cited;
    },
  };
  const core = {
    withSession: async <T,>(
      action: (session: { chats: typeof chats }) => Promise<T>
    ): Promise<T> => await action({ chats }),
  };
  const rootRoute = createRootRoute({ component: Outlet });
  const answer = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <AnswerCited cited={{ chatId: "chat", messageId: 7 }}>
        <Stored text={text} />
      </AnswerCited>
    ),
  });
  const collection = createRoute({
    getParentRoute: () => rootRoute,
    path: "/knowledge/$collection",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([answer, collection]),
    history: createMemoryHistory(),
    context: { core },
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
  await settled();
  return { router, asked };
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

const leave: ChatCitedDocument = {
  documentId: "leave",
  collectionId: "handbook",
  title: "Parental leave",
  path: "leave.md",
  snippet: "Parental leave lasts sixteen weeks.",
  spans: [],
};

const plan: ChatCitedDocument = {
  documentId: "plan",
  collectionId: "plans",
  title: "Route plan",
  path: "routes/plan.md",
  snippet: "Where the route goes, and when.",
  spans: [],
};

/** What the hover card of the citation named `name` shows, once it opens. */
const cardOf = async (name: string): Promise<string> => {
  const citation = document.querySelector<HTMLElement>(
    `[aria-label="${name}"]`
  );
  if (citation === null) {
    throw new Error(`No citation ${name}`);
  }
  await act(async () => {
    for (const type of [
      "pointerenter",
      "mouseenter",
      "pointermove",
      "mousemove",
    ]) {
      citation.dispatchEvent(
        new PointerEvent(type, {
          bubbles: type.endsWith("move"),
          pointerType: "mouse",
        })
      );
    }
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 400);
    await promise;
  });
  // The card this citation opened: the latest, should another still be leaving.
  const card =
    [...document.querySelectorAll("[data-slot=source-card]")].at(-1)
      ?.textContent ?? "";
  await act(async () => {
    for (const type of ["pointerleave", "mouseleave"]) {
      citation.dispatchEvent(new PointerEvent(type, { pointerType: "mouse" }));
    }
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 400);
    await promise;
  });
  return card;
};

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

  it("marks each span an answer cites with its source's number, and lists the documents under it, each opening on its collection's page", async () => {
    const { router, asked } = await shown(
      "The [route](grasp:note/plan) and [sixteen weeks](grasp:note/leave), not [Travel](grasp:note/travel).",
      [plan, leave]
    );
    const marked = [
      ...document.querySelectorAll<HTMLElement>("[data-slot=claim]"),
    ].map((claim) => ({
      words: claim.textContent,
      source: claim.dataset.source,
    }));
    const citations = [
      ...document.querySelectorAll("[data-slot=hover-card-trigger]"),
    ].map((citation) => citation.getAttribute("aria-label"));
    // A note the answer doesn't cite: its words alone, nothing to follow.
    const travel = [...document.querySelectorAll("p span")].find(
      (span) => span.textContent === "Travel"
    );

    await press(
      document.querySelector<HTMLElement>("[data-slot=source-pile]") ??
        undefined
    );
    const listed = [...document.querySelectorAll("li")].map(
      (item) => item.textContent
    );
    await press(button("Parental leave"));

    expect({
      asked,
      marked,
      citations,
      travel: travel?.closest("a, button") ?? null,
      listed,
      at: router.state.location.pathname,
      search: { ...router.state.location.search },
    }).toStrictEqual({
      asked: ["chat/7"],
      marked: [
        { words: "route", source: "1" },
        { words: "sixteen weeks", source: "2" },
      ],
      citations: ["Source 1: Route plan", "Source 2: Parental leave"],
      travel: null,
      listed: ["Route plan1routes/plan.md", "Parental leave2leave.md"],
      at: "/knowledge/handbook",
      search: { doc: "leave" },
    });
  });

  it("lists nothing under an answer core says cites nothing it may show, and keeps its words", async () => {
    await shown("Leave lasts [sixteen weeks](grasp:note/leave).");

    expect({
      words: document.body.textContent,
      listed: document.querySelector("[data-slot=source-pile], ol") !== null,
      marked: document.querySelector("[data-slot=claim]") !== null,
    }).toStrictEqual({
      words: "Leave lasts sixteen weeks.",
      listed: false,
      marked: false,
    });
  });

  it("opens a link out of Grasp only once the person says so", async () => {
    await shown("See [the policy](https://example.com/leave).");
    // No address on the page to follow past the question: a middle click,
    // or the browser's own "open link", has none.
    const addressed = document.querySelector("a[href^='http']");
    await press(button("the policy"));
    const asked = /Open external link\?.*https:\/\/example\.com\/leave/u.test(
      document.querySelector("[role=alertdialog]")?.textContent ?? ""
    );
    await press(button("Cancel"));
    const cancelled = [...opened];
    await press(button("the policy"));
    await press(button("Open link"));

    expect({ addressed, asked, cancelled, opened }).toStrictEqual({
      addressed: null,
      asked: true,
      cancelled: [],
      opened: [
        { url: "https://example.com/leave", features: "noopener,noreferrer" },
      ],
    });
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

  it("shows in a citation's card the passage it rests on, as core checked it, and nothing for a quote core didn't keep", async () => {
    const quoted: ChatCitedDocument = {
      ...leave,
      spans: [
        {
          at: 12,
          text: "sixteen weeks",
          quote: "Leave lasts sixteen weeks, paid.",
        },
        { at: 80, text: "unpaid", quote: null },
      ],
    };
    await shown(
      'Leave lasts [sixteen weeks](grasp:note/leave "Leave lasts sixteen   weeks, paid."), and is [unpaid](grasp:note/leave "Unpaid, always.").',
      [quoted]
    );

    const first = await cardOf("Source 1, first mention: Parental leave");
    const second = await cardOf("Source 1, second mention: Parental leave");

    expect({
      first: first.includes("Leave lasts sixteen weeks, paid."),
      second: [second.includes("Unpaid, always."), second.includes("paid.")],
      start: first.includes("Parental leave lasts sixteen weeks."),
    }).toStrictEqual({ first: true, second: [false, false], start: false });
  });
});
