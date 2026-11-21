// A web page (HTML), shown in a sandboxed frame: its own origin is opaque (never the page's), so it
// cannot reach the viewer's page, its cookies or its storage. Scripts run only when the caller
// allows them, and even then only inside the frame. Links open in a new tab, which stays sandboxed.
//
// Its height: a frame without the page's origin cannot be measured from outside. With scripts
// allowed, a small script put first in the frame posts the page's height, and the frame grows to it
// so the viewer scrolls the page. Without scripts nothing can say it, so the frame fills the viewer
// and scrolls inside itself.
//
// Find counts the page's words, read from its source in the Worker; the frame cannot be marked from
// outside, so the matches are marked in Code view.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "../../../empty/empty";
import { focus } from "../../../focus/focus";
import { FrameGuard } from "../../../frame-guard";
import { arrive } from "../../../motion/arrive";
import { grasp, media } from "../../../tokens/tokens.stylex";
import { useMatches } from "../../find";
import { pixels } from "../../measure";
import type { RendererProps } from "../../types";
import { runTask } from "../../worker/client";
import { framed, HEIGHT } from "./frame";
import type { Ground } from "./frame";

const styles = stylex.create({
  page: {
    position: "relative",
    width: "100%",
    overflow: "hidden",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.raised,
    // Read back as the ground and words a page with no colours of its own is given.
    color: grasp.text,
    boxShadow: grasp.liftLow,
    outline: {
      default: "none",
      [media.forced]: `${grasp.hairline} solid CanvasText`,
    },
  },
  height: (height: number) => ({ height }),
  // Asks for a comfortable page's width where there is room, so a box that shrinks to its content
  // does not shrink the page to nothing: the frame itself has no width of its own to give.
  room: { width: grasp.viewerPageWidth, maxWidth: "100%", height: 0 },
  frame: (scale: number, height: number) => ({
    position: "absolute",
    insetBlockStart: 0,
    insetInlineStart: 0,
    display: "block",
    width: `calc(100% / ${scale})`,
    height,
    borderWidth: 0,
    transformOrigin: "0 0",
    transform: scale === 1 ? null : `scale(${scale})`,
  }),
  // Unseen until it has loaded; then it fades in where the blank page stood.
  waiting: { opacity: 0 },
});

/** The tallest a page may say it is, in its own pixels; past it, the frame scrolls inside. */
const TALLEST = 50_000;
/** How often a page may send itself elsewhere before it is no longer put back. */
const RETURNS = 3;

// The viewer's ground and words as it draws them now (Night, dark mode or a forced theme alike),
// and whether that ground is dark: what a page with no colours of its own is given.
const readGround = (box: HTMLElement): Ground => {
  const style = getComputedStyle(box);
  const context = document.createElement("canvas").getContext("2d");
  let scheme: Ground["scheme"] = "light";
  if (context) {
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    const [red = 255, green = 255, blue = 255] = context.getImageData(
      0,
      0,
      1,
      1
    ).data;
    if (0.2126 * red + 0.7152 * green + 0.0722 * blue < 128) {
      scheme = "dark";
    }
  }
  return { background: style.backgroundColor, color: style.color, scheme };
};

// Reads the viewer's ground now, and again whenever the theme may have changed: the computer's
// scheme, or an attribute or class on the way down to the viewer.
const watchGround = (
  element: HTMLElement,
  setGround: Dispatch<SetStateAction<Ground | null>>
) => {
  let frameId = 0;
  const read = () => {
    frameId = 0;
    const next = readGround(element);
    setGround((was) =>
      was !== null &&
      was.background === next.background &&
      was.color === next.color
        ? was
        : next
    );
  };
  const later = () => {
    if (frameId === 0) {
      frameId = requestAnimationFrame(read);
    }
  };
  read();
  const dark = matchMedia("(prefers-color-scheme: dark)");
  dark.addEventListener("change", later);
  const watcher = new MutationObserver(later);
  watcher.observe(document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: ["class", "style", "data-theme", "data-ground"],
  });
  return () => {
    dark.removeEventListener("change", later);
    watcher.disconnect();
    cancelAnimationFrame(frameId);
  };
};

