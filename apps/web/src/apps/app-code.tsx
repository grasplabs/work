import { isGeneratedServerFile } from "@grasp-os/runtime/host";
import type { AppFiles, ViewedApp } from "@grasp-os/shared/apps";
import type { Draft } from "@grasp-os/shared/drafts";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@grasp-os/ui/components/breadcrumb";
import { Button } from "@grasp-os/ui/components/button";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@grasp-os/ui/components/file-tree";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import { useCopy } from "../copy.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { CodeFile, CodeScroller, PathIcon } from "./code-view.tsx";
import { useCoreRead } from "./use-core-read.ts";

// An App's code in its workspace, for its builders (app-workspace.tsx's
// Code view), as a code editor shows a project, read-only: the files of
// the build the preview beside it shows as a tree of folders, and the one
// open highlighted, line by line (code-view.tsx). While the App's draft
// changes it, that is the draft's files as they are now, read again at
// each of its writes; otherwise the live version's. The App changes
// through its chat, which the note says. Everything is read with core's
// own reads for builders (`drafts.files`, `apps.files.read`), which
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

/**
 * One folder's entries, as an editor sorts them: its folders, then its
 * files, each by name. A folder starts open: an App is a few files.
 */
const FolderEntries = ({
  folder,
  open,
  onOpen,
}: {
  folder: Folder;
  open: string;
  onOpen: (path: string) => void;
}) => (
  <>
    {[...folder.folders.entries()]
      .toSorted(([a], [b]) => byName(a, b))
      .map(([name, inner]) => (
        <FileTreeFolder defaultOpen key={`folder:${name}`} name={name}>
          <FolderEntries folder={inner} onOpen={onOpen} open={open} />
        </FileTreeFolder>
      ))}
    {folder.files
      .toSorted((a, b) => byName(a.name, b.name))
      .map((file) => (
        <FileTreeFile
          active={file.path === open}
          icon={<PathIcon path={file.path} />}
          key={file.path}
          onClick={() => {
            onOpen(file.path);
          }}
          title={file.path}
        >
          {file.name}
        </FileTreeFile>
      ))}
  </>
);

/** Where the open file is, folder by folder, as a breadcrumb. */
const PathCrumbs = ({ path }: { path: string }) => {
  const { t } = useLingui();
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  return (
    <Breadcrumb aria-label={t`Open file`} className="min-w-0 flex-1">
      <BreadcrumbList className="flex-nowrap">
        {parts.map((part, index) => (
          // A folder's place in the path is all that tells it apart.
          <Fragment key={`${index}:${part}`}>
            <BreadcrumbItem className="min-w-0">{part}</BreadcrumbItem>
            <BreadcrumbSeparator />
          </Fragment>
        ))}
        <BreadcrumbItem className="min-w-0">
          <BreadcrumbPage>{name}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
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
    <div className="flex flex-none items-center gap-3 border-b py-1.5 ps-4 pe-2">
      <PathCrumbs path={path} />
      <span className="text-muted-foreground flex-none text-xs tabular-nums">
        <Plural one="# line" other="# lines" value={lines} />
      </span>
      <Button
        aria-label={copied ? t`Copied` : t`Copy code`}
        onClick={() => {
          void copy(text);
        }}
        size="icon-sm"
        variant="ghost"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
};

/** The editor's frame: what it shows, on the page's muted ground. */
const EditorFrame = ({ children }: { children: ReactNode }) => (
  <div className="bg-card flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
    {children}
  </div>
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
  // The one asked for while this version has it, else its config, else
  // the tree's first.
  const file =
    asked !== undefined && Object.hasOwn(files, asked)
      ? asked
      : (paths.find((path) => path === "grasp.config.ts") ?? firstIn(tree));
  if (file === undefined) {
    return (
      <EditorFrame>
        <p className="text-muted-foreground p-4 text-sm">
          <Trans>This version has no files.</Trans>
        </p>
      </EditorFrame>
    );
  }
  const text = files[file] ?? "";
  return (
    <EditorFrame>
      <nav
        aria-label={t`Files`}
        className="max-h-48 flex-none overflow-y-auto border-b p-2 md:max-h-none md:w-60 md:border-e md:border-b-0"
      >
        <FileTree>
          <FolderEntries folder={tree} onOpen={onAsk} open={file} />
        </FileTree>
      </nav>
      <section
        aria-label={t`Code of ${file}`}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <FileBar path={file} text={text} />
        {/* Each file its own scroller: a file opens at its top. */}
        <CodeScroller className="min-h-0 flex-1 overflow-auto" key={file}>
          <CodeFile path={file} text={text} />
        </CodeScroller>
      </section>
    </EditorFrame>
  );
};

/** A read not done: that it is being read, or why it failed. */
const ReadState = ({ loaded }: { loaded: Loaded<unknown> | undefined }) => (
  <div className="p-4">
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
      <div className="flex min-h-0 flex-1 flex-col">
        <DraftFiles app={app.id} revision={building.revision} />
      </div>
    );
  }
  if (current === null) {
    return (
      <p className="text-muted-foreground p-4 md:px-6">
        <Trans>No code yet: Grasp writes the first version in the chat.</Trans>
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <VersionFiles
        app={app.id}
        asked={file}
        onAsk={setFile}
        version={current}
      />
    </div>
  );
};
