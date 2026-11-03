import type { AppFiles, FileDiff, ViewedApp } from "@grasp-os/shared/apps";
import { Badge } from "@grasp-os/ui/components/badge";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { cn } from "@grasp-os/ui/lib/utils";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { FileIcon, FolderIcon, MessageSquareIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import Markdown from "react-markdown";
import type { Components, Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";

import type { Session } from "../core.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { changedLines } from "./line-diff.ts";
import type { DiffPart } from "./line-diff.ts";

// An App's code on its page, for its builders (app-page.tsx's Code tab):
// the files of its current version as a tree, the one picked shown
// highlighted, and, when a version is up for review (the draft), the same
// of it and its changes against the current version, file by file.
// Read-only: the App changes through its chat, which the note says.
// Everything is read with core's own reads for builders
// (`apps.files.read`, `apps.versions.diff`), which refuse anyone else.
//
// Highlighting is the chat's (answer-markdown.tsx): rehype-highlight by
// class, coloured from the theme's tokens in styles.css. A file goes
// through it as one fenced block, its fence longer than any run of
// backticks in it, so nothing in the file can end the block.

/** Which version's files are shown. */
type Source = "current" | "draft";

/** What the tab shows: the files, or the draft's changes. */
type Part = "files" | "changes";

/** The language highlight.js knows a file by, from its extension. */
const languages: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  json: "json",
  md: "markdown",
  css: "css",
  html: "xml",
  svg: "xml",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
};

/** A file's language, by its extension; none for one highlight.js lacks. */
const languageOf = (path: string): string | undefined => {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? undefined : languages[path.slice(dot + 1)];
};

/** Every run of backticks. */
const backtickRuns = /`+/gu;

/** `text` as one fenced Markdown block in `language`. */
const fenced = (text: string, language: string | undefined): string => {
  const longest = Math.max(
    0,
    ...[...text.matchAll(backtickRuns)].map(([run]) => run.length)
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language ?? ""}\n${text.replace(/\n$/u, "")}\n${fence}`;
};

/** Highlighting only a file whose language is known, as in the chat. */
const highlightPlugins: Options["rehypePlugins"] = [
  [rehypeHighlight, { detect: false }],
];

const codeComponents: Components = {
  pre: ({ children }) => (
    <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed">
      {children}
    </pre>
  ),
};

/** A file's text, highlighted. */
const HighlightedFile = ({ path, text }: { path: string; text: string }) => (
  <Markdown
    components={codeComponents}
    rehypePlugins={highlightPlugins}
    skipHtml
  >
    {fenced(text, languageOf(path))}
  </Markdown>
);

/** A folder of the tree: its folders, then its files, each by name. */
interface Folder {
  folders: Map<string, Folder>;
  files: { name: string; path: string }[];
}

