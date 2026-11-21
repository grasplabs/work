// PDF.js's worker file carries no types of its own. On the page (no Worker allowed) PDF.js reads
// only its message handler from it (pdfjs.ts).
declare module "pdfjs-dist/build/pdf.worker.min.mjs" {
  export const WorkerMessageHandler: unknown;
}
