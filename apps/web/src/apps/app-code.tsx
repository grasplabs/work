import { isGeneratedServerFile } from "@grasp-os/runtime/host";
import type { AppDraft } from "@grasp-os/shared/app-drafts";
import type { AppFiles, ViewedApp } from "@grasp-os/shared/apps";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import { useCopy } from "../copy.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { Breadcrumb } from "../grasp/breadcrumb/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Copy, Folder as FolderIcon, Tick } from "../grasp/icons/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { Tree } from "../grasp/tree/index.ts";
import type { TreeNode } from "../grasp/tree/index.ts";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { CodeFile, CodeScroller, fileIconOf } from "./code-view.tsx";
import { useCoreRead } from "./use-core-read.ts";

// An App's code in its workspace, for its builders (app-workspace.tsx's
// Code view), as a code editor shows a project, read-only: the files of
// the build the preview beside it shows as a tree of folders, and the one
// open highlighted, line by line (code-view.tsx). While the App's draft
// changes it, that is the draft's files as they are now, read again at
// each of its writes; otherwise the live version's. The App changes
// through its chat, which the note says. Everything is read with core's
// own reads for builders (`apps.drafts.files`, `apps.files.read`), which
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

const styles = stylex.create({
  editor: {
    display: "flex",
    flexDirection: { default: "column", [media.fromTablet]: "row" },
    flexGrow: 1,
    minHeight: 0,
    overflow: "hidden",
    backgroundColor: grasp.raised,
  },
  files: {
    flexShrink: 0,
    maxHeight: { default: TREE_TALL, [media.fromTablet]: "none" },
    width: { default: "auto", [media.fromTablet]: TREE_WIDE },
    overflowY: "auto",
    padding: grasp.space2,
    boxShadow: grasp.edge,
  },
  code: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    minWidth: 0,
  },
  bar: {
    display: "flex",
    flexShrink: 0,
    alignItems: "center",
    gap: grasp.space3,
    paddingBlock: grasp.space1,
    paddingInlineStart: grasp.space4,
    paddingInlineEnd: grasp.space2,
    boxShadow: grasp.edge,
  },
  crumbs: { flexGrow: 1, minWidth: 0 },
  lines: { flexShrink: 0, fontVariantNumeric: "tabular-nums" },
  scroller: { flexGrow: 1, minHeight: 0, overflow: "auto" },
  fill: { display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 },
  padded: { padding: grasp.space4 },
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

/** Where the open file is, folder by folder, as a breadcrumb. */
const PathCrumbs = ({ path }: { path: string }) => {
  const { t } = useLingui();
  return (
    <Breadcrumb
      aria-label={t`Open file`}
      items={path.split("/").map((label) => ({ label }))}
      layout={styles.crumbs}
    />
  );
};

/** The lines of `text`; its last newline ends a line, not starts one. */
const lineCount = (text: string): number =>
  text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/** The open file's bar: its path, its length, and a way to copy it. */
const FileBar = ({ path, text }: { path: string; text: string }) => {
  const { t } = useLingui();
  const { copied, copy } = useCopy();
  const lines = lineCount(text);
  return (
    <div {...stylex.props(styles.bar)}>
      <PathCrumbs path={path} />
      <span {...stylex.props(styles.lines)}>
        <Text element="span" size="xs" tone="muted">
          <Plural one="# line" other="# lines" value={lines} />
        </Text>
      </span>
      <Button
        icon={copied ? Tick : Copy}
        aria-label={copied ? t`Copied` : t`Copy code`}
        onClick={() => {
          void copy(text);
        }}
        size="sm"
        variant="ghost"
      />
    </div>
  );
};

/** The editor's frame: the tree and the open file. */
const EditorFrame = ({ children }: { children: ReactNode }) => (
  <div {...stylex.props(styles.editor)}>{children}</div>
);

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
      <EditorFrame>
        <div {...stylex.props(styles.padded)}>
          <Text size="sm" tone="muted">
            <Trans>This version has no files.</Trans>
          </Text>
        </div>
      </EditorFrame>
    );
  }
  const text = files[file] ?? "";
  return (
    <EditorFrame>
      <div {...stylex.props(styles.files)}>
        <Tree
          aria-label={t`Files`}
          expanded={folders.filter((folder) => !folded.includes(folder))}
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
      <section aria-label={t`Code of ${file}`} {...stylex.props(styles.code)}>
        <FileBar path={file} text={text} />
        {/* Each file its own scroller: a file opens at its top. */}
        <CodeScroller key={file} {...stylex.props(styles.scroller)}>
          <CodeFile path={file} text={text} />
        </CodeScroller>
      </section>
    </EditorFrame>
  );
};

/** A read not done: that it is being read, or why it failed. */
const ReadState = ({ loaded }: { loaded: Loaded<unknown> | undefined }) => (
  <div {...stylex.props(styles.padded)}>
    {loaded === undefined ? (
      <LoadingLines lines={6} />
    ) : (
      <NotLoaded page={loaded} />
    )}
  </div>
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
    async (session) => await session.apps.files.read(app, version)
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
    async (session) => await session.apps.drafts.files(app),
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
  building?: AppDraft;
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
      <div {...stylex.props(styles.padded)}>
        <Text size="sm" tone="muted">
          <Trans>
            No code yet: Grasp writes the first version in the chat.
          </Trans>
        </Text>
      </div>
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