/** The tree of `paths`, folders and files each sorted by name. */
const treeOf = (paths: readonly string[]): Folder => {
  const root: Folder = { folders: new Map(), files: [] };
  for (const path of [...paths].toSorted()) {
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

/** One folder's entries, its folders open, the picked file marked. */
const FolderEntries = ({
  folder,
  picked,
  onPick,
}: {
  folder: Folder;
  picked: string | undefined;
  onPick: (path: string) => void;
}) => (
  <ul className="flex flex-col gap-0.5">
    {[...folder.folders.entries()]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([name, inner]) => (
        <li className="flex flex-col gap-0.5" key={`folder:${name}`}>
          <span className="text-muted-foreground flex items-center gap-1.5 px-2 py-1 text-xs">
            <FolderIcon aria-hidden="true" className="size-3.5 flex-none" />
            {name}
          </span>
          <div className="pl-3">
            <FolderEntries folder={inner} onPick={onPick} picked={picked} />
          </div>
        </li>
      ))}
    {folder.files.map((file) => (
      <li key={file.path}>
        <button
          aria-current={file.path === picked ? "true" : undefined}
          className={cn(
            "hover:bg-muted flex w-full items-center gap-1.5 truncate rounded-md px-2 py-1 text-left font-mono text-xs",
            file.path === picked && "bg-muted font-medium"
          )}
          onClick={() => {
            onPick(file.path);
          }}
          title={file.path}
          type="button"
        >
          <FileIcon
            aria-hidden="true"
            className="text-muted-foreground size-3.5 flex-none"
          />
          {file.name}
        </button>
      </li>
    ))}
  </ul>
);

/**
 * What `read` read for `key`, read again whenever `key` changes; nothing
 * while it is read.
 */
const useCoreRead = <T,>(
  key: string,
  read: (session: Session) => Promise<T>
): Loaded<T> | undefined => {
  const core = useCore();
  const [held, setHeld] = useState<{ key: string; loaded: Loaded<T> }>();
  const onRead = useEffectEvent(
    async (signal: AbortSignal): Promise<Loaded<T>> =>
      await loadFromCore(core, read, signal)
  );
  useEffect(() => {
    const left = new AbortController();
    const load = async (): Promise<void> => {
      const loaded = await onRead(left.signal);
      if (!left.signal.aborted) {
        setHeld({ key, loaded });
      }
    };
    void load();
    return () => {
      left.abort();
    };
  }, [key]);
  return held?.key === key ? held.loaded : undefined;
};

/** A read not done: that it is being read, or why it failed. */
const ReadState = ({ loaded }: { loaded: Loaded<unknown> | undefined }) =>
  loaded === undefined ? (
    <LoadingLines lines={6} />
  ) : (
    <NotLoaded page={loaded} />
  );

/** The files of one version: their tree, and the picked one's text. */
const FilesView = ({ files }: { files: AppFiles }) => {
  const { t } = useLingui();
  const paths = Object.keys(files);
  const [asked, setAsked] = useState<string>();
  // The one asked for while this version has it, else its app.ts, else
  // its first.
  const picked =
    asked !== undefined && Object.hasOwn(files, asked)
      ? asked
      : (paths.find((path) => path === "app.ts") ?? paths.toSorted()[0]);
  if (picked === undefined) {
    return (
      <p className="text-muted-foreground">
        <Trans>This version has no files.</Trans>
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
      <nav
        aria-label={t`Files`}
        className="flex-none overflow-y-auto rounded-xl border p-2 md:w-64"
      >
        <FolderEntries
          folder={treeOf(paths)}
          onPick={setAsked}
          picked={picked}
        />
      </nav>
      <figure className="bg-muted flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl">
        <figcaption className="text-muted-foreground border-b px-4 py-2 font-mono text-xs">
          {picked}
        </figcaption>
        <div className="min-h-0 flex-1 overflow-auto">
          <HighlightedFile path={picked} text={files[picked] ?? ""} />
        </div>
      </figure>
    </div>
  );
};

/** How a file changed, as its badge says it. */
const ChangeBadge = ({ change }: { change: FileDiff["change"] }) => {
  if (change === "added") {
    return (
      <Badge variant="passed">
        <Trans>Added</Trans>
      </Badge>
    );
  }
  if (change === "deleted") {
    return (
      <Badge variant="destructive">
        <Trans>Deleted</Trans>
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      <Trans>Changed</Trans>
    </Badge>
  );
};

/** How many unchanged lines a gap leaves out. */
const GapText = ({ unchanged }: { unchanged: number }) => (
  <Plural
    one="⋯ # unchanged line"
    other="⋯ # unchanged lines"
    value={unchanged}
  />
);

/** A file's changed lines, as a diff prints them. */
const ChangedLines = ({ shown }: { shown: readonly DiffPart[] }) => (
  <pre className="overflow-x-auto py-2 font-mono text-xs leading-relaxed">
    {shown.map((line, index) => {
      if (line.kind === "gap") {
        return (
          <div
            className="text-muted-foreground px-4"
            // Nothing else marks a gap's place.
            key={`gap-${index}`}
          >
            <GapText unchanged={line.lines} />
          </div>
        );
      }
      if (line.kind === "no-newline") {
        return (
          <div
            className="text-muted-foreground px-4 italic"
            // It belongs to the line before it, and has no place of its own.
            key={`no-newline-${index}`}
          >
            <Trans>No newline at end of file</Trans>
          </div>
        );
      }
      const key = `${line.before ?? ""}:${line.after ?? ""}`;
      if (line.kind === "added") {
        return (
          <ins
            className="bg-status-agreed/10 block px-4 no-underline"
            key={key}
          >
            {`+ ${line.text}`}
          </ins>
        );
      }
      if (line.kind === "removed") {
        return (
          <del className="bg-destructive/10 block px-4 no-underline" key={key}>
            {`- ${line.text}`}
          </del>
        );
      }
      return (
        <div className="px-4" key={key}>
          {`  ${line.text}`}
        </div>
      );
    })}
  </pre>
);

/** One file's changed lines, with a few unchanged ones around them. */
const FileChange = ({ diff }: { diff: FileDiff }) => {
  const shown = changedLines(diff);
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border">
      <header className="bg-muted flex items-center gap-2 border-b px-4 py-2">
        <h3 className="min-w-0 truncate font-mono text-xs">{diff.path}</h3>
        <ChangeBadge change={diff.change} />
      </header>
      {shown === undefined ? (
        <p className="text-muted-foreground px-4 py-2 text-xs">
          <Trans>Too many changes to show line by line</Trans>
        </p>
      ) : (
        <ChangedLines shown={shown} />
      )}
    </section>
  );
};

/** The draft's changes against the current version, file by file. */
const ChangesView = ({ diffs }: { diffs: readonly FileDiff[] }) =>
  diffs.length === 0 ? (
    <p className="text-muted-foreground">
      <Trans>The draft changes no file.</Trans>
    </p>
  ) : (
    <div className="flex flex-col gap-4">
      {diffs.map((diff) => (
        <FileChange diff={diff} key={diff.path} />
      ))}
    </div>
  );

/** Every file of `files`, as added: a draft over no current version. */
const allAdded = (files: AppFiles): FileDiff[] =>
  Object.entries(files)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([path, after]) => ({ path, change: "added", after }));

/** One version's files, read. */
const VersionFiles = ({ app, version }: { app: string; version: number }) => {
  const files = useCoreRead(
    `${app}/${version}`,
    async (session) => await session.apps.files.read(app, version)
  );
  return files?.state === "ready" ? (
    // A version's own tree: what was picked in another may not be in it.
    <FilesView files={files.data} key={version} />
  ) : (
    <ReadState loaded={files} />
  );
};

/** The draft's changes against the current version, read. */
const DraftChanges = ({
  app,
  current,
  draft,
}: {
  app: string;
  current: number | null;
  draft: number;
}) => {
  const changes = useCoreRead(
    `${app}/${current ?? ""}/${draft}`,
    async (session) =>
      current === null
        ? allAdded(await session.apps.files.read(app, draft))
        : await session.apps.versions.diff(app, current, draft)
  );
  return changes?.state === "ready" ? (
    <ChangesView diffs={changes.data} />
  ) : (
    <ReadState loaded={changes} />
  );
};

/** Whether the files are shown, or the draft's changes. */
const PartToggle = ({
  part,
  onPart,
}: {
  part: Part;
  onPart: (part: Part) => void;
}) => {
  const { t } = useLingui();
  return (
    <ToggleGroup
      aria-label={t`What to show of the code`}
      onValueChange={(value: unknown[]) => {
        const [next] = value;
        if (next === "files" || next === "changes") {
          onPart(next);
        }
      }}
      value={[part]}
    >
      <ToggleGroupItem value="files">
        <Trans>Files</Trans>
      </ToggleGroupItem>
      <ToggleGroupItem value="changes">
        {t({
          message: "Changes",
          context: "what a draft changes in an app's code",
        })}
      </ToggleGroupItem>
    </ToggleGroup>
  );
};

/** Whether the current version's files are shown, or the draft's. */
const SourceToggle = ({
  source,
  current,
  draft,
  onSource,
}: {
  source: Source;
  current: number;
  draft: number;
  onSource: (source: Source) => void;
}) => {
  const { t } = useLingui();
  return (
    <ToggleGroup
      aria-label={t`Which version`}
      onValueChange={(value: unknown[]) => {
        const [next] = value;
        if (next === "current" || next === "draft") {
          onSource(next);
        }
      }}
      value={[source]}
    >
      <ToggleGroupItem value="current">
        <Trans>Current (version {current})</Trans>
      </ToggleGroupItem>
      <ToggleGroupItem value="draft">
        <Trans>Draft (version {draft})</Trans>
      </ToggleGroupItem>
    </ToggleGroup>
  );
};

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
  const [asked, setAsked] = useState<Source>("current");
  const [part, setPart] = useState<Part>("files");
  // The current version's, unless only a draft has files, or the draft's
  // were asked for.
  const source: Source =
    current === null || (asked === "draft" && draft !== null)
      ? "draft"
      : "current";
  const version = source === "draft" ? draft : current;
  const changes = part === "changes" ? draft : null;
  const choosesSource = draft !== null && current !== null && changes === null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {draft === null ? null : <PartToggle onPart={setPart} part={part} />}
        {choosesSource ? (
          <SourceToggle
            current={current}
            draft={draft}
            onSource={setAsked}
            source={source}
          />
        ) : null}
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <MessageSquareIcon aria-hidden="true" className="size-3.5" />
          <Trans>Read-only. Changes to the code go through the chat.</Trans>
        </p>
      </div>
      {changes !== null && (
        <DraftChanges app={app} current={current} draft={changes} />
      )}
      {changes === null && version !== null && (
        <VersionFiles app={app} version={version} />
      )}
    </div>
  );
};

/**
 * The App's Code tab. Its draft is the version up for review alone, as the
 * App says it: a version merely newer than the current one may be one a
 * builder rolled back from, never a draft.
 */
export const AppCode = ({ app }: { app: ViewedApp }) => {
  const current = app.currentVersion;
  const draft = app.pendingVersion;
  if (current === null && draft === null) {
    return (
      <p className="text-muted-foreground">
        <Trans>No code yet: Grasp writes the first version in the chat.</Trans>
      </p>
    );
  }
  return <CodeBody app={app.id} current={current} draft={draft} />;
};
