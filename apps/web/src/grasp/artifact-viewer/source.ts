// Opens a file from wherever it is: a URL, a File or Blob, or a string of its text. Text formats
// are read as text; every format keeps its Blob and an object URL, for images and the download.
import { detectFormat, isText } from "./format";
import type { DetectedFormat } from "./format";
import type { ArtifactViewerLabels } from "./types";

/** The type of text given with none: a value, not words. */
const PLAIN = "text/plain";

/** Where the file comes from: exactly one of `src`, `file` or `text`. */
export interface ArtifactSource {
  /** A URL to fetch the file from. */
  src?: string;
  /** A File or a Blob the page already has. */
  file?: Blob;
  /** The file's text itself. */
  text?: string;
  /** The file's name, shown in the toolbar and used for the download. */
  name?: string;
  /** Its MIME type, when known: the first thing the format is read from. */
  type?: string;
  /** For code: the language, when the name does not say. */
  language?: string;
}

export interface OpenedArtifact extends DetectedFormat {
  name: string;
  blob: Blob;
  /**
   * The blob's address, for an image and the download: a data: URL for an image (a page whose
   * policy takes pictures only from itself and data: refuses a blob: one), else an object URL.
   * Revoke it with `close()`.
   */
  url: string;
  /** The text, for text formats. */
  text?: string;
  close: () => void;
}

/** The words opening a file may show: a name for a file with none, and why it did not load. */
export type OpenWords = Pick<
  ArtifactViewerLabels,
  "untitled" | "loadFailed" | "noSource"
>;

const nameOf = (source: ArtifactSource, untitled: string) =>
  source.name ??
  (source.file instanceof File ? source.file.name : undefined) ??
  source.src?.split(/[?#]/u)[0]?.split("/").pop() ??
  untitled;

// A task of its own: the caller's task (a React commit) ends first.
const nextTask = async () => {
  // oxlint-disable-next-line promise/avoid-new -- a timer has no promise of its own
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};

// An image's data: URL, read off the page's thread.
const dataUrl = async (blob: Blob) =>
  // oxlint-disable-next-line promise/avoid-new -- FileReader has no promise of its own
  await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(typeof reader.result === "string" ? reader.result : "");
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("unreadable"));
    });
    reader.readAsDataURL(blob);
  });

// The file's address and how to let it go: an image's is a data: URL (revoking one does nothing),
// any other file's an object URL.
const addressOf = async (blob: Blob, image: boolean) => {
  const url = image ? await dataUrl(blob) : URL.createObjectURL(blob);
  return {
    url,
    close: () => {
      URL.revokeObjectURL(url);
    },
  };
};

/** Opens the file. Rejects when it does not load; `signal` stops a load that is no longer wanted. */
export const openArtifact = async (
  source: ArtifactSource,
  words: OpenWords,
  signal?: AbortSignal
): Promise<OpenedArtifact> => {
  let blob: Blob;
  let { type } = source;
  if (source.text !== undefined) {
    // Copying a long text into a Blob takes a while (about 12ms for 50,000 lines): not in the
    // task that mounted the viewer, which is long enough already.
    await nextTask();
    blob = new Blob([source.text], { type: type ?? PLAIN });
  } else if (source.file) {
    blob = source.file;
    type ??= source.file.type || undefined;
  } else if (source.src !== undefined && source.src !== "") {
    const response = await fetch(source.src, { signal });
    if (!response.ok) {
      throw new Error(words.loadFailed(response.status));
    }
    blob = await response.blob();
    type ??= response.headers.get("content-type") ?? undefined;
  } else {
    throw new Error(words.noSource);
  }
  const name = nameOf(source, words.untitled);
  // Enough of the start to tell a format by: a signature, or Markdown after a long first paragraph.
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const detected = detectFormat({ type, name, head });
  if (source.language !== undefined && source.language !== "") {
    detected.format = "code";
    detected.language = source.language;
  }
  // An image is drawn by its type: an SVG without one would not show at all.
  if (detected.format === "image") {
    const svg =
      /\.svg$/iu.test(name) ||
      new TextDecoder()
        .decode(head)
        .trimStart()
        .toLowerCase()
        .startsWith("<svg") ||
      blob.type === "image/svg+xml";
    if (svg && blob.type !== "image/svg+xml") {
      blob = new Blob([blob], { type: "image/svg+xml" });
    }
  }
  const text =
    source.text ?? (isText(detected.format) ? await blob.text() : undefined);
  return {
    ...detected,
    name,
    blob,
    text,
    ...(await addressOf(blob, detected.format === "image")),
  };
};
