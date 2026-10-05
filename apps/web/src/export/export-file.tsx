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

/** A backslash and what it escapes, as Markdown writes a character it would read as syntax. */
const escaped = /\\(?<character>[!-/:-@[-`{-~])/gu;

/**
 * `body` without a first `# heading` that only repeats `title`, its escapes
 * undone to compare (a chat's title with Markdown's characters in it is
 * written escaped); any other first line stays as written.
 */
const withoutTitleLine = (body: string, title: string): string => {
  const [first = "", ...rest] = body.split("\n");
  return first.trim().replaceAll(escaped, "$<character>") === `# ${title}`
    ? rest.join("\n").trim()
    : body;
};

/** The page an export prints: its title, then its Markdown, on A4. */
const PrintPage = ({
  title,
  markdown,
}: {
  title: string;
  markdown: string;
}) => (
  <main className="page-export bg-card text-foreground flex flex-col gap-3 font-sans text-sm leading-relaxed">
    <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
    <PlainMarkdown
      text={withoutTitleLine(bodyOf(markdown).trimStart(), title)}
    />
  </main>
);

/** How long the page waits for its stylesheets and font before it prints anyway. */
const styledWithinMs = 5000;

/** Waits for `work`, but no longer than `styledWithinMs`. */
const withinTime = async (work: Promise<unknown>): Promise<void> => {
  const late = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => {
    late.resolve(false);
  }, styledWithinMs);
  await Promise.race([work, late.promise]);
  clearTimeout(timer);
};

/** Resolves when `target` fires `event`, or after `styledWithinMs`. */
const eventOrTimeout = async (
  target: EventTarget,
  event: string
): Promise<void> => {
  const fired = Promise.withResolvers<boolean>();
  target.addEventListener(
    event,
    () => {
      fired.resolve(true);
    },
    { once: true }
  );
  await withinTime(fired.promise);
};

/** The page being printed, if one is: one at a time. */
let printing: { remove: () => void } | undefined;

/**
 * Opens the print dialog for `file` as an A4 page, where the person saves
 * it as a PDF. The frame it prints from goes once the dialog closes, or,
 * where a browser never says so, when this page has the focus again; the
 * focus goes back to where it was.
 */
export const printAsPdf = async (
  file: ExportFile,
  locale: string
): Promise<void> => {
  printing?.remove();
  const returnFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.title = file.title;
  frame.className = "pointer-events-none fixed top-0 left-0 size-0 opacity-0";
  // Some browsers replace the frame's first empty page with another as it
  // loads: what is written into it waits for that.
  const loaded = eventOrTimeout(frame, "load");
  document.body.append(frame);
  if (frame.contentDocument?.readyState !== "complete") {
    await loaded;
  }
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
  let removed = false;
  const remove = (): void => {
    if (removed) {
      return;
    }
    removed = true;
    window.removeEventListener("focus", remove);
    root.unmount();
    frame.remove();
    if (printing?.remove === remove) {
      printing = undefined;
    }
    returnFocus?.focus();
  };
  printing = { remove };
  flushSync(() => {
    root.render(<PrintPage markdown={file.markdown()} title={file.title} />);
  });
  await Promise.all(
    links.map(async (link) => {
      await eventOrTimeout(link, "load");
    })
  );
  // Laid out, so the page asks for Geist; then Geist, or the PDF falls back
  // to the system's font.
  page.body.getBoundingClientRect();
  await withinTime(page.fonts.load('1em "Geist Variable"'));
  await withinTime(page.fonts.ready);
  if (removed) {
    return;
  }
  view.addEventListener("afterprint", remove, { once: true });
  view.focus();
  view.print();
  window.addEventListener("focus", remove, { once: true });
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
