import {
  CodeIcon,
  FileDocIcon,
  FileIcon,
  ImageIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";

// A file's icon in an App's Code view (app-code.tsx), by its type.

/** The icon of a file's type, by its extension. */
const iconsByExtension: Readonly<Record<string, IconData>> = {
  ts: CodeIcon,
  tsx: CodeIcon,
  mts: CodeIcon,
  js: CodeIcon,
  jsx: CodeIcon,
  mjs: CodeIcon,
  sql: CodeIcon,
  html: CodeIcon,
  json: CodeIcon,
  yaml: CodeIcon,
  yml: CodeIcon,
  css: CodeIcon,
  md: FileDocIcon,
  txt: FileDocIcon,
  svg: ImageIcon,
};

/** The icon of the file at `path`, a plain file's for a type it doesn't know. */
export const fileIconOf = (path: string): IconData => {
  const dot = path.lastIndexOf(".");
  return (
    (dot === -1 ? undefined : iconsByExtension[path.slice(dot + 1)]) ?? FileIcon
  );
};
