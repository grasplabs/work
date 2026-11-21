import { isGeneratedServerFile } from "@grasp-os/runtime/host";
import type { AppFiles, ViewedApp } from "@grasp-os/shared/apps";
import type { Draft } from "@grasp-os/shared/drafts";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { LoadingLines } from "../frame/page-states.tsx";
import { PartNotLoaded } from "../frame/part-failed.tsx";
import { Button } from "../grasp/button/index.ts";
import { CodeBlock } from "../grasp/code-block/index.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Code, Download, Folder as FolderIcon } from "../grasp/icons/index.ts";
import { ScrollArea } from "../grasp/scroll-area/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { Tree } from "../grasp/tree/index.ts";
import type { TreeNode } from "../grasp/tree/index.ts";
import type { Loaded } from "../load-from-core.tsx";
import { fileIconOf } from "./file-icon.ts";
import { useCoreRead } from "./use-core-read.ts";

// An App's code in its workspace, for its builders (app-workspace.tsx's
// Code view), as a code editor shows a project, read-only: the files of
// the build the preview beside it shows as a tree of folders (the
// library's Tree), and the one open in the library's CodeBlock,
// highlighted, line by line. While the App's draft
// changes it, that is the draft's files as they are now, read again at
// each of its writes; otherwise the live version's. The App changes
// through its chat, which the note says. Everything is read with core's
// own reads for builders (`drafts.files`, `versions.files`), which
// refuse anyone else.
//
// What Grasp generates among an App's files (`server/_generated/`), which
// no one edits and every save writes again, isn't shown, as Convex's
// dashboard leaves out `convex/_generated/`: the builder's editor reads it.

/** A folder of the tree: the folders and files in it, by name. */
interface Folder {
  folders: Map<string, Folder>;
  files: { name: string; path: string }[];
}

/** The tree of `paths`. */
const treeOf = (paths: readonly string[]): Folder => {
  const root: Folder = { folders: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split("/");
    const name = parts.pop() ?? path;
    let folder = root;
    for (const part of parts) {
      let inner = folder.folders.get(part);
      if (inner === undefined) {
        inner = { folders: new Map(), files: [] };
        folder.folders.set(part, inner);
      }
      folder = inner;
    }
    folder.files.push({ name, path });
  }
  return root;
};

const byName = (a: string, b: string): number => a.localeCompare(b);

// How tall the file tree may grow above the code on a narrow screen, and
// how wide it stands beside it on a wide one: Grasp UI has no token for a
// side list's measure.
const TREE_TALL = "12rem";
const TREE_WIDE = "15rem";

// The page round the view keeps its own gutter, so the view adds none:
// the filter stands under the page's title. Each scroller reaches a step
// past its content (and pads it back), so a focus ring or a field's halo
// at the content's edge is never cut by it.
const outset = `calc(-1 * ${grasp.space1})`;

const styles = stylex.create({
  // The tree and the open file side by side on the page's own ground: the
  // code block is the one box in it, so nothing is framed twice.
  editor: {
    display: "flex",
    flexDirection: { default: "column", [media.fromTablet]: "row" },
    gap: grasp.space4,
    flexGrow: 1,
    minHeight: 0,
  },
  files: {
    flexShrink: 0,
    maxHeight: { default: TREE_TALL, [media.fromTablet]: "none" },
    width: { default: "auto", [media.fromTablet]: TREE_WIDE },
    margin: outset,
  },
  tree: { padding: grasp.space1 },
  code: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
  },
  scroller: { flexGrow: 1, margin: outset },
  page: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    padding: grasp.space1,
  },
  // Under the code: that it is read only, in line with the code block's
  // file name above.
  foot: {
    display: "flex",
    alignItems: "center",
    paddingInlineStart: `calc(${grasp.space3} + ${grasp.codeBlockBarWidth})`,
  },
  lines: { fontVariantNumeric: "tabular-nums" },
  fill: { display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 },
});

/**
 * One folder's entries as the tree's nodes, as an editor sorts them: its
 * folders, then its files, each by name.
 */
const nodesOf = (folder: Folder, at = ""): TreeNode[] => [
  ...[...folder.folders.entries()]
    .toSorted(([a], [b]) => byName(a, b))
    .map(([name, inner]) => ({
      value: `folder:${at}${name}`,
      label: name,
      icon: FolderIcon,
      children: nodesOf(inner, `${at}${name}/`),
    })),
  ...folder.files
    .toSorted((a, b) => byName(a.name, b.name))
    .map((file) => ({
      value: file.path,
      label: file.name,
      icon: fileIconOf(file.path),
    })),
];

/** Every folder of the tree's nodes: an App is a few files, so all stand open. */
const foldersOf = (nodes: readonly TreeNode[]): string[] =>
  nodes.flatMap((node) =>
    node.children === undefined ? [] : [node.value, ...foldersOf(node.children)]
  );

/** Hands the reader the open file to save, under its own name. */
const downloadFile = (path: string, text: string): void => {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = path.split("/").at(-1) ?? path;
  link.click();
  URL.revokeObjectURL(url);
};

/** The lines of `text`; its last newline ends a line, not starts one. */
const lineCount = (text: string): number =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/**
 * The code block's language for a file, by its extension: those it
 * highlights, the rest as text.
 */
const languages: Readonly<Record<string, string>> = {
  ts: "ts",
  mts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  jsx: "jsx",
  json: "json",
  css: "css",
  html: "html",
  svg: "svg",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  sql: "sql",
};

const languageOf = (path: string): string =>
  languages[path.slice(path.lastIndexOf(".") + 1)] ?? "text";

/**
 * The open file: the library's code block, headed by its path with Download
 * and Copy, whole (an editor never folds a file); under it, that it is read
 * only.
 */
