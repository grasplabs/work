// The viewer's shell, the same for every format: it opens the file, picks its renderer (each its
// own chunk, loaded only when a file of that kind opens), and owns the toolbar, the scrolling
// viewport, search, zoom, the keyboard and the link. Loaded on idle by ArtifactViewer.
"use client";

import * as stylex from "@stylexjs/stylex";
import { usePart, usePrimitive } from "@ui-sdk/react/primitive";
import { formatShortcut, registerShortcut } from "@ui-sdk/react/shortcuts";
import {
  createElement,
  useEffect,
  useEffectEvent,
  useId,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ComponentType, ReactNode } from "react";

import type { AppBuildingProps } from "../app-building/app-building";
import { Button } from "../button/button";
import { Dialog, DialogBody, DialogContent, DialogTitle } from "../dialog";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "../empty/empty";
import { visuallyHidden } from "../hidden/hidden";
import { Download } from "../icons";
import { Kbd } from "../kbd/kbd";
import { arrive } from "../motion/arrive";
import { scroll } from "../scroll/scroll";
import { Spinner } from "../spinner/spinner";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { artifactViewerAgent } from "./agent";
import type { ViewerTools } from "./agent";
import { wholeAt } from "./anchor";
import type { Anchor, TableShape } from "./anchor";
import type { EditPatch } from "./edits";
import { anchorKindOf, viewerExtras } from "./extras";
import type { AgentEdits } from "./extras";
import type { ArtifactFormat } from "./format";
import { VIEWER_KEYS, zoomStep } from "./keys";
import type { ViewerAction, ViewerKey } from "./keys";
import { RENDERER_LOADERS } from "./load-renderer";
import { memoryLocation, queryLocation } from "./location";
import type { ViewerLocation, ViewState } from "./location";
import { openArtifact } from "./source";
import type { ArtifactSource, OpenedArtifact, OpenWords } from "./source";
import { Toolbar } from "./toolbar";
import type {
  ArtifactViewerLabels,
  CommentAuthor,
  CommentHandler,
  CommentThread,
  RendererControl,
  RendererProps,
  Section,
} from "./types";
import { artifactViewerNotices, englishLabels } from "./words";
import { warmWorker } from "./worker/client";

// Each format's renderer, its own chunk, loaded when a file of its kind opens (and started earlier
// by the box beside the shell). Not behind Suspense: React holds a boundary's reveal back for about
// 300ms, which the first file on a page would wait out even with the chunk already loaded.
interface Loaded {
  format: ArtifactFormat;
  component: ComponentType<RendererProps>;
}
// What an effect with nothing to undo gives back.
const stayPut = () => {
  // Nothing was started, so nothing stops.
};
const loadRenderer = (
  format: ArtifactFormat | undefined,
  set: (loaded: Loaded) => void
) => {
  const loader = format === undefined ? undefined : RENDERER_LOADERS[format];
  if (format === undefined || loader === undefined) {
    return stayPut;
  }
  const live = { now: true };
  const load = async () => {
    const module = await loader();
    if (live.now) {
      set({ format, component: module.default });
    }
  };
  void load();
  return () => {
    live.now = false;
  };
};
const useRenderer = (format: ArtifactFormat | undefined) => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => loadRenderer(format, setLoaded), [format]);
  return loaded !== null && loaded.format === format
    ? loaded.component
    : undefined;
};

/** The most an agent's `read` returns at once, in characters, and the most places `find` returns. */
const READ_MOST = 20_000;
const FIND_MOST = 50;

// The kind of file, for an agent (a person reads `labels.format`).
const KIND: Record<ArtifactFormat, string> = {
  markdown: "Markdown",
  code: "Code",
  text: "Text",
  image: "Image",
  pdf: "PDF",
  csv: "Table",
  html: "HTML",
  unknown: "File",
};

