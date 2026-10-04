import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { bodyOf, PlainMarkdown } from "../knowledge/markdown.tsx";

// What every export in Grasp can become, by the person's choice: a
// Markdown file, or a PDF. A PDF is made by the browser's own print dialog
// (Save as PDF), from the Markdown set as an A4 page in Geist, as in the
// prototype (`lib/export-file.ts`); no PDF is drawn in the app itself.
//
// The page to print is a frame of this origin, so it keeps this page's
// Content Security Policy: no inline script or style. Its look comes from
// the app's own stylesheets, linked again inside it, and its text is
// rendered by React from here, as safely as an answer in the chat
// (`PlainMarkdown`: no raw HTML, safe links only, no images).

export type ExportFormat = "md" | "pdf";

export interface ExportFile {
  /** The file's name without its extension: "pricing". */
  name: string;
  /** Its title: the PDF's heading, and the name the print dialog offers. */
  title: string;
  /** The Markdown, made when the person asks for it. */
  markdown: () => string;
}

/** How long a download's address is kept: some browsers read the file only after the click returns. */
const downloadKeptMs = 60_000;

/** Saves `text` as `fileName` in the person's downloads. */
export const downloadText = (
  fileName: string,
  text: string,
  type: string
): void => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  // Let go once the browser surely has it, as FileSaver.js does.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, downloadKeptMs);
};

/** `body` without a first `# heading` that only repeats `title`. */
const withoutTitle = (body: string, title: string): string => {
  const [first = "", ...rest] = body.trimStart().split("\n");
  return first.trim() === `# ${title}` ? rest.join("\n") : body;
};

/** The page an export prints: its title, then its Markdown, on A4. */
const PrintPage = ({
  title,
  markdown,
}: {
  title: string;
  markdown: string;
}) => (
  <main className="page-export bg-background text-foreground flex flex-col gap-3 font-sans text-sm leading-relaxed">
    <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
    <PlainMarkdown text={withoutTitle(bodyOf(markdown), title)} />
  </main>
);

/** Waits for `link` to load, or to fail: either way the page can print. */
const loadOf = async (link: HTMLLinkElement): Promise<void> => {
  const loaded = Promise.withResolvers<boolean>();
  link.addEventListener("load", () => {
    loaded.resolve(true);
  });
  link.addEventListener("error", () => {
    loaded.resolve(true);
  });
  await loaded.promise;
};

/**
 * Opens the print dialog for `file` as an A4 page, where the person saves
 * it as a PDF. The frame it prints from is gone once the dialog closes.
 */
export const printAsPdf = async (
  file: ExportFile,
  locale: string
): Promise<void> => {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.title = file.title;
  frame.className = "pointer-events-none fixed top-0 left-0 size-0 opacity-0";
  document.body.append(frame);
  const view = frame.contentWindow;
  const page = frame.contentDocument;
  if (view === null || page === null) {
    frame.remove();
    return;
  }
  page.documentElement.lang = locale;
  page.title = file.title;
  const links = [
    ...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  ].map((link) => {
    const copy = page.createElement("link");
    copy.rel = "stylesheet";
    copy.href = link.href;
    page.head.append(copy);
    return copy;
  });
  const root = createRoot(page.body);
  flushSync(() => {
    root.render(<PrintPage markdown={file.markdown()} title={file.title} />);
  });
  await Promise.all(links.map(loadOf));
  // Geist first, or the PDF falls back to the system's font.
  await page.fonts.ready;
  const done = (): void => {
    root.unmount();
    frame.remove();
  };
  view.addEventListener("afterprint", done, { once: true });
  view.focus();
  view.print();
};

/** Exports `file` as the person chose: a Markdown file, or a PDF to save. */
export const exportAs = async (
  file: ExportFile,
  format: ExportFormat,
  locale: string
): Promise<void> => {
  if (format === "md") {
    downloadText(
      `${file.name}.md`,
      file.markdown(),
      "text/markdown;charset=utf-8"
    );
    return;
  }
  await printAsPdf(file, locale);
};
