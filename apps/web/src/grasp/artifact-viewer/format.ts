// Which renderer a file opens in: from its MIME type, then its name's extension, then a look at
// its first bytes. A code file also gets its language, for highlighting.

export type ArtifactFormat =
  | "markdown"
  | "code"
  | "text"
  | "image"
  | "pdf"
  | "csv"
  | "html"
  | "unknown";

export interface DetectedFormat {
  format: ArtifactFormat;
  /** For code: Prism's name of the language. */
  language?: string;
}

// Extensions of code, to Prism's language names (worker/prism.ts).
const CODE: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  css: "css",
  scss: "css",
  html: "markup",
  xml: "markup",
  svg: "markup",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  go: "go",
  rs: "rust",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  diff: "diff",
  patch: "diff",
  toml: "toml",
};

const BY_EXTENSION: Record<string, ArtifactFormat> = {
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  txt: "text",
  text: "text",
  log: "text",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  avif: "image",
  svg: "image",
  pdf: "pdf",
  csv: "csv",
  tsv: "csv",
  html: "html",
  htm: "html",
};

// MIME types of code, to Prism's names.
const CODE_TYPES: Record<string, string> = {
  "application/json": "json",
  "application/javascript": "javascript",
  "text/javascript": "javascript",
  "application/typescript": "typescript",
  "text/x-python": "python",
  "text/css": "css",
  "application/xml": "markup",
  "text/xml": "markup",
  "application/x-sh": "bash",
  "text/x-diff": "diff",
  "application/yaml": "yaml",
  "text/yaml": "yaml",
};

const extensionOf = (name?: string) =>
  /\.(?<extension>[a-z0-9]+)$/iu
    .exec(name ?? "")
    ?.groups?.extension?.toLowerCase();

const byType = (type?: string): DetectedFormat | null => {
  const mime = type?.split(";")[0]?.trim().toLowerCase();
  if (
    mime === undefined ||
    mime === "" ||
    mime === "application/octet-stream"
  ) {
    return null;
  }
  if (mime === "text/markdown" || mime === "text/x-markdown") {
    return { format: "markdown" };
  }
  if (mime === "image/svg+xml" || mime.startsWith("image/")) {
    return { format: "image" };
  }
  if (mime === "application/pdf") {
    return { format: "pdf" };
  }
  if (mime === "text/csv" || mime === "text/tab-separated-values") {
    return { format: "csv" };
  }
  if (mime === "text/html") {
    return { format: "html" };
  }
  const language = CODE_TYPES[mime];
  if (language !== undefined && language !== "") {
    return { format: "code", language };
  }
  if (mime === "text/plain") {
    return { format: "text" };
  }
  return null;
};

const byName = (name?: string): DetectedFormat | null => {
  const extension = extensionOf(name);
  if (extension === undefined || extension === "") {
    return null;
  }
  const format = BY_EXTENSION[extension];
  if (format) {
    return { format };
  }
  const language = CODE[extension];
  return language !== undefined && language !== ""
    ? { format: "code", language }
    : null;
};

const starts = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  signature.every((byte, index) => bytes[at + index] === byte);

// Signs of Markdown on any line, not only the first: a heading, a list, a fence, a quote, a table's
// rule, a link or bold words. Pasted Markdown often starts with a plain sentence.
const MARKDOWN_SIGNS = [
  /^#{1,6} \S/mu,
  /^\s{0,3}(?:[-*+]|\d{1,3}[.)]) \S/mu,
  /^\s{0,3}(?:```|~~~)/mu,
  /^\s{0,3}> \S/mu,
  /^\|?\s*:?-{3,}:?\s*\|/mu,
  /\[[^\]\n]+\]\([^)\s]+\)/u,
  /\*\*[^*\n]+\*\*/u,
];

/** Whether text reads as Markdown: one clear sign is enough, as plain text shown rendered loses nothing. */
export const looksLikeMarkdown = (text: string) => {
  const sample = text.slice(0, 4096);
  return MARKDOWN_SIGNS.some((sign) => sign.test(sample));
};

// Text that opens with a comment or a block-level tag is a page (or a piece of one) an agent wrote.
const HTML_START =
  /^<(?:!--|(?:head|body|style|div|section|article|main|header|footer|nav|table|form|template|meta|link|title|h[1-6]|ul|ol)[\s>/])/u;

/** The format from the first bytes alone: the signature of a binary format, or a look at text. */
export const sniff = (bytes: Uint8Array): DetectedFormat => {
  // %PDF
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46])) {
    return { format: "pdf" };
  }
  // PNG
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47])) {
    return { format: "image" };
  }
  // JPEG
  if (starts(bytes, [0xff, 0xd8, 0xff])) {
    return { format: "image" };
  }
  // GIF8
  if (starts(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return { format: "image" };
  }
  // WebP: RIFF, then WEBP at byte 8.
  if (
    starts(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { format: "image" };
  }
  let text: string;
  try {
    // `stream` keeps a character cut at the end of the sample from reading as an error.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
      stream: true,
    });
  } catch {
    return { format: "unknown" };
  }
  const head = text.trimStart().slice(0, 256).toLowerCase();
  if (
    head.startsWith("<svg") ||
    (head.startsWith("<?xml") && head.includes("<svg"))
  ) {
    return { format: "image" };
  }
  // A whole page is HTML. A piece of one is HTML unless it reads as Markdown, which often starts with
  // a little HTML of its own (a centred README header, a comment that turns a linter off).
  if (/^<(?:!doctype html|html|head|body)[\s>]/u.test(head)) {
    return { format: "html" };
  }
  if (looksLikeMarkdown(text)) {
    return { format: "markdown" };
  }
  if (HTML_START.test(head)) {
    return { format: "html" };
  }
  return { format: "text" };
};

/** The format of a file: its MIME type first, then its name, then its first bytes. */
export const detectFormat = ({
  type,
  name,
  head,
}: {
  type?: string;
  name?: string;
  head?: Uint8Array;
}): DetectedFormat => {
  // A plain-text MIME type says little: a name with an extension says more.
  const fromType = byType(type);
  const fromName = byName(name);
  if (fromType && !(fromType.format === "text" && fromName)) {
    return fromType;
  }
  if (fromName) {
    return fromName;
  }
  return head ? sniff(head) : { format: "unknown" };
};

/** Formats read as text before they open. */
export const isText = (format: ArtifactFormat) =>
  format === "markdown" ||
  format === "code" ||
  format === "text" ||
  format === "csv" ||
  format === "html";
