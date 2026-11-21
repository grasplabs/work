// ArtifactViewer: shows a file an agent or a person made (Markdown, code, text, an image, a PDF,
// a CSV or TSV table, a web page in a sandbox), to read, search and, later, comment on. Grasp's own: Palermo
// has no viewer. It holds its room at once and loads its own code when the browser is idle or it
// scrolls into view, whichever comes first, so a page with a viewer below the fold pays nothing
// up front. Each format's renderer is a chunk of its own, and the heavy work (parsing, highlighting,
// search) runs in Web Workers once the page calls allowWorkers() (only where its policy allows
// them), else on the page.
//
//   <ArtifactViewer src="/reports/q3.md" />
//   <ArtifactViewer file={upload} />                          a File or Blob the page has
//   <ArtifactViewer text={draft} name="plan.md" />            the text itself
//
// It fills its container: give the box round it a height. Its state (the row, the zoom, the
// search) is in the link, under `id`, so a link reopens that view. Every value is a token.
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */

import * as stylex from "@stylexjs/stylex";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ComponentType } from "react";

import type { LayoutStyle } from "../layout/layout";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords } from "../words/words";
import type { EditPatch } from "./edits";
import { loadExtras } from "./extras";
import type { AgentEdits } from "./extras";
import { detectFormat } from "./format";
import { RENDERER_LOADERS } from "./load-renderer";
import { viewerHash } from "./location";
import type { ViewerLocation } from "./location";
import type {
  ArtifactViewerLabels,
  CommentAuthor,
  CommentHandler,
  CommentThread,
} from "./types";
import type { ViewerProps } from "./viewer";
import { artifactViewerBoxWords } from "./words";
import { warmWorker } from "./worker/client";

/** What a caller may style: its size and where it sits. */
export type ArtifactViewerLayoutStyle = LayoutStyle;

/** Every prop an ArtifactViewer takes. Give one of `src`, `file` or `text`. */
export interface ArtifactViewerProps {
  /** A URL to fetch the file from. */
  src?: string;
  /** A File or a Blob the page already has: an upload, a download it made. */
  file?: Blob;
  /** The file's text itself: a draft the agent wrote. */
  text?: string;
  /** The file's name, shown in the toolbar and used for the download. Without it, the URL's last part. */
  name?: string;
  /** Its MIME type, when known: the format is read from it first, then the name, then the bytes. */
  type?: string;
  /** For code: its language (`"typescript"`), when the name does not say. */
  language?: string;
  /**
   * Names its state in the link (`?view-at=120`), so two viewers on one page keep their own.
   * @default "view"
   */
  id?: string;
  /**
   * Where PDF.js's `cmaps/`, `standard_fonts/`, `wasm/` and `iccs/` folders are served (copy them
   * from `pdfjs-dist`). Needed for PDFs in Chinese, Japanese or Korean, and for PDFs that do not
   * carry their fonts; without it those fonts fall back to the system's.
   */
  pdfAssets?: string;
  /**
   * Let a web page's scripts run. They run in a sandbox with an origin of their own, so they can
   * never reach your page, its cookies or its storage, and they cannot fetch anything. Off, nothing
   * in the page runs at all.
   * @default false
   */
  allowScripts?: boolean;
  /** Where its state lives: the query string (the default), your router's adapter, or `"none"`. */
  location?: ViewerLocation | "none";
  /**
   * The comment threads on the file. Give an array (even an empty one) to turn comments on: a
   * selection can then be commented on, and the panel lists every thread. Without it, comments are
   * off: no button, no keys. The viewer stores nothing; pass the threads back as they change.
   */
  comments?: CommentThread[];
  /**
   * A new comment on a place in the file: add a thread with this anchor. Give back the new thread's
   * id (or a promise of it) and the viewer opens it and puts focus on it; otherwise it finds the new
   * thread by its anchor.
   */
  onComment?: CommentHandler;
  /** A reply in a thread. */
  onReply?: (threadId: string, body: string) => void;
  /** A thread resolved, or opened again. */
  onResolve?: (threadId: string, resolved: boolean) => void;
  /** A comment deleted. Without it, comments cannot be deleted here. */
  onDelete?: (threadId: string, itemId: string) => void;
  /** Who is writing: shown with a new comment. */
  commentAuthor?: CommentAuthor;
  /**
   * For a table: a row's key, from its cells (an order number, an id column), so a cell's comment
   * follows its row when rows are sorted or added. By default, the row's number among the data rows.
   */
  rowKey?: (cells: readonly string[]) => string;
  /**
   * An edit accepted (or undone, or redone): apply the patch to the source and pass the new source
   * back. Without it, the file cannot be edited here: an agent's tools say so.
   */
  onEdit?: (patch: EditPatch) => void;
  /**
   * What an agent's proposed edit does: wait for the person's Accept, or go straight through (still
   * shown, and undoable).
   * @default "propose"
   */
  agentEdits?: AgentEdits;
  /**
   * An app being built for the first time: while it is set, the viewer shows App building in place
   * of the file, with `step` in a line under it; cleared, the file shows. Off by default.
   */
  building?: boolean | { step?: string };
  /**
   * Every word the viewer shows or says to a screen reader, in the product's language: the
   * toolbar, find, comments, an agent's edits, each format's own words and the shortcuts. Words with
   * a number or a name in them are functions (`position: (kind, at, of) => …`). Any left out are
   * English (`englishLabels`).
   */
  labels?: Partial<ArtifactViewerLabels>;
  /** @deprecated Use `layout`. */
  style?: ArtifactViewerLayoutStyle;
  /** Its size and where it sits. It fills the height it is given. */
  layout?: ArtifactViewerLayoutStyle;
}

