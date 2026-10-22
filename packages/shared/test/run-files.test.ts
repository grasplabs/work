import { describe, expect, it } from "vite-plus/test";

import { runFileTypeOf } from "../src/run-files.ts";

// The type a file someone else made shows (GRA-886): by its bytes, never
// by the label it came with, which only picks between types the bytes are
// both and names a text type for bytes with no signature. Pure logic.

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0);
const docx =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("the run-file type of a file someone else made", () => {
  it("is its signature's, whatever its label says, and a text type its label names only for bytes with no signature", () => {
    expect({
      pdfLabelledText: runFileTypeOf(text("%PDF-1.7"), "text/plain"),
      pngUnlabelled: runFileTypeOf(
        bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
        null
      ),
      csv: runFileTypeOf(text("a,b"), "text/csv; charset=utf-8"),
      csvShouting: runFileTypeOf(text("a,b"), " TEXT/CSV "),
      textLabelledPdf: runFileTypeOf(text("plain"), "application/pdf"),
      textUnlabelled: runFileTypeOf(text("plain"), null),
      html: runFileTypeOf(text("<p>"), "text/html"),
    }).toStrictEqual({
      pdfLabelledText: "application/pdf",
      pngUnlabelled: "image/png",
      csv: "text/csv",
      csvShouting: "text/csv",
      textLabelledPdf: undefined,
      textUnlabelled: undefined,
      html: undefined,
    });
  });

  it("takes a ZIP as the Office document its label names, and as none otherwise", () => {
    expect({
      docx: runFileTypeOf(zip, docx),
      zip: runFileTypeOf(zip, "application/zip"),
      unlabelled: runFileTypeOf(zip, null),
    }).toStrictEqual({ docx, zip: undefined, unlabelled: undefined });
  });
});
