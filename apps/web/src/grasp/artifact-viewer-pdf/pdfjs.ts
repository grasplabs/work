// PDF.js, imported only here: this file is in the PDF renderer's chunk and nowhere else. Its
// worker is PDF.js's own prebuilt file, served as it ships: the URL below is resolved by the
// bundler (Vite, webpack 5 and Next.js all read `new URL(path, import.meta.url)`) and the file is
// copied next to the app's other assets. Where the page allowed Workers (`allowWorkers()`),
// PDF.js starts it as a module Worker, so parsing a PDF never holds up the page; otherwise the same
// file runs on the page, given to PDF.js before it opens anything, so it never tries a Worker.
import { GlobalWorkerOptions } from "pdfjs-dist";

import { workersAllowed } from "../artifact-viewer/worker/client";

GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

/** Readies PDF.js before it opens a file: on the page, unless Workers are allowed. */
export const readyPdfJs = async () => {
  if (workersAllowed() || "pdfjsWorker" in globalThis) {
    return;
  }
  Object.assign(globalThis, {
    pdfjsWorker: await import("pdfjs-dist/build/pdf.worker.min.mjs"),
  });
};

export { getDocument, PixelsPerInch, TextLayer } from "pdfjs-dist";
export type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
export type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api";
