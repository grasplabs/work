// A PDF: parsed in PDF.js's own Worker, its pages in the virtual viewport (only pages near the
// screen are in the page, and only they have a canvas), each with its words as real text. Pages are
// the places to jump to. Search reads each page's text as it is needed, in idle moments, and
// searches it in the viewer's Worker.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useEffectEvent, useReducer, useRef, useState } from "react";

import { useMatches } from "../artifact-viewer/find";
import { pixels, tokenPixels } from "../artifact-viewer/measure";
import type { PdfFailure, RendererProps } from "../artifact-viewer/types";
import { VirtualRows } from "../artifact-viewer/virtual";
import { Button } from "../button/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "../empty/empty";
import { Download } from "../icons";
import { makeQueue, Page, pageText } from "./page";
import { getDocument, PixelsPerInch, readyPdfJs, TextLayer } from "./pdfjs";
import type { PDFDocumentProxy } from "./pdfjs";

const styles = stylex.create({
  box: { width: "100%" },
  centre: { display: "grid", placeItems: "center", minHeight: "100%" },
});

type Failure = PdfFailure;

// Why PDF.js says a PDF did not open; the words for it are a label.
const failureOf = (error: unknown): Failure => {
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") {
    return "locked";
  }
  if (name === "EmptyPDF") {
    return "empty";
  }
  if (name === "InvalidPDFException") {
    return "invalid";
  }
  return "unread";
};

// The few pages read at once while search reads the rest.
const READ_AT_ONCE = 4;

// The next few pages not read yet, from `from`, and where to look next time.
const unreadFrom = (
  from: number,
  total: number,
  texts: readonly (string | undefined)[]
) => {
  const batch: number[] = [];
  let next = from;
  while (next < total && batch.length < READ_AT_ONCE) {
    if (texts[next] === undefined) {
      batch.push(next);
    }
    next += 1;
  }
  return { batch, next };
};

interface Opening {
  live: boolean;
  task: ReturnType<typeof getDocument> | null;
}

// Opens a PDF: its bytes go to PDF.js (in its Worker where the page allows one). Gives back the document and its first page's size
// (which sizes every page before they load), or says why it did not open.
const openPdf = async (
  blob: Blob,
  assets: string | undefined,
  opening: Opening,
  fail: (failure: Failure) => void
) => {
  const data = await blob.arrayBuffer();
  await readyPdfJs();
  if (!opening.live) {
    return null;
  }
  const base = assets?.replace(/\/?$/u, "/");
  const task = getDocument({
    data,
    // A PDF is untrusted: no XFA forms (PDF.js 6 compiles nothing with eval at all).
    enableXfa: false,
    ...(base === undefined
      ? {}
      : {
          cMapUrl: `${base}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${base}standard_fonts/`,
          wasmUrl: `${base}wasm/`,
          iccUrl: `${base}iccs/`,
        }),
  });
  opening.task = task;
  // Asked for a password: it is not ours to ask, so it stops here.
  task.onPassword = () => {
    if (opening.live) {
      fail(
        failureOf(
          Object.assign(new Error("password"), { name: "PasswordException" })
        )
      );
    }
    void task.destroy();
  };
  // Opened, and its first page read: a PDF with no pages, or whose first page cannot be read, says
  // so like any other broken PDF.
  try {
    const opened = await task.promise;
    if (opened.numPages < 1) {
      throw Object.assign(new Error("no pages"), { name: "EmptyPDF" });
    }
    const one = await opened.getPage(1);
    const viewport = one.getViewport({ scale: 1 });
    return {
      doc: opened,
      first: { width: viewport.width, height: viewport.height },
    };
  } catch (error: unknown) {
    if (opening.live) {
      fail(failureOf(error));
    }
    return null;
  }
};

// Reads a page's text, unless the reader is gone first. A page that cannot be read is left out.
const readPage = async (
  doc: PDFDocumentProxy,
  index: number,
  reading: { live: boolean },
  onText: (index: number, text: string) => void
) => {
  try {
    const page = await doc.getPage(index + 1);
    const content = await page.getTextContent();
    if (reading.live) {
      onText(index, pageText(content));
    }
  } catch {
    // Left out: search reads the rest.
  }
};

// Runs a job in an idle moment, or soon where the browser has none to offer.
const idle = (run: () => void) =>
  typeof window.requestIdleCallback === "function"
    ? window.requestIdleCallback(run, { timeout: 500 })
    : window.setTimeout(run, 16);

// Reads the pages not read yet, a few at a time, in idle moments, until none are left.
const readRest = (
  doc: PDFDocumentProxy,
  texts: { current: readonly (string | undefined)[] },
  reading: { live: boolean; handle: number },
  onText: (index: number, text: string) => void
) => {
  const cursor = { next: 0 };
  const step = async () => {
    const { batch, next } = unreadFrom(
      cursor.next,
      doc.numPages,
      texts.current
    );
    cursor.next = next;
    if (batch.length === 0) {
      return;
    }
    await Promise.all(
      batch.map(async (index) => {
        await readPage(doc, index, reading, onText);
      })
    );
    if (reading.live) {
      reading.handle = idle(() => {
        void step();
      });
    }
  };
  reading.handle = idle(() => {
    void step();
  });
};