const styles = stylex.create({
  box: {
    position: "relative",
    display: "grid",
    width: "100%",
    height: "100%",
    minHeight: grasp.viewerMinHeight,
    // A file with no width of its own (an SVG) never leaves it 0 wide in a box that shrinks.
    minWidth: grasp.viewerMinWidth,
    overflow: "hidden",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    boxShadow: grasp.edge,
    // Forced colours drop the edge, a shadow: an outline draws it there.
    outline: {
      default: "none",
      [media.forced]: `${grasp.hairline} solid CanvasText`,
    },
    backgroundColor: grasp.viewerGround,
  },
  // While the viewer's code loads, its bar is already there with the file's name, as the toolbar
  // draws them, so the bar does not pop in later: only its controls arrive.
  bar: {
    alignSelf: "start",
    display: "flex",
    alignItems: "center",
    boxSizing: "border-box",
    minHeight: grasp.viewerToolbarHeight,
    paddingInline: `calc(${grasp.space2} * 2)`,
    backgroundColor: grasp.raised,
    boxShadow: `inset 0 calc(-1 * ${grasp.hairline}) 0 ${grasp.line}`,
    borderBlockEndWidth: { default: 0, [media.forced]: grasp.hairline },
    borderBlockEndStyle: "solid",
    borderBlockEndColor: "CanvasText",
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightMedium,
    color: grasp.ink,
  },
  barName: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

// Loaded once for the page, by whichever viewer asks first.
let shellLoad: Promise<ComponentType<ViewerProps>> | null = null;
// The shell and the comments and editing items' hooks, when those are installed, side by side.
const importShell = async () => {
  const [{ Viewer }] = await Promise.all([import("./viewer"), loadExtras()]);
  return Viewer;
};
const loadShell = async () => {
  shellLoad ??= importShell();
  return await shellLoad;
};

// What the file will need besides the shell, started beside it rather than after it: its renderer's
// chunk and, for a format parsed off the page, the Worker. The format is read from the type and the
// name alone here; the shell reads it again, with the bytes, once the file has opened.
const warmFor = (
  source: Pick<ArtifactViewerProps, "src" | "file" | "name" | "type">
) => {
  const fileName = source.file instanceof File ? source.file.name : undefined;
  const name =
    source.name ?? fileName ?? source.src?.split(/[?#]/u)[0]?.split("/").pop();
  const { format } = detectFormat({ type: source.type, name });
  void RENDERER_LOADERS[format]?.();
  warmWorker(format);
};

export const ArtifactViewer = ({
  id = "view",
  style: styleProp,
  layout,
  ...rest
}: ArtifactViewerProps) => {
  const boxWords = useWords("artifactViewerBox", artifactViewerBoxWords);
  const box = useRef<HTMLDivElement>(null);
  const [shell, setShell] = useState<ComponentType<ViewerProps> | null>(null);
  const Shell = shell;
  const { src, file, name, type } = rest;
  const warm = useEffectEvent(() => {
    warmFor({ src, file, name, type });
  });

  // On idle, or on coming into view, whichever is first.
  useEffect(() => {
    let done = false;
    const show = async () => {
      const component = await loadShell();
      setShell(() => component);
    };
    const load = () => {
      if (done) {
        return;
      }
      done = true;
      warm();
      void show();
    };
    // In view now: at once, never behind an idle moment a busy page may not have, nor behind the
    // viewers further down that asked first.
    const rect = box.current?.getBoundingClientRect();
    if (
      rect &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.width > 0
    ) {
      load();
    }
    const idle =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(load, { timeout: 2000 })
        : window.setTimeout(load, 300);
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        load();
      }
    });
    if (box.current) {
      seen.observe(box.current);
    }
    return () => {
      done = true;
      seen.disconnect();
      if (typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idle);
      } else {
        window.clearTimeout(idle);
      }
    };
  }, []);

  return (
    <section
      ref={box}
      id={viewerHash(id)}
      aria-label={rest.name ?? rest.labels?.file ?? boxWords.file}
      data-slot="artifact-viewer-box"
      {...stylex.props(styles.box, layout ?? styleProp)}
    >
      {Shell ? (
        <Shell id={id} {...rest} />
      ) : (
        <div
          aria-hidden="true"
          data-slot="artifact-viewer-holding-bar"
          {...stylex.props(styles.bar)}
        >
          <span {...stylex.props(styles.barName)}>
            {rest.name ??
              (rest.file instanceof File ? rest.file.name : undefined) ??
              rest.src?.split(/[?#]/u)[0]?.split("/").pop()}
          </span>
        </div>
      )}
    </section>
  );
};