// Says when focus goes into the frame and when it comes out, until told to stop. For the frame
// that is as tall as its page only: it has no guard, and a guard that is not drawn says nothing.
const watchFrameFocus = (
  frame: RefObject<HTMLIFrameElement | null>,
  say: (inside: boolean) => void
) => {
  const read = () => {
    say(frame.current !== null && document.activeElement === frame.current);
  };
  // Read now and once more a moment later: Firefox names the frame as the active element only
  // after the window's blur has been heard.
  let timer = 0;
  const heard = () => {
    read();
    window.clearTimeout(timer);
    timer = window.setTimeout(read, 0);
  };
  window.addEventListener("blur", heard);
  window.addEventListener("focus", heard);
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener("blur", heard);
    window.removeEventListener("focus", heard);
  };
};

/** One frame's life: a page, put back this many times. */
interface FrameLife {
  page: string | null;
  returns: number;
}
// Whether what was kept for a frame was kept for this one.
const sameFrame = (kept: FrameLife | null | undefined, now: FrameLife) =>
  kept !== null &&
  kept !== undefined &&
  kept.page === now.page &&
  kept.returns === now.returns;

// The height a page's measuring script posts, if the message is one.
const heightIn = (data: unknown) =>
  typeof data === "object" && data !== null && HEIGHT in data
    ? data[HEIGHT]
    : undefined;

// With scripts, the page's height, as its measuring script posts it. The frame grows at once, and
// shrinks only once the page has said nothing else for a second, so a page whose height flickers
// settles on its tallest and does not shake the viewer. A page that grows with the frame (one sized
// by the window's height) would grow without end: after a dozen rises in a second and a half, or
// past TALLEST, the frame stops following and scrolls inside instead.
const hearHeight = (
  frame: RefObject<HTMLIFrameElement | null>,
  frameOf: FrameLife,
  setSaid: Dispatch<SetStateAction<{ frame: FrameLife; height: number } | null>>
) => {
  const rises: number[] = [];
  let shown = 0;
  let shrink = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    window.clearTimeout(shrink);
    setSaid(null);
  };
  const heard = (event: MessageEvent<unknown>) => {
    if (stopped || event.source !== frame.current?.contentWindow) {
      return;
    }
    const told = heightIn(event.data);
    if (typeof told !== "number" || !Number.isFinite(told) || told <= 0) {
      return;
    }
    const height = Math.ceil(told);
    if (height > TALLEST) {
      stop();
      return;
    }
    const now = performance.now();
    window.clearTimeout(shrink);
    if (height > shown) {
      rises.push(now);
      while (rises.length > 0 && now - (rises[0] ?? now) > 1500) {
        rises.shift();
      }
      if (rises.length > 12) {
        stop();
        return;
      }
      shown = height;
      setSaid({ frame: frameOf, height });
    } else if (height < shown) {
      shrink = window.setTimeout(() => {
        shown = height;
        setSaid({ frame: frameOf, height });
      }, 1000);
    }
  };
  window.addEventListener("message", heard);
  return () => {
    window.removeEventListener("message", heard);
    window.clearTimeout(shrink);
  };
};