// What is held for a file: only for the file and assets it came from, never for another.
const heldFor = <T extends { blob: Blob; assets: string | undefined }>(
  held: T | null,
  blob: Blob,
  assets: string | undefined
) =>
  held !== null && held.blob === blob && held.assets === assets ? held : null;

// Fit: the first page fills the width. A number: that share of the page's real size.
const scaleOf = (
  zoom: number | "fit",
  first: { width: number } | null,
  room: number
) => {
  if (zoom !== "fit") {
    return (zoom / 100) * PixelsPerInch.PDF_TO_CSS_UNITS;
  }
  return first === null
    ? PixelsPerInch.PDF_TO_CSS_UNITS
    : Math.max(0.1, room / first.width);
};

const NONE: readonly number[] = [];

// What a viewer makes once and keeps: its queue, and the pages it has drawn.
const keepQueue = (queue: ReturnType<typeof makeQueue>) => queue;
const keepDrawn = (drawn: Set<number>) => drawn;

// Every page's matches, by page.
const matchesByPage = (matches: readonly { row: number; at: number }[]) => {
  const map = new Map<number, number[]>();
  for (const found of matches) {
    const list = map.get(found.row) ?? [];
    list.push(found.at);
    map.set(found.row, list);
  }
  return map;
};
const NO_TEXTS: readonly (string | undefined)[] = [];

