import { Code, Doc, File as FileIcon, Image } from "../grasp/icons/index.ts";
import type { IconData } from "../grasp/icons/index.ts";

// A file's icon in an App's Code view (app-code.tsx), by its type.

/** The icon of a file's type, by its extension. */
const iconsByExtension: Readonly<Record<string, IconData>> = {
  ts: Code,
  tsx: Code,
  mts: Code,
  js: Code,
  jsx: Code,
  mjs: Code,
  sql: Code,
  html: Code,
  json: Code,
  yaml: Code,
  yml: Code,
  css: Code,
  md: Doc,
  txt: Doc,
  svg: Image,
};

/** The icon of the file at `path`, a plain file's for a type it doesn't know. */
export const fileIconOf = (path: string): IconData => {
  const dot = path.lastIndexOf(".");
  return (
    (dot === -1 ? undefined : iconsByExtension[path.slice(dot + 1)]) ?? FileIcon
  );
};