const styles = stylex.create({
  root: {
    containerType: "inline-size",
    containerName: "viewer",
    position: "relative",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr)",
    width: "100%",
    height: "100%",
    minHeight: grasp.viewerMinHeight,
    overflow: "hidden",
    borderRadius: "inherit",
    backgroundColor: grasp.viewerGround,
  },
  // The document, with the outline before it and the comments after it, when they are open.
  body: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    minHeight: 0,
  },
  // The scroller draws no ring of its own: the ring layer after it draws it (below).
  noRing: { outline: "none" },
  // The document's keyboard ring, drawn on a layer over its cell, not on the scroller: on the
  // scroller a wide table or a long page scrolled over its right and bottom edges. The layer is a
  // grid item of its own in the document's cell, right after the scroller, above the content, and
  // takes no presses. A band of the viewer's own ground inside the ring, so the ring stands on that
  // ground and never on the document under it: a light page (a PDF, a web page) in dark, where the
  // ring's light ink would all but vanish.
  ringLayer: {
    gridColumn: 2,
    gridRow: 1,
    zIndex: 3,
    pointerEvents: "none",
    borderEndStartRadius: grasp.corner,
    borderEndEndRadius: grasp.corner,
    outlineStyle: {
      default: "none",
      ':is([role="document"]:focus-visible + *)': "solid",
    },
    outlineWidth: {
      default: grasp.ringWidth,
      [media.forced]: `calc(2 * ${grasp.ringWidth})`,
    },
    outlineColor: { default: grasp.ring, [media.forced]: "Highlight" },
    outlineOffset: {
      default: `calc(-1 * ${grasp.ringWidth})`,
      [media.forced]: `calc(-2 * ${grasp.ringWidth})`,
    },
    boxShadow: {
      default: "none",
      ':is([role="document"]:focus-visible + *)': {
        default: `inset 0 0 0 calc(3 * ${grasp.ringWidth}) ${grasp.viewerGround}`,
        [media.forced]: "none",
      },
    },
  },
  viewport: {
    gridColumn: 2,
    gridRow: 1,
    position: "relative",
    // Words comments hold on to: a soft tint, never a border; the open comment's stronger. A PDF's
    // text layer draws its own, see-through (renderers/pdf/page.tsx).
    // In forced colours, the system's own marks: Mark for a comment, Highlight for the open one.
    "::highlight(viewer-comment)": {
      backgroundColor: { default: grasp.viewerComment, [media.forced]: "Mark" },
      color: { default: "inherit", [media.forced]: "MarkText" },
    },
    // An agent's proposed edit: its words struck, as Diff strikes a word taken out; the words an
    // edit just put in, underlined, for a moment. Never by colour alone.
    "::highlight(viewer-proposal)": {
      backgroundColor: {
        default: grasp.diffRemovedWord,
        [media.forced]: "Mark",
      },
      textDecoration: "line-through",
      textDecorationColor: {
        default: grasp.danger,
        [media.forced]: "MarkText",
      },
      color: { default: "inherit", [media.forced]: "MarkText" },
    },
    "::highlight(viewer-edited)": {
      backgroundColor: {
        default: grasp.diffAddedWord,
        [media.forced]: "Highlight",
      },
      textDecoration: "underline",
      textDecorationColor: {
        default: grasp.success,
        [media.forced]: "HighlightText",
      },
      color: { default: "inherit", [media.forced]: "HighlightText" },
    },
    "::highlight(viewer-comment-active)": {
      backgroundColor: {
        default: grasp.viewerCommentActive,
        [media.forced]: "Highlight",
      },
      color: { default: "inherit", [media.forced]: "HighlightText" },
    },
    overflow: "auto",
    overscrollBehavior: "auto",
    padding: {
      default: grasp.viewerGap,
      "@container viewer (max-width: 560px)": grasp.space2,
    },
    // Keys scroll it: the arrows, Page Up and Down, Space.
    outlineOffset: `calc(-1 * ${grasp.ringWidth})`,
  },
  fill: { height: "100%" },
  centre: {
    display: "grid",
    placeItems: "center",
    height: "100%",
    gap: grasp.space2,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    color: grasp.muted,
  },
  // What the renderer draws. At least the viewport's height, so a short file (an image) can sit
  // in its middle. It fades in on the shared arrive motion, in place of the spinner.
  drawn: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    minHeight: "100%",
  },
  // The outline: the file's headings or pages, a landmark to move by. Before the document; over it
  // in a narrow viewer.
  outline: {
    gridColumn: {
      default: 1,
      "@container viewer (max-width: 560px)": "1 / -1",
    },
    gridRow: 1,
    boxSizing: "border-box",
    width: {
      default: grasp.viewerOutlineWidth,
      "@container viewer (max-width: 560px)": "100%",
    },
    minHeight: 0,
    overflow: "auto",
    position: {
      default: "relative",
      "@container viewer (max-width: 560px)": "absolute",
    },
    insetBlock: { default: null, "@container viewer (max-width: 560px)": 0 },
    insetInline: { default: null, "@container viewer (max-width: 560px)": 0 },
    zIndex: { default: null, "@container viewer (max-width: 560px)": 3 },
    padding: grasp.space2,
    backgroundColor: grasp.raised,
    boxShadow: `inset calc(-1 * ${grasp.hairline}) 0 0 ${grasp.line}`,
  },
  outlineList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "grid",
    gap: grasp.space1,
  },
  outlineItem: {
    display: "block",
    width: "100%",
    paddingBlock: grasp.space1,
    paddingInlineEnd: grasp.space2,
    borderWidth: 0,
    borderRadius: grasp.cornerMark,
    backgroundColor: {
      default: "transparent",
      ":hover": grasp.ghostFillHover,
      ":is([aria-current])": grasp.soft,
    },
    textAlign: "start",
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: { default: grasp.text, ":is([aria-current])": grasp.ink },
    cursor: "pointer",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    outline: {
      default: "none",
      ":focus-visible": `${grasp.ringWidth} solid ${grasp.ring}`,
    },
    outlineOffset: `calc(-1 * ${grasp.ringWidth})`,
  },
  depth: (depth: number) => ({
    paddingInlineStart: `calc(${grasp.space2} + ${depth} * ${grasp.space3})`,
  }),
  keys: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: `${grasp.space2} ${grasp.space4}`,
    margin: 0,
  },
  keyRow: { display: "contents" },
  keyName: {
    margin: 0,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
  },
  keyKeys: {
    margin: 0,
    display: "flex",
    gap: grasp.space1,
    justifyContent: "end",
  },
});

export interface ViewerProps extends ArtifactSource {
  /** The prefix of its state in the link, so two viewers on a page keep their own. */
  id: string;
  /** Where PDF.js's `cmaps/`, `standard_fonts/`, `wasm/` and `iccs/` folders are served. */
  pdfAssets?: string;
  /** Let a web page's scripts run, inside its sandbox. */
  allowScripts?: boolean;
  /** Where its state lives: the query string (the default), your router's adapter, or nowhere. */
  location?: ViewerLocation | "none";
  comments?: CommentThread[];
  onComment?: CommentHandler;
  onReply?: (threadId: string, body: string) => void;
  onResolve?: (threadId: string, resolved: boolean) => void;
  onDelete?: (threadId: string, itemId: string) => void;
  commentAuthor?: CommentAuthor;
  rowKey?: (cells: readonly string[]) => string;
  onEdit?: (patch: EditPatch) => void;
  agentEdits?: AgentEdits;
  /** An app being built for the first time: App building stands in place of the file until it is cleared. */
  building?: boolean | { step?: string };
  /** The product's words; any left out are English. */
  labels?: Partial<ArtifactViewerLabels>;
}