const HtmlRenderer = ({
  artifact,
  labels,
  scroller,
  zoom,
  find,
  onSections,
  onRows,
  onRow,
  onMatches,
  onFindNote,
  control,
  allowScripts = false,
}: RendererProps) => {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [room, setRoom] = useState(0);
  // The page's height as it says it, and the page that last loaded: each for the frame it came
  // from, so neither is ever read for another. WebKit can load a small page before an effect runs.
  const [said, setSaid] = useState<{ frame: FrameLife; height: number } | null>(
    null
  );
  const [loadedFrame, setLoadedFrame] = useState<FrameLife | null>(null);
  const [ground, setGround] = useState<Ground | null>(null);
  const scale = (zoom === "fit" ? 100 : zoom) / 100;
  const source = artifact.text ?? "";
  // Each time the page sent itself elsewhere and was put back; past RETURNS it is not shown. Counted
  // for this source and these scripts: either new, it starts again from none.
  const [returned, setReturned] = useState({ source, allowScripts, count: 0 });
  const returns =
    returned.source === source && returned.allowScripts === allowScripts
      ? returned.count
      : 0;

  // The viewer's ground, read now and again whenever the theme may have changed: the computer's
  // scheme, or an attribute or class on the way down to the viewer. A change makes the page anew.
  useEffect(
    () =>
      box.current === null ? undefined : watchGround(box.current, setGround),
    []
  );

  const page =
    ground === null ? null : framed(source, { scripts: allowScripts, ground });
  // One frame's life: this page, put back this many times.
  const frameOf: FrameLife = { page, returns };
  const loaded = sameFrame(loadedFrame, frameOf);
  const content =
    said !== null && sameFrame(said.frame, frameOf) ? said.height : null;

  useEffect(() => {
    onRows(1);
    onSections([]);
    onRow(0);
  }, [onRows, onSections, onRow]);
  useImperativeHandle(
    control,
    () => ({
      scrollToRow: () => {
        scroller.scrollTo({ top: 0 });
      },
    }),
    [scroller]
  );

  // The viewer's height less its padding: what a frame that scrolls inside fills.
  useEffect(() => {
    const read = () => {
      const style = getComputedStyle(scroller);
      setRoom(
        scroller.clientHeight -
          pixels(style.paddingTop) -
          pixels(style.paddingBottom)
      );
    };
    read();
    const watcher = new ResizeObserver(read);
    watcher.observe(scroller);
    return () => {
      watcher.disconnect();
    };
  }, [scroller]);

  // With scripts, the page's height, as its measuring script posts it.
  useEffect(
    () =>
      allowScripts ? hearHeight(frame, { page, returns }, setSaid) : undefined,
    [allowScripts, page, returns]
  );

  // Whether the frame is in use: the shared guard (src/components/frame-guard) hears focus go into
  // the frame and come out, and says so; the box then shows the frame's ring. The guard takes the
  // frame as an element, so it is kept as state beside the ref the rest of this file reads.
  const [inFrame, setInFrame] = useState(false);
  const [guarded, setGuarded] = useState<HTMLIFrameElement | null>(null);
  const keepFrame = (element: HTMLIFrameElement | null) => {
    frame.current = element;
    setGuarded(element);
  };

  // Sized to the page when it says its height; otherwise as tall as the viewer, scrolling inside.
  // Without a guard the frame's focus is heard here; with one, the guard says it.
  const fills = content === null;
  useEffect(
    () => (fills ? undefined : watchFrameFocus(frame, setInFrame)),
    [fills]
  );

  // Find: the page's words, from its source, counted in the Worker.
  const [text, setText] = useState<string[] | null>(null);
  useEffect(() => {
    let live = true;
    const read = async () => {
      const words = await runTask({ kind: "htmlText", source });
      if (live) {
        setText([words]);
      }
    };
    void read();
    return () => {
      live = false;
    };
  }, [source]);
  useMatches(text, find, onMatches);
  useEffect(() => {
    onFindNote?.(find.trim() ? labels.findInPreview : "");
    return () => {
      onFindNote?.("");
    };
  }, [find, onFindNote, labels]);

  if (returns > RETURNS) {
    return (
      <Empty tone="danger">
        <EmptyHeader>
          <EmptyMedia />
          <EmptyTitle>{labels.pageLeft}</EmptyTitle>
          <EmptyDescription>{labels.pageLeftBody(RETURNS)}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const outer = fills ? room : content * scale;
  const inner = fills ? room / scale : content;
  return (
    <div
      ref={box}
      {...stylex.props(
        styles.page,
        styles.height(Math.max(0, outer)),
        inFrame && focus.frame
      )}
    >
      <div aria-hidden="true" {...stylex.props(styles.room)} />
      {room > 0 && page !== null && (
        <iframe
          key={returns}
          ref={keepFrame}
          title={artifact.name}
          srcDoc={page}
          // Never allow-same-origin: the page's origin stays opaque, whatever it runs.
          sandbox={allowScripts ? "allow-scripts allow-popups" : "allow-popups"}
          referrerPolicy="no-referrer"
          onLoad={() => {
            // The first load is the page. Another means it sent its frame elsewhere (with scripts,
            // `location.href = …`): the frame is made anew from the source, so what shows is
            // always this file, under its policy.
            if (loaded) {
              setReturned((was) => ({
                source,
                allowScripts,
                count:
                  (was.source === source && was.allowScripts === allowScripts
                    ? was.count
                    : 0) + 1,
              }));
            } else {
              setLoadedFrame(frameOf);
            }
          }}
          {...stylex.props(
            styles.frame(scale, inner),
            loaded ? arrive.in : styles.waiting
          )}
        />
      )}
      {/* A page that scrolls inside its frame would keep the wheel: it waits for a press, and the
          page round it scrolls until then. A frame as tall as its page has nothing to scroll. */}
      {room > 0 && page !== null && (
        <FrameGuard
          frame={guarded}
          label={labels.usePage}
          hint={labels.usePageHint}
          done={labels.usePageDone}
          guard={fills ? "always" : "never"}
          onLiveChange={setInFrame}
        />
      )}
    </div>
  );
};

export default HtmlRenderer;