const OpenFileCode = ({ path, text }: { path: string; text: string }) => {
  const { t } = useLingui();
  // Named so the note's message keeps its placeholder, `{lines}`.
  const lines = lineCount(text);
  return (
    <div {...stylex.props(styles.page)}>
      <CodeBlock
        // Save it, beside the head's copy, in the copy button's own form.
        actions={
          <Button
            aria-label={t`Download the file`}
            icon={Download}
            onClick={() => {
              downloadFile(path, text);
            }}
            size="sm"
            variant="ghost"
          />
        }
        code={text}
        fileName={path}
        language={languageOf(path)}
        maxLines={false}
      />
      <div {...stylex.props(styles.foot)}>
        <span {...stylex.props(styles.lines)}>
          <Text element="span" size="xs" tone="muted">
            <Plural
              one="# line, read only"
              other="# lines, read only"
              value={lines}
            />
          </Text>
        </span>
      </div>
    </div>
  );
};

/** The first file of `folder`, as its tree lists them. */
const firstIn = (folder: Folder): string | undefined => {
  for (const [, inner] of [...folder.folders.entries()].toSorted(([a], [b]) =>
    byName(a, b)
  )) {
    const first = firstIn(inner);
    if (first !== undefined) {
      return first;
    }
  }
  return folder.files.toSorted((a, b) => byName(a.name, b.name))[0]?.path;
};

/** The file asked to be open, and how to ask for another. */
interface OpenFile {
  asked: string | undefined;
  onAsk: (path: string) => void;
}

/** The files of one version: their tree, and the open one's text. */
const FilesView = ({ files, asked, onAsk }: OpenFile & { files: AppFiles }) => {
  const { t } = useLingui();
  const paths = Object.keys(files).filter(
    (path) => !isGeneratedServerFile(path)
  );
  const tree = treeOf(paths);
  const nodes = nodesOf(tree);
  // Every folder open, a new one too, but those the person folded.
  const folders = foldersOf(nodes);
  const [folded, setFolded] = useState<string[]>([]);
  // The one asked for while this version has it, else its config, else
  // the tree's first.
  const file =
    asked !== undefined && Object.hasOwn(files, asked)
      ? asked
      : (paths.find((path) => path === "grasp.config.ts") ?? firstIn(tree));
  if (file === undefined) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia icon={Code} />
          <EmptyTitle>
            <Trans>No files</Trans>
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  const text = files[file] ?? "";
  return (
    <div {...stylex.props(styles.editor)}>
      <ScrollArea layout={styles.files}>
        <div {...stylex.props(styles.tree)}>
          <Tree
            aria-label={t`Files`}
            expanded={folders.filter((folder) => !folded.includes(folder))}
            // The library's own filter over the files: what is typed narrows
            // the tree to the files that hold it, their folders opened.
            filterable
            items={nodes}
            mode="single"
            onExpandedChange={(expanded) => {
              setFolded(folders.filter((folder) => !expanded.includes(folder)));
            }}
            onValueChange={(value) => {
              if (typeof value === "string" && !value.startsWith("folder:")) {
                onAsk(value);
              }
            }}
            value={file}
          />
        </div>
      </ScrollArea>
      <section aria-label={t`Code of ${file}`} {...stylex.props(styles.code)}>
        {/* Each file its own scroller: a file opens at its top. */}
        <ScrollArea key={file} layout={styles.scroller}>
          <OpenFileCode path={file} text={text} />
        </ScrollArea>
      </section>
    </div>
  );
};

/** A read not done: that it is being read, or why it failed. */
const ReadState = ({ loaded }: { loaded: Loaded<unknown> | undefined }) =>
  loaded === undefined ? (
    <LoadingLines lines={6} />
  ) : (
    <PartNotLoaded page={loaded} />
  );

/** One version's files, read. */
const VersionFiles = ({
  app,
  version,
  asked,
  onAsk,
}: OpenFile & { app: string; version: number }) => {
  const files = useCoreRead(
    `${app}/${version}`,
    async (session) =>
      await session.versions.files({ kind: "app", id: app }, version)
  );
  return files?.state === "ready" ? (
    // A version's own tree, the file asked for open while it has it.
    <FilesView asked={asked} files={files.data} key={version} onAsk={onAsk} />
  ) : (
    <ReadState loaded={files} />
  );
};

/**
 * The files of the App's draft, read again at each of its revisions: the
 * file open stays open while the draft still has it.
 */
const DraftFiles = ({ app, revision }: { app: string; revision: number }) => {
  const [asked, setAsked] = useState<string>();
  const files = useCoreRead(
    `${app}/${revision}`,
    async (session) => await session.drafts.files({ kind: "app", id: app }),
    app
  );
  return files?.state === "ready" ? (
    <FilesView asked={asked} files={files.data} onAsk={setAsked} />
  ) : (
    <ReadState loaded={files} />
  );
};

/**
 * The App's Code view: the files of the App's draft (`building`) while it
 * changes the App, as the preview shows it; otherwise its live version's.
 */
export const AppCode = ({
  app,
  building,
}: {
  app: ViewedApp;
  /** The App's draft, while it changes the App. */
  building?: Draft;
}) => {
  const [file, setFile] = useState<string>();
  const current = app.currentVersion;
  if (building !== undefined) {
    return (
      <div {...stylex.props(styles.fill)}>
        <DraftFiles app={app.id} revision={building.revision} />
      </div>
    );
  }
  if (current === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia icon={Code} />
          <EmptyTitle>
            <Trans>No code yet</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>Grasp writes the first version in the chat.</Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div {...stylex.props(styles.fill)}>
      <VersionFiles
        app={app.id}
        asked={file}
        onAsk={setFile}
        version={current}
      />
    </div>
  );
};