// The row under the reading line, a third of the way down the viewport; at the foot of the file,
// the last row on screen. Null while no row is drawn.
const readingRow = (scroller: HTMLElement): number | null => {
  const view = scroller.getBoundingClientRect();
  const atFoot =
    scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
  const line = atFoot ? view.bottom - 1 : view.top + view.height / 3;
  let found: number | null = null;
  for (const element of scroller.querySelectorAll<HTMLElement>("[data-row]")) {
    const index = Number(element.dataset.row);
    if (
      element.getBoundingClientRect().top <= line &&
      (found === null || index > found)
    ) {
      found = index;
    }
  }
  return found;
};

// Reads the reading line once a frame as the viewport scrolls, and once now.
const followReading = (
  scroller: HTMLElement,
  onRead: (row: number | null) => void
) => {
  let frame = 0;
  const read = () => {
    frame = 0;
    onRead(readingRow(scroller));
  };
  const scrolled = () => {
    if (frame === 0) {
      frame = requestAnimationFrame(read);
    }
  };
  scrolled();
  scroller.addEventListener("scroll", scrolled, { passive: true });
  return () => {
    scroller.removeEventListener("scroll", scrolled);
    cancelAnimationFrame(frame);
  };
};

type Status =
  | { kind: "loading" }
  | { kind: "ready"; artifact: OpenedArtifact }
  | { kind: "error"; message: string };

interface OpenHandlers {
  /** Shows where the opening is. */
  show: (status: Status) => void;
  /** Clears the old file's note. */
  clear: () => void;
  /** Told of every file opened, to close it later. */
  keep: (artifact: OpenedArtifact) => void;
}

// Opens a source into the viewer: loading at once, then the file or why it did not open. A load
// no longer wanted closes its file.
const openInto = async (
  source: ArtifactSource,
  signal: AbortSignal,
  words: OpenWords & Pick<ArtifactViewerLabels, "didNotLoad">,
  { show, clear, keep }: OpenHandlers
) => {
  show({ kind: "loading" });
  clear();
  let artifact: OpenedArtifact;
  try {
    artifact = await openArtifact(source, words, signal);
  } catch (error: unknown) {
    if (!signal.aborted) {
      show({
        kind: "error",
        message: error instanceof Error ? error.message : words.didNotLoad,
      });
    }
    return;
  }
  keep(artifact);
  if (signal.aborted) {
    artifact.close();
    return;
  }
  // The Worker loads beside the renderer's code, not after it: the first rows wait on both.
  warmWorker(artifact.format);
  show({ kind: "ready", artifact });
};

// Focus is in a field, where keys type.
const typing = () => {
  const element = document.activeElement;
  return (
    element instanceof HTMLElement &&
    (element.isContentEditable ||
      /^(?:input|textarea|select)$/iu.test(element.tagName))
  );
};

// What the link says, as the view starts.
const initialView = (start: ViewState) => ({
  zoom: start.zoom ?? "fit",
  find: start.find ?? "",
  findOpen: Boolean(start.find),
  mode: start.mode ?? "preview",
  row: Math.max(0, (start.at ?? 1) - 1),
  comment: start.comment ?? null,
  panel: Boolean(start.comment),
});

// A web page or Markdown: it has a preview, and its source as code.
const hasPreview = (artifact: OpenedArtifact | null) =>
  artifact !== null &&
  (artifact.format === "html" || artifact.format === "markdown");

// A web page shown as its preview, where comments and edits work on the page, not its source.
const previewsPage = (
  artifact: OpenedArtifact | null,
  mode: "preview" | "code"
) => artifact !== null && artifact.format === "html" && mode === "preview";

// A file whose rows are lines: code and plain text.
const isLined = (shown: OpenedArtifact | null) =>
  shown !== null && (shown.format === "code" || shown.format === "text");

// The file's name: as it opened, as it was given, or "File".
const nameOf = (
  artifact: OpenedArtifact | null,
  given: string | undefined,
  file: string
) => artifact?.name ?? given ?? file;

// The kind of file, for the toolbar: a language by the name people write it.
/** The viewer's words: the catalogue's (else English), with the caller's `labels` over them. */
const labelsOver = (
  words: ArtifactViewerLabels,
  given: Partial<ArtifactViewerLabels> | undefined
) => withGiven(words, given ?? {});

const kindOf = (
  artifact: OpenedArtifact | null,
  labels: ArtifactViewerLabels
) => {
  if (artifact === null) {
    return "";
  }
  if (
    artifact.format === "code" &&
    artifact.language !== undefined &&
    artifact.language !== ""
  ) {
    return labels.language(artifact.language);
  }
  return labels.format(artifact.format);
};

interface PositionInput {
  format: ArtifactFormat | undefined;
  lined: boolean;
  row: number;
  rows: number;
  sections: readonly Section[];
  current: Section | undefined;
  labels: ArtifactViewerLabels;
}

// Where you are, in the format's own terms: the heading above, or the line. A Markdown file's rows
// are blocks, not lines, so without headings it says nothing rather than a wrong count.
const positionOf = ({
  format,
  lined,
  row,
  rows,
  sections,
  current,
  labels,
}: PositionInput) => {
  if (format === "pdf" && rows !== 0) {
    return labels.position("page", row + 1, rows);
  }
  if (format === "csv" && rows !== 0) {
    return labels.position("row", row + 1, rows);
  }
  if (sections.length > 0) {
    return current?.label ?? labels.start;
  }
  if (lined && rows > 1) {
    return labels.position("line", row + 1, rows);
  }
  return "";
};

// An image's size, for an agent: none until it has loaded.
const sizeOf = (value: number | undefined) =>
  value === undefined || value === 0 ? undefined : value;

// Where a thread is, for an agent: a cell, a box, or a range of the text (on a page, for a PDF).
const placeOf = (anchor: Anchor, start: number, end: number) => {
  if (anchor.kind === "cell") {
    return { row: anchor.row, column: anchor.column, header: anchor.header };
  }
  if (anchor.kind === "rect") {
    return { x: anchor.x, y: anchor.y, w: anchor.w, h: anchor.h };
  }
  return {
    ...(anchor.kind === "pdf" ? { page: anchor.page } : {}),
    start,
    end,
  };
};

