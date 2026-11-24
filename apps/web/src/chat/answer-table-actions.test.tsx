// @vitest-environment happy-dom
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { AnswerTableActions } from "./answer-table-actions.tsx";

// An answer's tables, beside its Copy: each copies as Markdown, CSV or
// TSV and downloads as CSV or Markdown, all in the browser, as main's chat
// offered over each table. A would-be formula goes out as text.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | undefined;
let copied: string[] = [];
let downloaded: { name: string; text: string }[] = [];

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

/** The actions of an answer that says `text`. */
const shown = async (text: string): Promise<void> => {
  const host = document.createElement("div");
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <I18nProvider i18n={i18n}>
        <AnswerTableActions text={text} />
      </I18nProvider>
    );
    await Promise.resolve();
  });
};

/** The button or menu item named `name`, by its label or its words. */
const control = (name: string): HTMLElement => {
  const found = [
    ...document.querySelectorAll<HTMLElement>("button, [role='menuitem']"),
  ].find(
    (element) =>
      element.getAttribute("aria-label") === name ||
      element.textContent.trim() === name
  );
  if (found === undefined) {
    throw new Error(`No control ${name}`);
  }
  return found;
};

const press = async (name: string): Promise<void> => {
  const element = control(name);
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await settled();
};

/** Picks `item` from the menu `menu` opens. */
const pick = async (menu: string, item: string): Promise<void> => {
  await press(menu);
  await press(item);
};

describe(AnswerTableActions, () => {
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
      if (file !== undefined) {
        void file.text().then((text) => {
          downloaded.push({ name: this.download, text });
        });
      }
    };
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = undefined;
    copied = [];
    downloaded = [];
    document.body.replaceChildren();
  });

  it("offers nothing for an answer without a table", async () => {
    await shown("Leave is **sixteen** weeks.");

    expect(document.querySelectorAll("button")).toHaveLength(0);
  });

  it("copies a table as Markdown, CSV and TSV", async () => {
    await shown(
      'Here:\n\n| Name | Days |\n| --- | --- |\n| Ann, "A" | 25 |\n| Bo \\| B | 20 |'
    );
    await pick("Copy table", "Copy table as Markdown");
    await pick("Copy table", "Copy table as CSV");
    await pick("Copy table", "Copy table as TSV");

    expect(copied).toStrictEqual([
      '| Name | Days |\n| --- | --- |\n| Ann, "A" | 25 |\n| Bo \\| B | 20 |',
      'Name,Days\r\n"Ann, ""A""",25\r\nBo | B,20',
      'Name\tDays\nAnn, "A"\t25\nBo | B\t20',
    ]);
  });

  it("downloads a table as CSV and as Markdown", async () => {
    await shown("| Name | Days |\n| --- | --- |\n| Ann | 25 |");
    await pick("Download table", "Download table as CSV");
    await pick("Download table", "Download table as Markdown");
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
    await pick("Download table", "Download table as CSV");
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
    await pick("Copy table", "Copy table as TSV");

    expect(copied).toStrictEqual(["Name\tDays\n'=1+1\t-5"]);
  });

  it("copies a cell as it reads: a picture's alt words, and code's characters escaped", async () => {
    await shown(
      "| Chart | Code |\n| --- | --- |\n| ![Leave chart](https://example.com/c.png) | `*literal*` and a \\\\ |"
    );
    await pick("Copy table", "Copy table as Markdown");

    expect(copied).toStrictEqual([
      "| Chart | Code |\n| --- | --- |\n| Leave chart | \\*literal\\* and a \\\\ |",
    ]);
  });

  it("names each table of an answer with more than one by the heading above it, else its place", async () => {
    await shown(
      "## Leave by team\n\n| Team | Days |\n| --- | --- |\n| Sales | 20 |\n\nAnd:\n\n| Year | Days |\n| --- | --- |\n| 2026 | 25 |"
    );
    await press("Copy table");
    const groups = [
      ...document.querySelectorAll('[role="menu"] [role="group"]'),
    ].map((group) => group.textContent);
    const [, second] = document.querySelectorAll<HTMLElement>(
      '[role="menu"] [role="group"]'
    );
    const csv = [
      ...(second?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? []),
    ].find((item) => item.textContent.trim() === "Copy table as CSV");
    await act(async () => {
      csv?.click();
      await Promise.resolve();
    });
    await settled();

    expect({ groups, copied }).toStrictEqual({
      groups: [
        "Leave by teamCopy table as MarkdownCopy table as CSVCopy table as TSV",
        "Table 2Copy table as MarkdownCopy table as CSVCopy table as TSV",
      ],
      copied: ["Year,Days\r\n2026,25"],
    });
  });
});
