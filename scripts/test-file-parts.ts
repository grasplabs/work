// Which part of a slow test run a test file holds, read from its own name.
//
// A run that took longer than a file should is split over files, each
// running one part: `<run>-<part>-of-<parts>.test.ts`, as
// `permission-probes-teams-bram-plain-1-of-2.test.ts`. Each file reads its
// part from its own name (`import.meta.url`), and the run's coverage test
// lists the files themselves (Vite's `import.meta.glob`) and checks that
// the parts they name are the whole run, each once. A file deleted or
// renamed then fails that test, where a list of the parts kept beside the
// files would still pass with a part no file runs.

/** A file's part of its run: `part` of `parts`, counted from 1. */
export interface FilePart {
  /** The file's name without its part and `.test.ts`. */
  run: string;
  part: number;
  parts: number;
}

const testFile = /^(?<stem>[\w-]+)\.test\.ts$/u;
const partOfRun = /^(?<run>.+)-(?<part>[1-9]\d*)-of-(?<parts>[1-9]\d*)$/u;

/**
 * The part of its run `file` (a path or URL) holds: from a name ending in
 * `-<part>-of-<parts>.test.ts`, or the whole run, 1 of 1, from one without.
 */
export const filePart = (file: string): FilePart => {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const stem = testFile.exec(name)?.groups?.stem;
  if (stem === undefined) {
    throw new Error(`${name} isn't a test file (<name>.test.ts)`);
  }
  const groups = partOfRun.exec(stem)?.groups;
  if (groups === undefined) {
    return { run: stem, part: 1, parts: 1 };
  }
  const part = Number(groups.part);
  const parts = Number(groups.parts);
  if (part > parts) {
    throw new Error(`${name} names part ${part} of only ${parts}`);
  }
  return { run: groups.run ?? stem, part, parts };
};

/**
 * Part `part` of `parts` of `items`, in their order: each part as many as
 * the first, the last the rest. Throws on a part that would hold none, so
 * no file passes for running nothing.
 */
export const partOf = <Item>(
  items: readonly Item[],
  { part, parts }: Pick<FilePart, "part" | "parts">
): Item[] => {
  const size = Math.ceil(items.length / parts);
  const held = items.slice((part - 1) * size, part * size);
  if (held.length === 0) {
    throw new RangeError(
      `Part ${part} of ${parts} of ${items.length} would hold nothing`
    );
  }
  return held;
};
