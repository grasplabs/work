import { zipSync } from "fflate";

/** A Word file holding `paragraphs`, as the extractor reads one. */
export const wordFile = (paragraphs: string[]): Uint8Array<ArrayBuffer> => {
  const encoder = new TextEncoder();
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
    .join("");
  return Uint8Array.from(
    zipSync({
      "word/document.xml": encoder.encode(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
      ),
      "word/styles.xml": encoder.encode(
        `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`
      ),
    })
  );
};
