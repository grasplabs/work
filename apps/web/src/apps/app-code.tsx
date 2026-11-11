import { isGeneratedServerFile } from "@grasp-os/runtime/host";
import type { AppFiles, FileDiff, ViewedApp } from "@grasp-os/shared/apps";
import type { ChatDraft } from "@grasp-os/shared/chat";
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
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Fragment, useState } from "react";
import type { ReactNode } from "react";

import { useCopy } from "../copy.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import {
  CodeDiff,
  CodeFile,
  CodeScroller,
  comparedLines,
  PathIcon,
  onlyFinalNewline,
} from "./code-view.tsx";
import type { DiffLayout } from "./code-view.tsx";
import { useCoreRead } from "./use-core-read.ts";

// An App's code in its workspace, for its builders (app-workspace.tsx's
// Code view), as a code editor shows a project, read-only: the files of
// the build the preview beside it shows as a tree of folders, and the one
// open highlighted, line by line (code-view.tsx). While the workspace's
// chat has a draft of the App, that is the draft's files as they are now,
// read again at each write of the chat's agent; otherwise the version up
// for review, if any, and its changes against the current version, file
// by file, or else the current version. The App changes through its chat,
// which the note says. Everything is read with core's own reads for
// builders (`chats.draftFiles`, `apps.files.read`, `apps.versions.diff`),
// which refuse anyone else.
//
// What Grasp generates among an App's files (`server/_generated/`), which
// no one edits and every save writes again, isn't shown, as Convex's
// dashboard leaves out `convex/_generated/`: the builder's editor reads it.

/** Which version's files are shown. */
type Source = "current" | "draft";

/** What the tab shows: the files, or the draft's changes. */
type Part = "files" | "changes";

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

/**
 * The most lines, old and new together, a file's change is diffed line by
 * line in. The diff runs on the page's own thread (the CSP starts no
 * worker), and it grows faster than the lines: about 4,000 take a few
 * hundred milliseconds, 10,000 several seconds. Past it, as GitHub does
 * with a large diff, the change says so and opens in Files instead.
 */
const maxComparedLines = 4000;

/** Whether the view draws `diff` line by line, rather than a note. */
const drawnLineByLine = (diff: FileDiff): boolean =>
  comparedLines(diff) <= maxComparedLines && !onlyFinalNewline(diff);

/** Why a file's change isn't drawn line by line. */
const NoteText = ({ diff }: { diff: FileDiff }) => {
  if (comparedLines(diff) > maxComparedLines) {
    return <Trans>This change is too large to show line by line.</Trans>;
  }
  return diff.change !== "deleted" && diff.after.endsWith("\n") ? (
    <Trans>Only a newline at the end of the file was added.</Trans>
  ) : (
    <Trans>Only the newline at the end of the file was removed.</Trans>
  );
};

/** A file's change the view doesn't draw line by line, and why. */
const ChangeNote = ({
  diff,
  onOpen,
}: {
  diff: FileDiff;
  onOpen: (path: string) => void;
}) => {
  const { path, change } = diff;
  return (
    <section
      aria-label={path}
      className="flex flex-col gap-2 border-b px-4 py-3 text-sm"
    >
      <h3 className="flex min-w-0 items-center gap-2 text-xs">
        <PathIcon className="text-muted-foreground size-4" path={path} />
        <span className="truncate">{path}</span>
      </h3>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="text-muted-foreground">
          <NoteText diff={diff} />
        </p>
        {change === "deleted" ? null : (
          <Button
            onClick={() => {
              onOpen(path);
            }}
            size="sm"
            variant="outline"
          >
            <Trans>Open in Files</Trans>
          </Button>
        )}
      </div>
    </section>
  );
};

