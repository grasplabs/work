// @vitest-environment happy-dom
import { Toaster } from "@grasp-os/ui/components/toast";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { AnswerMarkdown } from "./answer-markdown.tsx";

// An answer as the thread renders it: a code block highlighted, with a
// button that copies its code; a table that copies as Markdown, CSV or
// TSV and downloads as CSV or Markdown, all in the browser; a link out of
// Grasp that opens only once the person says so; and, as before, nothing
// of raw HTML or an image that would load.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;
let copied: string[] = [];
let downloaded: { name: string; text: string }[] = [];
let opened: { url: string; features: string }[] = [];

/** The answer `text`, rendered; again, as it streams on, where it was. */
const shown = async (text: string): Promise<void> => {
  if (root === undefined) {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  const rendered = root;
  await act(async () => {
    rendered.render(
      <I18nProvider i18n={i18n}>
        <Toaster>
          <AnswerMarkdown text={text} />
        </Toaster>
      </I18nProvider>
    );
    await Promise.resolve();
  });
};

/** Lets every pending promise and render settle. */
const settled = async (): Promise<void> => {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    setTimeout(() => {
      resolve(true);
    }, 0);
    await promise;
  });
};

const press = async (element: HTMLElement): Promise<void> => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** The button named `name`, by its label or its text. */
const button = (name: string): HTMLElement => {
  const found = [
    ...document.querySelectorAll<HTMLElement>("button, [role='menuitem']"),
  ].find(
    (element) =>
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name
  );
  if (found === undefined) {
    throw new Error(`No button ${name}`);
  }
  return found;
};

describe(AnswerMarkdown, () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          await Promise.resolve();
          copied.push(text);
        },
      },
    });
    // A download is a link to the file, clicked: what it would save is read
    // from the file the page made, and its name from the link.
    const files = new Map<string, Blob>();
    URL.createObjectURL = (blob: Blob) => {
      const url = `blob:test/${files.size}`;
      files.set(url, blob);
      return url;
    };
    HTMLAnchorElement.prototype.click = function click(
      this: HTMLAnchorElement
    ) {
      const file = files.get(this.href);
      if (file === undefined) {
        // Any other link is clicked as a person clicks it.
        this.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true })
        );
        return;
      }
      void file.text().then((text) => {
        downloaded.push({ name: this.download, text });
      });
    };
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
    copied = [];
    downloaded = [];
    opened = [];
    document.body.replaceChildren();
  });

  it("highlights a code block in the language it names, and copies its code", async () => {
    await shown("```ts\nconst days = 25;\n```");
    const figure = document.querySelector("figure");
    expect(figure?.textContent).toContain("ts");
    expect(figure?.querySelector(".hljs-keyword")?.textContent).toBe("const");
    expect(figure?.querySelector(".hljs-number")?.textContent).toBe("25");

    await press(button("Copy code"));
    expect(copied).toStrictEqual(["const days = 25;"]);
    expect(button("Copied")).toBeDefined();
  });

  it("copies a table as Markdown, CSV and TSV", async () => {
    await shown(
      '| Name | Days |\n| --- | --- |\n| Ann, "A" | 25 |\n| Bo \\| B | 20 |'
    );
    for (const format of ["Markdown", "CSV", "TSV"]) {
      // oxlint-disable-next-line no-await-in-loop -- one menu after the other
      await press(button("Copy table"));
      // oxlint-disable-next-line no-await-in-loop -- see above
      await press(button(`Copy table as ${format}`));
    }
    expect(copied).toStrictEqual([
      '| Name | Days |\n| --- | --- |\n| Ann, "A" | 25 |\n| Bo \\| B | 20 |',
      'Name,Days\r\n"Ann, ""A""",25\r\nBo | B,20',
      'Name\tDays\nAnn, "A"\t25\nBo | B\t20',
    ]);
  });

  it("downloads a table as CSV and as Markdown", async () => {
    await shown("| Name | Days |\n| --- | --- |\n| Ann | 25 |");
    await press(button("Download table"));
    await press(button("Download table as CSV"));
    await press(button("Download table"));
    await press(button("Download table as Markdown"));
    await settled();
    expect(downloaded).toStrictEqual([
      { name: "table.csv", text: "Name,Days\r\nAnn,25" },
      {
        name: "table.md",
        text: "| Name | Days |\n| --- | --- |\n| Ann | 25 |",
      },
    ]);
  });

  it("downloads a would-be formula as text, and a negative number as a number", async () => {
    await shown(
      '| Name | Days |\n| --- | --- |\n| =HYPERLINK("https://example.com") | -5 |\n| @SUM(A1) | +2 |'
    );
    await press(button("Download table"));
    await press(button("Download table as CSV"));
    await settled();
    expect(downloaded).toStrictEqual([
      {
        name: "table.csv",
        text: 'Name,Days\r\n"\'=HYPERLINK(""https://example.com"")",-5\r\n\'@SUM(A1),+2',
      },
    ]);
  });

  it("copies a would-be formula as text in TSV too", async () => {
    await shown("| Name | Days |\n| --- | --- |\n| =1+1 | -5 |");
    await press(button("Copy table"));
    await press(button("Copy table as TSV"));
    expect(copied).toStrictEqual(["Name\tDays\n'=1+1\t-5"]);
  });

  it("copies a cell as it reads: an image's alt text, and code's characters escaped", async () => {
    await shown(
      "| Chart | Code |\n| --- | --- |\n| ![Leave chart](https://example.com/c.png) | `*literal*` and a \\\\ |"
    );
    await press(button("Copy table"));
    await press(button("Copy table as Markdown"));
    expect(copied).toStrictEqual([
      "| Chart | Code |\n| --- | --- |\n| Leave chart | \\*literal\\* and a \\\\ |",
    ]);
  });

  it("keeps a table's menu and a link's question open as the answer streams on", async () => {
    const start =
      "See [the policy](https://example.com/leave).\n\n| A |\n| --- |\n| 1 |";
    await shown(start);
    await press(button("the policy"));
    await shown(`${start}\n\nMore`);
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

    await press(button("Cancel"));
    await press(button("Copy table"));
    await shown(`${start}\n\nMore of it`);
    expect(button("Copy table as CSV")).toBeDefined();
  });

  it("opens a link out of Grasp only once the person says so", async () => {
    await shown("See [the policy](https://example.com/leave).");
    // No address on the page to follow past the question: a middle click,
    // or the browser's own "open link", has none.
    expect(document.querySelector("a[href]")).toBeNull();
    const link = button("the policy");
    await press(link);
    expect(opened).toStrictEqual([]);
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toMatch(
      /Open external link\?.*https:\/\/example\.com\/leave/u
    );

    await press(button("Cancel"));
    expect(opened).toStrictEqual([]);

    await press(link);
    await press(button("Open link"));
    expect(opened).toStrictEqual([
      { url: "https://example.com/leave", features: "noopener,noreferrer" },
    ]);
  });

  it("renders nothing of raw HTML, and no image that would load", async () => {
    await shown(
      'Before <script>alert(1)</script><img src="https://example.com/t.png"> after\n\n![A chart](https://example.com/chart.png)\n\n<iframe src="https://example.com"></iframe>'
    );
    expect(document.querySelector("script, img, iframe")).toBeNull();
    expect(document.body.textContent).toContain("Before");
    expect(document.body.textContent).toContain("A chart");
  });
});
