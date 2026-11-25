// @vitest-environment happy-dom
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@grasp-os/ui/components/message";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { AnswerLinks } from "./answer-words.tsx";

// An answer as the thread draws it (a Message's response, under the
// thread's link rule): a link out of Grasp opens only once the person says
// so, and has no address on the page a middle click could follow; any
// other link, whatever its scheme, case or encoding, and a picture, is its
// words alone; raw HTML draws nothing.

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

/** A kept answer, `text`, once its Markdown has loaded. */
const shown = async (text: string): Promise<void> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <AnswerLinks>
          <Message>
            <MessageContent>
              <MessageResponse>{text}</MessageResponse>
            </MessageContent>
          </Message>
        </AnswerLinks>
      </I18nProvider>
    );
    await Promise.resolve();
  });
  // Markdown is fetched once an answer is drawn; until then, plain words.
  await vi.waitFor(() => {
    expect(
      document.querySelector('[data-slot="message-response"] > p:only-child')
    ).toBeNull();
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

/** What the question before leaving says, if it is open. */
const asked = (): string | undefined =>
  document.querySelector('[role="alertdialog"]')?.textContent ?? undefined;

/** What the answer draws that a press or the browser could follow or load. */
const followable = (): string[] =>
  [...document.querySelectorAll("a, button, img, script, iframe")].map(
    (element) => element.outerHTML
  );

describe(AnswerLinks, () => {
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

  it("opens a link out of Grasp only once the person says so, in a tab of its own", async () => {
    await shown("See [the policy](https://example.com/leave).");
    // No address on the page to follow past the question: a middle click,
    // or the browser's own "open link", has none.
    const addressed = document.querySelector("a[href]");
    await press(button("the policy"));
    const question = asked();
    await press(button("Cancel"));
    const afterCancel = [...opened];
    await press(button("the policy"));
    await press(button("Open link"));

    expect({
      addressed,
      question: /Open external link\?.*https:\/\/example\.com\/leave/u.test(
        question ?? ""
      ),
      afterCancel,
      opened,
    }).toStrictEqual({
      addressed: null,
      question: true,
      afterCancel: [],
      opened: [
        { url: "https://example.com/leave", features: "noopener,noreferrer" },
      ],
    });
  });

  it("asks before writing to an address, and before an address written in capitals", async () => {
    await shown(
      "Write to [Ann](mailto:ann@acme.test) or see [the form](HTTPS://Forms.Example/leave)."
    );
    await press(button("Ann"));
    const mail = asked();
    await press(button("Cancel"));
    await press(button("the form"));

    expect({
      mail: mail?.includes("mailto:ann@acme.test"),
      // Named as the browser will go there.
      form: asked()?.includes("https://forms.example/leave"),
      opened,
    }).toStrictEqual({ mail: true, form: true, opened: [] });
  });

  it("names where a link leads as the browser will go there, a look-alike host as its punycode, and opens that", async () => {
    // "paypal.com" with a Cyrillic a and y (U+0430, U+0443): another host.
    await shown("Log in at [PayPal](https://p\u0430\u0443pal.com/login).");
    await press(button("PayPal"));
    const question = asked() ?? "";
    await press(button("Open link"));

    expect({
      named: question.includes("https://xn--ppal-53d8i.com/login"),
      asWritten: question.includes("p\u0430\u0443pal.com"),
      opened,
    }).toStrictEqual({
      named: true,
      asWritten: false,
      opened: [
        {
          url: "https://xn--ppal-53d8i.com/login",
          features: "noopener,noreferrer",
        },
      ],
    });
  });

  it("asks before following a link to another host without a protocol", async () => {
    await shown("See [the form](//forms.example/leave).");
    const addressed = document.querySelector("a[href]");
    await press(button("the form"));

    expect({
      addressed,
      opened,
      asked: asked()?.includes("://forms.example/leave"),
    }).toStrictEqual({ addressed: null, opened: [], asked: true });
  });

  it("shows a link to a note or to an unsafe address as its words alone", async () => {
    await shown(
      'Leave is [sixteen weeks](grasp:note/doc-1 "Sixteen weeks"), [this](javascript:alert(1)) runs nothing and [that](data:text/html,hi) opens nothing.'
    );

    expect({
      followed: followable(),
      words: document.body.textContent.includes(
        "Leave is sixteen weeks, this runs nothing and that opens nothing."
      ),
    }).toStrictEqual({ followed: [], words: true });
  });

  it("shows an unsafe scheme in mixed case, or encoded, as its words alone", async () => {
    await shown(
      [
        "[one](JaVaScRiPt:alert(1))",
        "[two](java&#115;cript:alert(1))",
        "[three](&#x6A;avascript:alert(1))",
        "[four](java%73cript:alert(1))",
        "[five](DATA:text/html;base64,PHNjcmlwdD4=)",
        "[six](vbscript:msgbox(1))",
        "[seven](%20javascript:alert(1))",
      ].join(" ")
    );

    expect({
      followed: followable(),
      words: document.body.textContent.includes(
        "one two three four five six seven"
      ),
    }).toStrictEqual({ followed: [], words: true });
  });

  it("shows a relative link as its words alone, never a way inside Grasp", async () => {
    await shown(
      "Open [settings](/settings/ai), [the plan](plan.md) or [the top](#top)."
    );

    expect({
      followed: followable(),
      words: document.body.textContent.includes(
        "Open settings, the plan or the top."
      ),
    }).toStrictEqual({ followed: [], words: true });
  });

  it("draws no picture that would load: its alt words, also inside a link", async () => {
    await shown(
      "![A chart](https://example.com/chart.png)\n\n[![A logo](https://example.com/logo.png)](https://example.com)"
    );
    const pictures = document.querySelectorAll("img").length;
    await press(button("A logo"));

    expect({
      pictures,
      words: ["A chart", "A logo"].filter((words) =>
        document.body.textContent.includes(words)
      ),
      asked: asked()?.includes("https://example.com"),
    }).toStrictEqual({
      pictures: 0,
      words: ["A chart", "A logo"],
      asked: true,
    });
  });

  it("draws nothing of raw HTML", async () => {
    await shown(
      'Before <script>alert(1)</script><img src="https://example.com/t.png"> after\n\n<iframe src="https://example.com"></iframe>\n\n<a href="https://example.com">raw</a>'
    );

    expect({
      drawn: document.querySelector("script, img, iframe, a"),
      words: document.body.textContent.includes("Before"),
    }).toStrictEqual({ drawn: null, words: true });
  });
});