// A thread's state, for an agent: resolved, open where its words are, or orphaned when they have gone.
const threadStatus = (resolved: boolean | undefined, order: unknown) => {
  if (resolved === true) {
    return "resolved";
  }
  return order === null ? "orphaned" : "open";
};

// The keys, in the shortcuts dialog. Drawn once, not each time the viewer draws.
interface KeyListProps {
  comments: boolean;
  edits: boolean;
  describe: ArtifactViewerLabels["shortcut"];
}

const KeyList = ({ comments, edits, describe }: KeyListProps) => (
  <dl {...stylex.props(styles.keys)}>
    {VIEWER_KEYS.filter(
      (key) =>
        (key.comments !== true || comments) && (key.edits !== true || edits)
    ).map((key) => (
      <div key={key.action} {...stylex.props(styles.keyRow)}>
        <dt {...stylex.props(styles.keyName)}>{describe(key.action)}</dt>
        <dd {...stylex.props(styles.keyKeys)}>
          {key.keys.map((keys) => (
            <Kbd key={keys}>
              {keys === "shift+?" ? "?" : formatShortcut(keys)}
            </Kbd>
          ))}
        </dd>
      </div>
    ))}
  </dl>
);

/** The sections a renderer said last, and how many times one has said them. */
interface SectionsSaid {
  sections: Section[];
  reports: number;
}

const sectionsSaid = (
  state: SectionsSaid,
  sections: Section[]
): SectionsSaid => ({ sections, reports: state.reports + 1 });

/**
 * A renderer says its sections with a new list each time, even an empty one: counted, so the
 * render after it knows a report came, and the dispatch is stable, so the renderers' effects that
 * hold it do not run again at every render. `reported` is the file whose renderer has said them:
 * until then the bar's controls hold their room unseen, so the section buttons and the outline
 * arrive in their places, not pushing the preview switch aside (a layout shift as Markdown
 * opened). It is taken in the render that sees a new report: the file shown then has said them.
 */
const useSectionsReported = (status: {
  kind: string;
  artifact?: OpenedArtifact;
}) => {
  const [said, setSections] = useReducer(sectionsSaid, {
    sections: [],
    reports: 0,
  });
  const [reportedAt, setReportedAt] = useState<{
    reports: number;
    artifact: OpenedArtifact | null;
  }>({ reports: 0, artifact: null });
  if (reportedAt.reports !== said.reports) {
    setReportedAt({
      reports: said.reports,
      artifact: status.kind === "ready" ? (status.artifact ?? null) : null,
    });
  }
  return {
    sections: said.sections,
    setSections,
    reported: reportedAt.artifact,
  };
};

interface OutlineProps {
  sections: readonly Section[];
  current: Section | undefined;
  onJump: (row: number) => void;
  label: string;
}

// The outline: the file's headings or pages, a landmark to move by.
const Outline = ({ sections, current, onJump, label }: OutlineProps) => (
  <nav
    aria-label={label}
    data-slot="artifact-viewer-outline"
    {...stylex.props(styles.outline)}
  >
    <ol {...stylex.props(styles.outlineList)}>
      {sections.map((section) => (
        <li key={`${section.row}-${section.label}`}>
          <button
            type="button"
            aria-current={current === section ? "location" : undefined}
            onClick={() => {
              onJump(section.row);
            }}
            {...stylex.props(
              styles.outlineItem,
              styles.depth(Math.max(0, (section.depth ?? 1) - 1))
            )}
          >
            {section.label}
          </button>
        </li>
      ))}
    </ol>
  </nav>
);

/** The scrolling viewport takes focus, so the keys scroll it: the arrows, Page Up and Down, Space. */
const VIEWPORT_TAB_INDEX = 0;

type DrawProps = Omit<RendererProps, "artifact" | "scroller">;

interface DocumentProps {
  status: Status;
  /** What is drawn: the file, or its source in code view. */
  shown: OpenedArtifact | null;
  sourceName: string | undefined;
  scroller: HTMLDivElement | null;
  setScroller: (element: HTMLDivElement | null) => void;
  mode: "preview" | "code";
  draw: DrawProps;
  building: ViewerProps["building"];
}

const buildingStyles = stylex.create({
  // The build takes the viewport's room, and no more: it never makes the viewport scroll.
  box: { minHeight: 0 },
});

// App building's code, fetched the first time a viewer is told an app is being built: a viewer
// that never is pays nothing for it.
let buildingLoad: Promise<ComponentType<AppBuildingProps>> | null = null;
const importBuilding = async () => {
  const { AppBuilding } = await import("../app-building/app-building");
  return AppBuilding;
};
const loadBuilding = async () => {
  buildingLoad ??= importBuilding();
  return await buildingLoad;
};
const watchBuilding = (
  show: (component: ComponentType<AppBuildingProps>) => void
) => {
  let live = true;
  const load = async () => {
    const component = await loadBuilding();
    if (live) {
      show(component);
    }
  };
  void load();
  return () => {
    live = false;
  };
};

// While an app is built for the first time: App building, in the viewer's words, in place of the file.
const Building = ({
  building,
  labels,
}: {
  building: true | { step?: string };
  labels: ArtifactViewerLabels;
}) => {
  const [stage, setStage] = useState<ComponentType<AppBuildingProps> | null>(
    null
  );
  useEffect(
    () =>
      watchBuilding((component) => {
        setStage(() => component);
      }),
    []
  );
  const Stage = stage;
  if (Stage === null) {
    return null;
  }
  const cursors = {
    layout: labels.builderLayout,
    data: labels.builderData,
    copy: labels.builderCopy,
  };
  return (
    <Stage
      step={building === true ? undefined : building.step}
      aria-label={labels.building}
      cursors={cursors}
      layout={buildingStyles.box}
    />
  );
};