const PdfRenderer = ({
  artifact,
  labels,
  scroller,
  zoom,
  find,
  match,
  initialRow,
  onSections,
  onRows,
  onRow,
  onMatches,
  onTexts,
  onRowOf,
  wantedParts,
  control,
  pdfAssets,
}: RendererProps) => {
  // The document and its first page's size, or why it did not open: each for the file and assets
  // it came from, so neither is ever read for another.
  const [opened, setOpened] = useState<{
    blob: Blob;
    assets: string | undefined;
    doc: PDFDocumentProxy;
    first: { width: number; height: number };
  } | null>(null);
  const [failed, setFailed] = useState<{
    blob: Blob;
    assets: string | undefined;
    failure: Failure;
  } | null>(null);
  const { blob } = artifact;
  const current = heldFor(opened, blob, pdfAssets);
  const doc = current?.doc ?? null;
  const first = current?.first ?? null;
  const failure = heldFor(failed, blob, pdfAssets)?.failure ?? null;
  const [room, setRoom] = useState(0);
  const [gap, setGap] = useState(0);
  // One queue for this viewer's life: nothing ever replaces it.
  const [queue] = useReducer(keepQueue, null, () => makeQueue());
  // Pages drawn once in this viewer: drawn again, they appear without fading.
  const [drawnBefore] = useReducer(keepDrawn, null, () => new Set<number>());

  // Open it: its bytes go to PDF.js's Worker. A locked or broken PDF says so, never a blank box.
  useEffect(() => {
    const opening: Opening = { live: true, task: null };
    const open = async () => {
      const done = await openPdf(blob, pdfAssets, opening, (reason) => {
        setFailed({ blob, assets: pdfAssets, failure: reason });
      });
      if (done !== null && opening.live) {
        setOpened({ blob, assets: pdfAssets, ...done });
      }
    };
    void open();
    return () => {
      opening.live = false;
      // Destroying the task destroys its document, and PDF.js's Worker lets go of the file.
      void opening.task?.destroy();
      // PDF.js keeps a canvas in the page for measuring words: let it go once no layer needs it.
      TextLayer.cleanup();
    };
  }, [blob, pdfAssets]);

  // The width there is for a page, and the gap between pages, as the viewport resizes. The pages'
  // own box is watched too: when the pages first overflow, a scrollbar that takes room narrows it,
  // and WebKit does not tell the scroller's watcher. Pages sized for the wider room were shorter
  // than measured, and a link to page 320 opened on page 327.
  const [pagesBox, setPagesBox] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const read = () => {
      const style = getComputedStyle(scroller);
      setRoom(
        scroller.clientWidth -
          pixels(style.paddingLeft) -
          pixels(style.paddingRight)
      );
      setGap(tokenPixels("viewer-gap", scroller));
    };
    read();
    const watcher = new ResizeObserver(read);
    watcher.observe(scroller);
    if (pagesBox !== null) {
      watcher.observe(pagesBox);
    }
    return () => {
      watcher.disconnect();
    };
  }, [scroller, pagesBox]);

  const scale = scaleOf(zoom, first, room);
  const pages = doc?.numPages ?? 0;

  useEffect(() => {
    onRows(pages);
    onSections(
      Array.from({ length: pages }, (_, row) => ({
        label: labels.page(row + 1),
        row,
      }))
    );
  }, [pages, onRows, onSections, labels]);

  // Each page's text, as it is read: by a page drawn on screen, or by search reading the rest.
  const texts = useRef<(string | undefined)[]>([]);
  // The document the texts are of: a copy made for another is never read.
  const textsOf = useRef<PDFDocumentProxy | null>(null);
  // What render reads: a copy of the texts, made again at most a few times a second as pages arrive.
  const [readTexts, setReadTexts] = useState<{
    doc: PDFDocumentProxy | null;
    texts: readonly (string | undefined)[];
  }>({ doc: null, texts: NO_TEXTS });
  const pageTexts = readTexts.doc === doc ? readTexts.texts : NO_TEXTS;
  const pending = useRef(0);
  const onText = (index: number, text: string) => {
    if (texts.current[index] !== undefined) {
      return;
    }
    texts.current[index] = text;
    // The search runs again at most a few times a second while pages are read.
    if (pending.current === 0) {
      pending.current = window.setTimeout(() => {
        pending.current = 0;
        setReadTexts({ doc: textsOf.current, texts: [...texts.current] });
      }, 250);
    }
  };
  // The same, for what reads pages after an effect began: always as it is now.
  const hearText = useEffectEvent(onText);
  useEffect(() => {
    texts.current = [];
    textsOf.current = doc;
  }, [doc]);
  useEffect(
    () => () => {
      window.clearTimeout(pending.current);
    },
    []
  );

  // With a search, the pages not read yet are read in idle moments, a few at a time.
  const searching = Boolean(find.trim());
  useEffect(() => {
    const reading = { live: true, handle: 0 };
    if (doc !== null && searching) {
      readRest(doc, texts, reading, (index, text) => {
        hearText(index, text);
      });
    }
    return () => {
      reading.live = false;
      if (typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(reading.handle);
      }
      window.clearTimeout(reading.handle);
    };
  }, [doc, searching]);

  // The pages' text, as far as it is read, for comments; and the pages comments are on, read first.
  useEffect(() => {
    onTexts?.(Array.from({ length: pages }, (_, index) => pageTexts[index]));
  }, [pages, pageTexts, onTexts]);
  useEffect(() => onRowOf?.((part) => part), [onRowOf]);
  useEffect(() => {
    const reading = { live: true };
    for (const index of doc === null ? NONE : (wantedParts ?? NONE)) {
      if (
        doc !== null &&
        index < doc.numPages &&
        texts.current[index] === undefined
      ) {
        void readPage(doc, index, reading, (at, text) => {
          hearText(at, text);
        });
      }
    }
    return () => {
      reading.live = false;
    };
  }, [doc, wantedParts]);

  const rowTexts = pages
    ? Array.from({ length: pages }, (_, index) => pageTexts[index] ?? "")
    : null;
  const complete =
    pages > 0 &&
    rowTexts !== null &&
    pageTexts.filter((text) => text !== undefined).length === pages;
  const matches = useMatches(rowTexts, find, (count, more) => {
    onMatches(count, more === true || !complete);
  });

  // A new current match. The page owns the scroll to its mark: when the page is in the list
  // already, it brings the mark into view itself; only a page not there yet is scrolled to first,
  // and brings its mark into view once its words are laid out.
  const jumped = useRef("");
  useEffect(() => {
    const active = matches[match];
    if (!active) {
      return;
    }
    const key = `${active.row}:${active.at}`;
    if (key === jumped.current) {
      return;
    }
    jumped.current = key;
    if (!scroller.querySelector(`[data-row="${active.row}"]`)) {
      control.current?.scrollToRow(active.row);
    }
  }, [matches, match, control, scroller]);

  // Every page's matches, by page.
  const byPage = matchesByPage(matches);
  const active = matches[match];
  const { length } = find.trim();

  if (failure !== null) {
    const words = labels.pdfFailure(failure);
    return (
      <div {...stylex.props(styles.centre)}>
        <Empty tone="danger">
          <EmptyHeader>
            <EmptyMedia />
            <EmptyTitle>{words.title}</EmptyTitle>
            <EmptyDescription>
              {words.message}{" "}
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
  }
  if (!doc || !first || !room) {
    return null;
  }

  const estimate = first.height * scale + gap;
  return (
    <div ref={setPagesBox} {...stylex.props(styles.box)}>
      <VirtualRows
        scroller={scroller}
        count={pages}
        estimate={(index) =>
          index === pages - 1 ? first.height * scale : estimate
        }
        version={scale}
        initialRow={initialRow}
        onRow={onRow}
        control={control}
        overscan={2}
        renderRow={(index) => (
          <Page
            doc={doc}
            index={index}
            label={labels.page(index + 1)}
            scale={scale}
            fallback={first}
            last={index === pages - 1}
            queue={queue}
            drawnBefore={drawnBefore}
            found={byPage.get(index) ?? NONE}
            current={active?.row === index ? active.at : undefined}
            length={length}
            onText={onText}
          />
        )}
      />
    </div>
  );
};

export default PdfRenderer;