/** The draft's changes against the current version, file by file. */
const ChangesView = ({
  diffs,
  layout,
  onOpen,
}: {
  diffs: readonly FileDiff[];
  layout: DiffLayout;
  /** Opens a file of the draft in Files. */
  onOpen: (path: string) => void;
}) => {
  const { t } = useLingui();
  return (
    <EditorFrame>
      {diffs.length === 0 ? (
        <p className="text-muted-foreground p-4 text-sm">
          <Trans>The draft changes no file.</Trans>
        </p>
      ) : (
        <section
          aria-label={t({
            message: "Changes",
            context: "what a draft changes in an app's code",
          })}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <CodeScroller className="min-h-0 flex-1 overflow-auto">
            {diffs.map((diff) =>
              drawnLineByLine(diff) ? (
                <section aria-label={diff.path} key={diff.path}>
                  <CodeDiff diff={diff} layout={layout} />
                </section>
              ) : (
                <ChangeNote diff={diff} key={diff.path} onOpen={onOpen} />
              )
            )}
          </CodeScroller>
        </section>
      )}
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

/** Every file of `files`, as added: a draft over no current version. */
const allAdded = (files: AppFiles): FileDiff[] =>
  Object.entries(files)
    .toSorted(([a], [b]) => byName(a, b))
    .map(([path, after]) => ({ path, change: "added", after }));

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
 * The files of the chat's draft, read again at each of its revisions: the
 * file open stays open while the draft still has it.
 */
const ChatDraftFiles = ({
  app,
  chatId,
  revision,
}: {
  app: string;
  chatId: string;
  revision: number;
}) => {
  const [asked, setAsked] = useState<string>();
  const files = useCoreRead(
    `${chatId}/${app}/${revision}`,
    async (session) => await session.chats.draftFiles(chatId, app),
    `${chatId}/${app}`
  );
  return files?.state === "ready" ? (
    <FilesView asked={asked} files={files.data} onAsk={setAsked} />
  ) : (
    <ReadState loaded={files} />
  );
};

/** The draft's changes against the current version, read. */
const DraftChanges = ({
  app,
  current,
  draft,
  layout,
  onOpen,
}: {
  app: string;
  current: number | null;
  draft: number;
  layout: DiffLayout;
  onOpen: (path: string) => void;
}) => {
  const changes = useCoreRead(
    `${app}/${current ?? ""}/${draft}`,
    async (session) =>
      current === null
        ? allAdded(await session.apps.files.read(app, draft))
        : await session.apps.versions.diff(app, current, draft)
  );
  return changes?.state === "ready" ? (
    <ChangesView
      diffs={changes.data.filter(({ path }) => !isGeneratedServerFile(path))}
      layout={layout}
      onOpen={onOpen}
    />
  ) : (
    <ReadState loaded={changes} />
  );
};

/** One choice of a few, as a small segmented control. */
const Choice = <T extends string>({
  label,
  value,
  options,
  onChoose,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: ReactNode }[];
  onChoose: (value: T) => void;
}) => (
  <ToggleGroup
    aria-label={label}
    onValueChange={(chosen: unknown[]) => {
      const option = options.find(({ value: each }) => each === chosen[0]);
      if (option !== undefined) {
        onChoose(option.value);
      }
    }}
    size="sm"
    spacing={0}
    value={[value]}
    variant="outline"
  >
    {options.map((option) => (
      <ToggleGroupItem key={option.value} value={option.value}>
        {option.label}
      </ToggleGroupItem>
    ))}
  </ToggleGroup>
);

/** The view's bar, over what it shows: its choices. */
const CodeBar = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
    {children}
  </div>
);

/** What the tab shows once it knows the App's versions. */
const CodeBody = ({
  app,
  current,
  draft,
}: {
  app: string;
  current: number | null;
  draft: number | null;
}) => {
  const { t } = useLingui();
  const [asked, setAsked] = useState<Source>();
  const [part, setPart] = useState<Part>("files");
  const [layout, setLayout] = useState<DiffLayout>("unified");
  const [file, setFile] = useState<string>();
  // A change opened in Files: the draft's file.
  const openInFiles = (path: string): void => {
    setFile(path);
    setAsked("draft");
    setPart("files");
  };
  // The draft's, as the preview shows it, unless the current version's
  // were asked for, or there is no draft.
  const source: Source =
    current === null || (asked !== "current" && draft !== null)
      ? "draft"
      : "current";
  const version = source === "draft" ? draft : current;
  const changes = part === "changes" ? draft : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CodeBar>
        {draft === null ? null : (
          <Choice
            label={t`What to show of the code`}
            onChoose={setPart}
            options={[
              { value: "files", label: <Trans>Files</Trans> },
              {
                value: "changes",
                label: t({
                  message: "Changes",
                  context: "what a draft changes in an app's code",
                }),
              },
            ]}
            value={part}
          />
        )}
        {draft !== null && current !== null && changes === null ? (
          <Choice
            label={t`Which version`}
            onChoose={setAsked}
            options={[
              {
                value: "current",
                label: <Trans>Current (version {current})</Trans>,
              },
              {
                value: "draft",
                label: <Trans>Draft (version {draft})</Trans>,
              },
            ]}
            value={source}
          />
        ) : null}
        {changes === null ? null : (
          <Choice
            label={t`How changes are shown`}
            onChoose={setLayout}
            options={[
              {
                value: "unified",
                label: (
                  <Trans context="a diff's lines in one column">Unified</Trans>
                ),
              },
              {
                value: "split",
                label: (
                  <Trans context="a diff's old and new lines side by side">
                    Split
                  </Trans>
                ),
              },
            ]}
            value={layout}
          />
        )}
      </CodeBar>
      {changes !== null && (
        <DraftChanges
          app={app}
          current={current}
          draft={changes}
          layout={layout}
          onOpen={openInFiles}
        />
      )}
      {changes === null && version !== null && (
        <VersionFiles
          app={app}
          asked={file}
          onAsk={setFile}
          version={version}
        />
      )}
    </div>
  );
};

/** The workspace's chat, and its draft of the App the preview shows. */
export interface ChatBuilding {
  chatId: string;
  draft: ChatDraft;
}

/**
 * The App's Code view: the files of the chat's draft (`building`) while
 * the workspace's chat has one, as the preview shows it. Otherwise, its
 * draft is the version up for review alone, as the App says it: a version
 * merely newer than the current one may be one a builder rolled back
 * from, never a draft.
 */
export const AppCode = ({
  app,
  building,
}: {
  app: ViewedApp;
  /** None while the workspace's chat has no draft of the App. */
  building?: ChatBuilding;
}) => {
  const current = app.currentVersion;
  const draft = app.pendingVersion;
  if (building !== undefined) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatDraftFiles
          app={app.id}
          chatId={building.chatId}
          revision={building.draft.revision}
        />
      </div>
    );
  }
  if (current === null && draft === null) {
    return (
      <p className="text-muted-foreground p-4 md:px-6">
        <Trans>No code yet: Grasp writes the first version in the chat.</Trans>
      </p>
    );
  }
  return <CodeBody app={app.id} current={current} draft={draft} />;
};
