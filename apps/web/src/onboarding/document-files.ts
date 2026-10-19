// Which dropped files the onboarding takes as documents (document-drop.tsx).
// Pure.

/** What Grasp reads, by extension; anything else is refused with a shake. */
export const readable = [
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "txt",
  "md",
  "csv",
] as const;

export const extensionOf = (name: string): string =>
  name.toLowerCase().split(".").pop() ?? "";

/**
 * The files of one drop, paste or pick that are read, and how many are
 * refused for being of a kind Grasp can't read. A file named like one
 * shared before is read too: core keeps them as two documents, and a
 * second "Procedures.pdf" is often another one. Only the same file twice
 * in one drop is read once.
 */
export const filesToRead = <
  T extends { name: string; size: number; lastModified: number },
>(
  files: readonly T[]
): { fresh: T[]; refused: number } => {
  const known = files.filter((file) =>
    readable.some((extension) => extension === extensionOf(file.name))
  );
  const fresh = known.filter(
    (file, at, all) =>
      all.findIndex(
        (other) =>
          other.name === file.name &&
          other.size === file.size &&
          other.lastModified === file.lastModified
      ) === at
  );
  return { fresh, refused: files.length - known.length };
};