// The scrolling viewport: opening, why the file did not open, a file of no kind it shows, or the file.
const DocumentView = ({
  status,
  shown,
  sourceName,
  scroller,
  setScroller,
  mode,
  draw,
  building,
}: DocumentProps) => {
  const { labels } = draw;
  const ringId = useId();
  const artifact = status.kind === "ready" ? status.artifact : null;
  const Renderer = useRenderer(shown?.format);
  const known = shown !== null && RENDERER_LOADERS[shown.format] !== undefined;
  let content: ReactNode = null;
  if (status.kind === "loading") {
    content = (
      <div {...stylex.props(styles.centre)}>
        <Spinner aria-label={labels.opening(sourceName)} size="md" />
      </div>
    );
  } else if (status.kind === "error") {
    content = (
      <Empty tone="danger">
        <EmptyHeader>
          <EmptyMedia />
          <EmptyTitle>{labels.notOpened}</EmptyTitle>
          <EmptyDescription>{status.message}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (artifact !== null && !known) {
    content = (
      <div {...stylex.props(styles.centre)}>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{labels.unknownKind}</EmptyTitle>
            <EmptyDescription>
              <Button
                icon={Download}
                render={
                  <a
                    href={artifact.url}
                    download={artifact.name}
                    aria-label={labels.download(artifact.name)}
                  />
                }
              >
                {labels.download(artifact.name)}
              </Button>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  } else if (
    artifact !== null &&
    shown !== null &&
    Renderer !== undefined &&
    scroller !== null
  ) {
    content = (
      <div key={mode} {...stylex.props(styles.drawn, arrive.in)}>
        {createElement(Renderer, { artifact: shown, scroller, ...draw })}
      </div>
    );
  } else if (artifact !== null) {
    content = (
      <div {...stylex.props(styles.centre)}>
        <Spinner aria-label={labels.opening(artifact.name)} size="md" />
      </div>
    );
  }
  const isBuilding = building !== undefined && building !== false;
  return (
    <>
      <div
        ref={setScroller}
        data-ring-on={ringId}
        tabIndex={VIEWPORT_TAB_INDEX}
        role="document"
        aria-label={artifact?.name ?? labels.file}
        aria-busy={status.kind === "loading" || isBuilding || undefined}
        {...stylex.props(styles.viewport, styles.noRing, scroll.bar)}
      >
        {isBuilding ? (
          <Building building={building} labels={labels} />
        ) : (
          content
        )}
      </div>
      <div id={ringId} aria-hidden {...stylex.props(styles.ringLayer)} />
    </>
  );
};

// Where the view is kept (the address, the caller's own adapter, or memory alone), with the view it
// holds as it is made.
const makeLink = (prop: ViewerProps["location"], id: ViewerProps["id"]) => {
  const location =
    prop === "none" ? memoryLocation() : (prop ?? queryLocation(id));
  return { prop, id, location, start: location.read() };
};

const useLink = (prop: ViewerProps["location"], id: ViewerProps["id"]) => {
  const [link, setLink] = useState(() => makeLink(prop, id));
  if (link.prop !== prop || link.id !== id) {
    setLink(makeLink(prop, id));
  }
  return link;
};

/** The view as the link keeps it. */
const viewOf = (
  row: number,
  zoom: number | "fit",
  find: string,
  mode: "preview" | "code",
  comment: string | null,
  anchor: string | undefined
) => ({
  at: row + 1,
  zoom,
  find,
  mode,
  comment: comment ?? undefined,
  anchor,
});

// What is drawn: in code view, a web page or Markdown is its source, highlighted.
const shownOf = (
  artifact: OpenedArtifact | null,
  previewed: boolean,
  mode: "preview" | "code"
) =>
  artifact && previewed && mode === "code"
    ? {
        ...artifact,
        format: "code" as const,
        language: artifact.format === "html" ? "markup" : "markdown",
      }
    : artifact;

export const Viewer = ({
  id,
  location: locationProp,
  pdfAssets,
  allowScripts,
  comments,
  onComment,
  onReply,
  onResolve,
  onDelete,
  commentAuthor,
  rowKey,
  onEdit,
  agentEdits = "propose",
  building,
  labels: given,
  ...source
}: ViewerProps) => {
  // The words it shows and says, made once here and handed down.
  const labels = labelsOver(useWords("artifactViewer", englishLabels), given);
  // The link's adapter, and the view it named as the viewer opened: made once for this adapter and id.
  const { location, start } = useLink(locationProp, id);
  const initial = initialView(start);

  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [zoom, setZoom] = useState<number | "fit">(initial.zoom);
  const [find, setFind] = useState(initial.find);
  const [findOpen, setFindOpen] = useState(initial.findOpen);
  // A web page or Markdown shows its preview, or its source as code.
  const [mode, setMode] = useState<"preview" | "code">(initial.mode);
  const [match, setMatch] = useState(0);
  const [matches, setMatches] = useState(0);
  const [capped, setCapped] = useState(false);
  // The sections a renderer says, and the file whose renderer has said them (useSectionsReported).
  const { sections, setSections, reported } = useSectionsReported(status);
  const [rows, setRows] = useState(0);
  const [row, setRow] = useState(initial.row);
  const [help, setHelp] = useState(false);
  const [note, setNote] = useState("");
  const [findNote, setFindNote] = useState("");
  // Comments and the outline: the open thread and a shared place are in the link.
  const [activeThread, setActiveThread] = useState<string | null>(
    initial.comment
  );
  const [linkedAnchor, setLinkedAnchor] = useState<string | undefined>(
    start.anchor
  );
  const [panel, setPanel] = useState(initial.panel);
  const [outline, setOutline] = useState(false);
  const [pages, setPages] = useState<readonly (string | undefined)[]>([]);
  const [table, setTable] = useState<TableShape | null>(null);
  const [rowOf, setRowOf] = useState<
    ((part: number, offset: number) => number) | null
  >(null);
  const onRowOf = (next: (part: number, offset: number) => number) => {
    setRowOf(() => next);
  };
  const control = useRef<RendererControl | null>(null);
  const findField = useRef<HTMLInputElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  // Open the file; a new source replaces the old, and the old object URL is let go.
  const { src, file, text, name, type, language } = source;
  // The words opening says, as they are now: new words are no reason to open the file again.
  const openWords = useEffectEvent(() => labels);
  useEffect(() => {
    const abort = new AbortController();
    let opened: OpenedArtifact | null = null;
    void openInto(
      { src, file, text, name, type, language },
      abort.signal,
      openWords(),
      {
        show: setStatus,
        clear: () => {
          setNote("");
        },
        keep: (artifact) => {
          opened = artifact;
        },
      }
    );
    return () => {
      abort.abort();
      opened?.close();
    };
  }, [src, file, text, name, type, language]);

  // The link follows the view: replaced as it scrolls, pushed on a deliberate jump.
  const write = (
    how: "replace" | "push",
    next: {
      at?: number;
      zoom?: number | "fit";
      find?: string;
      mode?: "preview" | "code";
      comment?: string | null;
      anchor?: string | null;
    } = {}
  ) => {
    location.write(
      {
        at: (next.at ?? row) + 1,
        zoom: next.zoom ?? zoom,
        find: next.find ?? find,
        mode: next.mode ?? mode,
        comment:
          (next.comment === undefined ? activeThread : next.comment) ??
          undefined,
        anchor:
          (next.anchor === undefined ? linkedAnchor : next.anchor) ?? undefined,
      },
      how
    );
  };
  const setActive = (next: string | null, how: "push" | "replace") => {
    setActiveThread(next);
    write(how, { comment: next });
  };
  const setLinked = (next: string | undefined) => {
    setLinkedAnchor(next);
    write("replace", { anchor: next ?? null });
  };
  const onRow = (next: number) => {
    setRow(next);
  };
  const onMatches = (count: number, more = false) => {
    setMatches(count);
    setCapped(more);
  };
  // Whenever the view changes, a moment later, the link is brought up to date.
  const view = viewOf(row, zoom, find, mode, activeThread, linkedAnchor);
  useEffect(() => {
    const timer = setTimeout(() => {
      location.write(view, "replace");
    }, 150);
    return () => {
      clearTimeout(timer);
    };
  }, [location, view]);

  // Back and Forward: the view the link names.
  useEffect(
    () =>
      location.listen(() => {
        const state = location.read();
        setZoom(state.zoom ?? "fit");
        setFind(state.find ?? "");
        setFindOpen(Boolean(state.find));
        setMode(state.mode ?? "preview");
        setActiveThread(state.comment ?? null);
        // After the new zoom has laid the rows out.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            control.current?.scrollToRow(Math.max(0, (state.at ?? 1) - 1));
          });
        });
      }),
    [location]
  );

  const jump = (target: number) => {
    const next = Math.max(0, Math.min(rows - 1, target));
    write("push", { at: next });
    control.current?.scrollToRow(next);
  };

  // With headings, a step is a heading; without, a screenful.
  const step = (direction: 1 | -1) => {
    if (sections.length > 0) {
      const target =
        direction > 0
          ? sections.find((section) => section.row > row)
          : sections.toReversed().find((section) => section.row < row);
      if (target) {
        jump(target.row);
      } else {
        jump(direction > 0 ? rows - 1 : 0);
      }
      return;
    }
    scroller?.scrollBy({ top: direction * scroller.clientHeight * 0.9 });
  };

  const changeZoom = (next: number | "fit") => {
    setZoom(next);
    write("replace", { zoom: next });
  };

  const openFind = () => {
    setFindOpen(true);
    findField.current?.select();
  };
  // Focus goes to find as it opens, once its field is in the page.
  const opened = useRef(findOpen);
  useEffect(() => {
    if (findOpen && !opened.current) {
      findField.current?.select();
    }
    opened.current = findOpen;
  }, [findOpen]);
  const closeFind = () => {
    setFindOpen(false);
    setFind("");
    setMatch(0);
    write("replace", { find: "" });
    scroller?.focus();
  };
  // New words to find: from their first match.
  const changeFind = (value: string) => {
    setFind(value);
    setMatch(0);
  };
  const moveMatch = (direction: 1 | -1) => {
    if (matches === 0) {
      return;
    }
    setMatch((current) => (current + direction + matches) % matches);
  };

  // Preview or code: a deliberate change, so Back returns. The source starts at its top.
  const artifact = status.kind === "ready" ? status.artifact : null;
  const previewed = hasPreview(artifact);
  const switchView = (next: "preview" | "code") => {
    if (!previewed || next === mode) {
      return;
    }
    setMode(next);
    setRow(0);
    setSections([]);
    setNote("");
    setMatch(0);
    write("push", { mode: next, at: 0 });
  };

  // In code view, a web page or Markdown is its source, highlighted.
  const shown = shownOf(artifact, previewed, mode);
  // The viewer's one live region: what comments and edits do, said to a screen reader. Cleared
  // first, so the same words twice are read twice.
  const [said, setSaid] = useState("");
  const say = (words: string) => {
    setSaid("");
    requestAnimationFrame(() => {
      setSaid(words);
    });
  };
  const kind = anchorKindOf(shown?.format);
  const preview = previewsPage(artifact, mode);
  const sourceText = artifact?.text;
  const edits = viewerExtras.useEdits({
    viewer: id,
    onEdit,
    mode: agentEdits,
    kind,
    source: sourceText,
    table,
    threads: comments,
    scroller,
    root,
    say,
    preview,
    labels,
  });
  // A different file (another src, File or name): its proposals and its undo go with the old one.
  // New text for the same file, as after an accept or an undo, keeps them.
  const resetEdits = useEffectEvent(() => {
    edits.reset();
  });
  const known = useRef({ src, file, name });
  useEffect(() => {
    const was = known.current;
    if (was.src === src && was.file === file && was.name === name) {
      return;
    }
    known.current = { src, file, name };
    resetEdits();
  }, [src, file, name]);
  const notes = viewerExtras.useComments({
    viewer: id,
    threads: comments,
    author: commentAuthor,
    onComment,
    onReply,
    onResolve,
    onDelete,
    kind,
    preview,
    source: sourceText,
    pages,
    table,
    rowOf,
    scroller,
    root,
    control,
    active: activeThread,
    setActive,
    initialLinked: start.anchor,
    setLinked,
    findOpen,
    open: panel,
    setOpen: setPanel,
    onShowCode: () => {
      switchView("code");
    },
    say,
    threadExtra: edits.forThread,
    panelExtra: edits.loose,
    labels,
  });

  const handleZoomIn = () => {
    changeZoom(zoomStep(zoom, 1));
  };
  const handleZoomOut = () => {
    changeZoom(zoomStep(zoom, -1));
  };
  const handleZoomReset = () => {
    changeZoom("fit");
  };
  // The keys: only for the viewer last used, and never while typing in a field.
  const run: Record<ViewerAction, () => void> = {
    next: () => {
      step(1);
    },
    previous: () => {
      step(-1);
    },
    first: () => {
      jump(0);
    },
    last: () => {
      jump(rows - 1);
    },
    zoomIn: handleZoomIn,
    zoomOut: handleZoomOut,
    zoomReset: handleZoomReset,
    find: openFind,
    findNext: () => {
      moveMatch(1);
    },
    findPrevious: () => {
      moveMatch(-1);
    },
    close: () => {
      if (help) {
        setHelp(false);
      } else if (findOpen) {
        closeFind();
      } else if (panel || outline) {
        // A panel closed by Escape: focus goes back to the document, never to the page.
        if (panel) {
          setPanel(false);
        } else {
          setOutline(false);
        }
        scroller?.focus();
      }
    },
    help: () => {
      setHelp(true);
    },
    view: () => {
      switchView(mode === "code" ? "preview" : "code");
    },
    outline: () => {
      setOutline((open) => !open);
    },
    comment: () => {
      notes.commentHere();
    },
    comments: () => {
      setPanel((open) => !open);
    },
    nextComment: () => {
      notes.next();
    },
    previousComment: () => {
      notes.previous();
    },
    undo: () => {
      edits.undo();
    },
    redo: () => {
      edits.redo();
    },
  };
  // The keys are the viewer's only while focus is inside it (a click on the file focuses it), so
  // the page and its fields keep theirs, and with two viewers only the one in use answers.
  const mine = () => root.current?.contains(document.activeElement) === true;
  // Every key, registered once: what each does and whether it may are read as they are now.
  const press = useEffectEvent((action: ViewerAction) => {
    run[action]();
  });
  // What each key does, in words, for the page's list of shortcuts: as the labels are when it is registered.
  const describe = useEffectEvent((action: ViewerAction) =>
    labels.shortcut(action)
  );
  const may = useEffectEvent(
    (key: ViewerKey) =>
      mine() &&
      (key.comments !== true || comments !== undefined) &&
      // Undo in a field is the field's own: a reply being written, find's words.
      (key.edits !== true || (edits.on && !typing())) &&
      (key.action !== "close" || findOpen || help || panel || outline)
  );
  useEffect(() => {
    const stops = VIEWER_KEYS.flatMap((key) =>
      key.keys.map((keys) =>
        registerShortcut(
          keys,
          () => {
            press(key.action);
          },
          { description: describe(key.action), when: () => may(key) }
        )
      )
    );
    return () => {
      for (const stop of stops) {
        stop();
      }
    };
  }, []);

  // The section being read: the last heading above a reading line a third of the way down the
  // document, not the block at its very top, so a heading just under the toolbar already counts.
  // At the foot of the file, where the last headings can never reach that line, the last one on
  // screen counts. Read once a frame as it scrolls, and again when the sections change.
  const [reading, setReading] = useState<number | null>(null);
  useEffect(
    () =>
      scroller === null || sections.length === 0
        ? undefined
        : followReading(scroller, setReading),
    [scroller, sections]
  );
  const readRow = reading ?? row;
  const current = sections.findLast((section) => section.row <= readRow);

  const position = positionOf({
    format: artifact?.format,
    lined: isLined(shown),
    row,
    rows,
    sections,
    current,
    labels,
  });

  // What an agent may ask, through the page's one agent bridge: always the file as it is now.
  const tools: ViewerTools = {
    read: (input) => {
      if (!artifact) {
        return { error: "The file is not open yet." };
      }
      const base = { name: artifact.name, kind: KIND[artifact.format] };
      if (artifact.format === "image") {
        const image = scroller?.querySelector("img");
        return {
          ...base,
          width: sizeOf(image?.naturalWidth),
          height: sizeOf(image?.naturalHeight),
          note: "An image has no text to read.",
        };
      }
      const page =
        artifact.format === "pdf"
          ? Math.max(0, Math.floor(input?.page ?? 0))
          : undefined;
      const content = page === undefined ? (artifact.text ?? "") : pages[page];
      if (content === undefined) {
        return {
          ...base,
          page,
          error: artifactViewerNotices.pageUnread((page ?? 0) + 1),
        };
      }
      // Whole characters at both ends: a page never splits an emoji in two.
      const offset = wholeAt(
        content,
        Math.max(0, Math.min(content.length, Math.floor(input?.offset ?? 0)))
      );
      const end = wholeAt(
        content,
        Math.min(content.length, offset + READ_MOST)
      );
      return {
        ...base,
        ...(page === undefined ? {} : { page, pages: rows }),
        offset,
        text: content.slice(offset, end),
        total: content.length,
        next: end < content.length ? end : null,
      };
    },
    outline: () =>
      sections.map((section) => ({
        label: section.label,
        depth: section.depth,
        row: section.row,
      })),
    comments: () =>
      notes.placed.map((entry) => ({
        id: entry.thread.id,
        status: threadStatus(entry.thread.resolved, entry.order),
        quote: entry.quote,
        place: placeOf(entry.thread.anchor, entry.start, entry.end),
        comments: entry.thread.items.map((item) => ({
          author: item.author.name,
          body: item.body,
          at: item.at,
        })),
        proposals: edits.proposals
          .filter((placed) => placed.proposal.threadId === entry.thread.id)
          .map((placed) => ({
            id: placed.proposal.id,
            status:
              placed.range || placed.proposal.status !== "pending"
                ? placed.proposal.status
                : "stale",
          })),
      })),
    find: (input) => {
      const query = (
        typeof input === "string" ? input : (input?.query ?? "")
      ).trim();
      if (!query) {
        return { error: "Give the words to find." };
      }
      const pattern = new RegExp(
        query.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
        "giu"
      );
      const texts =
        artifact?.format === "pdf"
          ? pages.map((pageText, page) => ({ content: pageText, page }))
          : [{ content: artifact?.text, page: undefined }];
      const places: unknown[] = [];
      for (const { content, page } of texts) {
        if (content === undefined) {
          continue;
        }
        for (const found of content.matchAll(pattern)) {
          if (places.length === FIND_MOST) {
            return { places, more: true };
          }
          places.push({
            ...(page === undefined ? {} : { page }),
            start: found.index,
            end: found.index + found[0].length,
            context: content.slice(
              Math.max(0, found.index - 40),
              found.index + found[0].length + 40
            ),
          });
        }
      }
      return { places, more: false };
    },
    proposeEdit: (input) => edits.propose(input),
  };
  const agentHandle = usePrimitive(artifactViewerAgent, { tools });

  const fileName = nameOf(artifact, source.name, labels.file);
  const draw: DrawProps = {
    labels,
    zoom,
    find: findOpen ? find : "",
    match,
    initialRow: row,
    onSections: setSections,
    onRows: setRows,
    onRow,
    onMatches,
    control,
    pdfAssets,
    allowScripts,
    onNote: setNote,
    onFindNote: setFindNote,
    onTexts: setPages,
    wantedParts: notes.wantedParts,
    onRowOf,
    onTable: setTable,
    rowKey,
    commenting: notes.on,
    notes: notes.notes,
    onOpenThread: notes.openThread,
    onDrawAnchor: notes.startDraft,
    proposals: edits.cellProposals,
  };

  return usePart(
    agentHandle,
    "root",
    {},
    {
      ref: root,
      // The name the agent bridge knows it by: the file's.
      "aria-label": fileName,
      ...stylex.props(styles.root),
      children: (
        <>
          <Toolbar
            labels={labels}
            name={fileName}
            kind={kindOf(artifact, labels)}
            note={note}
            findNote={findNote}
            view={previewed ? { mode, onChange: switchView } : undefined}
            position={position}
            canJump={rows > 1}
            onPrevious={() => {
              step(-1);
            }}
            onNext={() => {
              step(1);
            }}
            zoom={zoom}
            zoomLabel={labels.zoom(zoom)}
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            onZoomReset={handleZoomReset}
            findOpen={findOpen}
            find={find}
            matches={matches}
            capped={capped}
            match={match}
            onFindOpen={openFind}
            onFind={changeFind}
            onFindNext={() => {
              moveMatch(1);
            }}
            onFindPrevious={() => {
              moveMatch(-1);
            }}
            onFindClose={closeFind}
            findField={findField}
            download={artifact?.url ?? null}
            onHelp={() => {
              setHelp(true);
            }}
            outline={
              sections.length > 0
                ? {
                    open: outline,
                    onToggle: () => {
                      setOutline((open) => !open);
                    },
                  }
                : undefined
            }
            settling={
              status.kind === "loading" ||
              (artifact !== null && reported !== artifact)
            }
            onCommentMatch={
              notes.on
                ? () => {
                    notes.commentHere();
                  }
                : undefined
            }
            comments={
              notes.on
                ? {
                    open: panel,
                    count: notes.count,
                    onToggle: () => {
                      setPanel((open) => !open);
                    },
                  }
                : undefined
            }
          />
          <div {...stylex.props(styles.body)}>
            {outline && sections.length > 0 ? (
              <Outline
                sections={sections}
                current={current}
                onJump={jump}
                label={labels.outline}
              />
            ) : null}
            <DocumentView
              status={status}
              shown={shown}
              sourceName={source.name}
              scroller={scroller}
              setScroller={setScroller}
              mode={mode}
              draw={draw}
              building={building}
            />
            {edits.bar}
            {notes.panel}
          </div>
          {notes.floating}
          {edits.card}
          {notes.on || edits.on ? (
            <output
              aria-live="polite"
              data-slot="artifact-viewer-said"
              {...stylex.props(visuallyHidden)}
            >
              {said}
            </output>
          ) : null}
          <Dialog open={help} onOpenChange={setHelp}>
            <DialogContent>
              <DialogTitle>{labels.shortcuts}</DialogTitle>
              <DialogBody>
                <KeyList
                  comments={comments !== undefined}
                  edits={edits.on}
                  describe={labels.shortcut}
                />
              </DialogBody>
            </DialogContent>
          </Dialog>
        </>
      ),
    },
    "div"
  );
};
