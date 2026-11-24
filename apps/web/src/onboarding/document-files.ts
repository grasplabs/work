// Which files the setup takes as documents: the documents step's upload,
// and the place picker. Pure.

import { uploadTypes } from "@grasp-os/shared/uploads";

/**
 * What Grasp takes, by extension; anything else is refused.
 * Every type core reads (`uploadTypes`), and the old Office formats, which
 * core refuses with the way out: save it as a newer file.
 */
export const readable: readonly string[] = [
  ...Object.keys(uploadTypes),
  "doc",
  "xls",
  "ppt",
];

export const extensionOf = (name: string): string =>
  name.toLowerCase().split(".").pop() ?? "";
