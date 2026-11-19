// App card's parts: the window with the app in it (a screenshot of it, the app running scaled to
// fit, a picture, App building, or a quiet line), and the "…" menu.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { AppBuilding } from "../app-building";
import { DropdownMenuMore } from "../dropdown-menu";
import type { DropdownMenuAction } from "../dropdown-menu";
import { Skeleton } from "../skeleton";
import { styles } from "./styles";
import { useInView, useReducedMotion } from "./watch";

/**
 * A screenshot of the app: the card's default preview, sharp at any scale. Take it at 2x of the
 * width the app lays out at in the window, a desktop's (`bun run shoot:app-card` takes the
 * examples' at 1200px): it fills the window's width from the top, and the frame's foot crops it.
 * A card under 25.5rem wide (a phone) shows `srcNarrow` in its place, taken at a phone's width
 * (300px), drawn the same way.
 */
export interface AppCardImage {
  /** A screenshot, the default kind. */
  kind?: "image";
  /** The screenshot's address. */
  src: string;
  /** What the screenshot shows, in the caller's words ("The Helpdesk's overview"). */
  alt: string;
  /** The screenshot in the dark theme. Shown where the card stands in dark (its color-scheme); without it, `src` there too. */
  srcDark?: string;
  /**
   * The app at a phone's width (take it at 2x of 300px). Shown where the card is under 25.5rem wide,
   * chosen in CSS; only the shots of the width shown are loaded. Without it, `src` there too.
   */
  srcNarrow?: string;
  /** The narrow screenshot in the dark theme; without it, `srcNarrow` there too. */
  srcNarrowDark?: string;
  /**
   * Smaller copies of `src` with their widths, as an image's srcset ("/budget-1200.webp 1200w,
   * /budget.webp 2400w"): only the copy the drawn size needs is loaded.
   */
  srcSet?: string;
  /** The same for `srcDark`. */
  srcSetDark?: string;
  /**
   * How wide the screenshot is drawn, as an image's sizes, for choosing from `srcSet`. Left out,
   * the card measures its own window once it has woken, and before that assumes its column.
   * @default the width it is drawn at
   */
  sizes?: string;
}

/** The app itself, running: its address and its frame's name. */
export interface AppCardLive {
  /** The running app. */
  kind: "live";
  /** The address of the running app. */
  src: string;
  /** The frame's name. The frame is hidden from screen readers, so this is for the page's tools. */
  title?: string;
  /**
   * The frame's sandbox. A sandboxed frame runs in a process of its own, and Chrome shrinks such a
   * frame from its own pixels, so its words read a little soft; `allow-same-origin` beside
   * `allow-scripts` keeps it in the page's process and sharp, but lets the app reach out of its
   * frame: only for an app on its own site that you trust. For a sharp card of any app, give a
   * screenshot (`{ src, alt }`).
   * @default "allow-scripts"
   */
  sandbox?: string;
  /**
   * A screenshot of the app, the still it shows while the app is not running: before it has loaded,
   * once its card has left the view (the app stops then), and with reduced motion until the card is
   * hovered or focused. A running app can't be photographed from the page, so without a poster the
   * window holds its Skeleton there.
   */
  poster?: AppCardImage;
  /**
   * When the app counts as loaded and its still fades: `load`, at its frame's load event; or
   * `message`, once the app's own document posts `{ type: "app-card", state: "ready" }` to its parent
   * (`window.parent.postMessage({ type: "app-card", state: "ready" }, "*")`); `state: "failed"` turns
   * the window to its quiet line at once. Heard only from the card's own frame. Use `message` for an
   * app that draws after its document loads (a single-page app): the window never shows it blank.
   * @default "load"
   */
  ready?: "load" | "message";
}

/** What an app in a card's window posts to its parent (AppCardLive's `ready: "message"`). */
export interface AppCardSignal {
  type: "app-card";
  state: "ready" | "failed";
}

const isSignal = (data: unknown): data is AppCardSignal =>
  typeof data === "object" &&
  data !== null &&
  "type" in data &&
  data.type === "app-card" &&
  "state" in data &&
  (data.state === "ready" || data.state === "failed");

/** What the window shows: a screenshot of the app (the default kind), or the app running. */
export type AppCardPreview = AppCardImage | AppCardLive;

/** One action in the card's "…" menu: the library's one shape for an action that folds into a menu. */
export type AppCardAction = DropdownMenuAction;

/** The cleanup of an effect that started nothing. */
const keep = () => {
  // Nothing was started, so nothing stops.
};

/** How the app stands in its window: its scale, the width it lays out at, and a shift under a pixel. */
interface Fit {
  scale: number;
  width: number;
  shiftX: number;
  shiftY: number;
}

const DESKTOP = 1280;
const NARROWEST = 1024;
const WIDEST = 1600;

/**
 * The scale that keeps the app sharp. A running app is a frame of its own, painted at its own size
 * and shrunk by the compositor: at a scale like 0.47 every letter is resampled and goes soft. At a
 * scale of one device pixel in k (0.5 or 0.25 on a 2x screen) each shown pixel is k by k whole
 * painted pixels, which reads as crisp as the app drawn small. So the scale is snapped to the
 * nearest such step, and the app's width follows from it.
 */
const fitOf = (room: HTMLElement): Fit | undefined => {
  const box = room.getBoundingClientRect();
  if (box.width <= 0) {
    return undefined;
  }
  const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  const wanted = DESKTOP;
  const steps = [1, 2, 3, 4, 5, 6]
    .map((k) => 1 / (k * ratio))
    .filter((step) => step <= 1);
  const near = (step: number) => Math.abs(Math.log(box.width / step / wanted));
  const sharp = steps
    .filter(
      (step) => box.width / step >= NARROWEST && box.width / step <= WIDEST
    )
    .toSorted((a, b) => near(a) - near(b));
  const scale = sharp[0] ?? box.width / wanted;
  // The window may start part of the way into a device pixel (its inset is a share of the frame):
  // the app moves back by that part, so its pixels land on the screen's.
  const snap = (at: number) => (Math.round(at * ratio) - at * ratio) / ratio;
  return {
    scale,
    width: box.width / scale,
    shiftX: snap(box.left),
    shiftY: snap(box.top),
  };
};

/** How the app fits its window, sharp: undefined until the window is measured. */
const useFit = (room: HTMLDivElement | null) => {
  const [fit, setFit] = useState<Fit>();
  useEffect(() => {
    if (room === null || typeof ResizeObserver === "undefined") {
      return keep;
    }
    const measure = () => {
      setFit(fitOf(room));
    };
    const watch = new ResizeObserver(measure);
    watch.observe(room);
    measure();
    return () => {
      watch.disconnect();
    };
  }, [room]);
  return fit;
};

interface WindowProps {
  /** A screenshot, the running app, a picture, or nothing. */
  preview: AppCardPreview | ReactNode;
  /** The app's title, the frame's name when the source gives none. */
  title: string;
  /** The app's mark, over the quiet line of a window that has nothing to show. */
  mark: ReactNode;
  /** The card is hovered or holds the focus. */
  attention: boolean;
  building: boolean;
  failed: boolean;
  buildingLabel: string;
  failedLabel: string;
  emptyLabel: string;
}

const hasSrc = (
  preview: AppCardPreview | ReactNode
): preview is AppCardPreview =>
  typeof preview === "object" &&
  preview !== null &&
  "src" in preview &&
  typeof preview.src === "string";

const isLive = (preview: AppCardPreview | ReactNode): preview is AppCardLive =>
  hasSrc(preview) && preview.kind === "live";

const isNode = (preview: AppCardPreview | ReactNode): preview is ReactNode =>
  !hasSrc(preview);

const isImage = (
  preview: AppCardPreview | ReactNode
): preview is AppCardImage => hasSrc(preview) && preview.kind !== "live";

const given = (src: string | undefined): src is string =>
  src !== undefined && src !== "";

/** The scheme a box is drawn in: its own color-scheme, or the system's where it follows both. */
const schemeOf = (box: Element): "light" | "dark" => {
  const words = getComputedStyle(box).colorScheme.split(" ");
  const dark = words.includes("dark");
  const light = words.includes("light");
  if (dark !== light) {
    return dark ? "dark" : "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
};

/**
 * Which scheme the card stands in and how wide its shot is drawn, once it has woken: the scheme
 * read from its own color-scheme, again when the system's changes or any box round it changes its
 * attributes (a theme switch, a stage's Night ground); the width again when it resizes. Undefined
 * before then, when the system's scheme and the column sizes choose (see Shot).
 */
const useShotRoom = (box: HTMLElement | null) => {
  const [scheme, setScheme] = useState<"light" | "dark" | undefined>();
  const [drawn, setDrawn] = useState<number | undefined>();
  useEffect(() => {
    const read = () => {
      setScheme(box === null ? undefined : schemeOf(box));
    };
    const measure = () => {
      const width =
        box === null ? 0 : Math.ceil(box.getBoundingClientRect().width);
      setDrawn(width > 0 ? width : undefined);
    };
    read();
    measure();
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    system.addEventListener("change", read);
    const watch = new MutationObserver(read);
    for (
      let at: Element | null = box?.parentElement ?? null;
      at !== null;
      at = at.parentElement
    ) {
      watch.observe(at, { attributes: true });
    }
    const resize = new ResizeObserver(measure);
    if (box !== null) {
      resize.observe(box);
    }
    return () => {
      system.removeEventListener("change", read);
      watch.disconnect();
      resize.disconnect();
    };
  }, [box]);
  return [scheme, drawn] as const;
};

interface PictureProps {
  light: { src: string; srcSet: string | undefined };
  dark: { src: string; srcSet: string | undefined } | undefined;
  alt: string;
  sizes: string;
  /** The scheme the card stands in, once known; before, the system's chooses. */
  scheme: "light" | "dark" | undefined;
  /** Which width it is for, where the shot has a narrow twin; otherwise every width. */
  width: "wide" | "narrow" | undefined;
  /** The shot has loaded (again on hydrating, for one loaded before). */
  onLoaded: () => void;
  /** The shot could not load. */
  onFailed: () => void;
}

// The dark source's condition: the system's scheme until the card knows its own, then always or
// never. A picture loads only the source it chooses, and chooses again when this changes.
const darkWhen = (scheme: PictureProps["scheme"]) => {
  if (scheme === undefined) {
    return "(prefers-color-scheme: dark)";
  }
  return scheme === "dark" ? "all" : "not all";
};

/** The library's Skeleton, the window's whole box, while what it shows loads: nothing jumps when it comes. */
const Waiting = () => <Skeleton variant="block" layout={styles.waiting} />;

/** One screenshot: only the shot of the scheme the card stands in is loaded, at the size it is drawn. */
const Picture = ({
  light,
  dark,
  alt,
  sizes,
  scheme,
  width,
  onLoaded,
  onFailed,
}: PictureProps) => (
  <picture>
    {dark === undefined ? null : (
      <source
        media={darkWhen(scheme)}
        srcSet={dark.srcSet ?? dark.src}
        sizes={sizes}
      />
    )}
    <img
      src={light.src}
      srcSet={light.srcSet}
      sizes={sizes}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      // An image loaded before the page woke fired its load unseen: read it from the image itself.
      ref={(image) => {
        if (image !== null && image.complete && image.naturalWidth > 0) {
          onLoaded();
        }
      }}
      onLoad={onLoaded}
      onError={onFailed}
      data-slot="app-card-image"
      data-width={width}
      {...stylex.props(
        styles.image,
        width === "wide" && styles.onWide,
        width === "narrow" && styles.onNarrow
      )}
    />
  </picture>
);

// Before the card has measured itself (a card on screen at load starts its image then): the whole
// window on a phone, else a card in a column beside a sidebar or in a grid, about 40% of it, less
// from 96rem. Not "auto": browsers give an auto-sized image a 300 by 150 box until it loads.
const SIZES = "(width < 40rem) 100vw, (width < 96rem) 40vw, 30vw";

/**
 * The screenshot: as wide as the window, from its top, cropped by the frame's foot. Only one
 * scheme's shot is loaded: a picture whose dark source follows the system's scheme on the first
 * paint (and without script), then the card's own scheme once it wakes, so a theme set on the page
 * is followed and the other shot loads only when the theme changes. With a narrow one, a container
 * query on the frame hides the shots of the other width: a hidden lazy image is never loaded.
 */
const Shot = ({
  image,
  onFailed,
}: {
  image: AppCardImage;
  onFailed: () => void;
}) => {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const loadedNow = () => {
    setLoaded(true);
  };
  const [scheme, drawn] = useShotRoom(box);
  const narrow = given(image.srcNarrow);
  const widths: PictureProps["width"][] = narrow
    ? ["wide", "narrow"]
    : [undefined];
  const measured = drawn === undefined ? SIZES : `${drawn}px`;
  const sizes = given(image.sizes) ? image.sizes : measured;
  const sourcesOf = (width: PictureProps["width"]) => {
    if (width === "narrow") {
      const src = given(image.srcNarrow) ? image.srcNarrow : image.src;
      return {
        light: { src, srcSet: undefined },
        dark: given(image.srcNarrowDark)
          ? { src: image.srcNarrowDark, srcSet: undefined }
          : undefined,
      };
    }
    return {
      light: { src: image.src, srcSet: image.srcSet },
      dark: given(image.srcDark)
        ? { src: image.srcDark, srcSet: image.srcSetDark }
        : undefined,
    };
  };
  return (
    <div
      ref={setBox}
      inert
      data-slot="app-card-shot"
      data-loaded={loaded ? "" : undefined}
      {...stylex.props(styles.shot)}
    >
      {loaded ? null : <Waiting />}
      {widths.map((width) => {
        const sources = sourcesOf(width);
        return (
          <Picture
            key={width ?? "any"}
            light={sources.light}
            dark={sources.dark}
            alt={image.alt}
            sizes={sizes}
            scheme={scheme}
            width={width}
            onLoaded={loadedNow}
            onFailed={onFailed}
          />
        );
      })}
    </div>
  );
};

/** What stands in the window while the app doesn't run: its poster, or the Skeleton. */
const Still = ({ poster }: { poster: AppCardImage | undefined }) => {
  if (poster === undefined) {
    return (
      <div aria-hidden="true" {...stylex.props(styles.fill)}>
        <Waiting />
      </div>
    );
  }
  return <Shot image={poster} onFailed={keep} />;
};

/** How long a running app may take to load before its window says it didn't start. */
const LOAD_LIMIT = 15_000;

interface RunningProps {
  live: AppCardLive;
  title: string;
  onFailed: () => void;
}

/**
 * The app running in its window: mounted only while its card is in view (Live), laid out at a
 * desktop's width and scaled to fit, sharp. Until it has loaded the poster stands over it (or the
 * Skeleton), so it comes in whole; mounted afresh each time, it starts unloaded each time.
 */
const Running = ({ live, title, onFailed }: RunningProps) => {
  const [room, setRoom] = useState<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const byMessage = live.ready === "message";
  // Told by the app itself, from its own frame alone, that it has drawn (or failed).
  useEffect(() => {
    if (!byMessage || frame === null) {
      return keep;
    }
    const heard = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || !isSignal(event.data)) {
        return;
      }
      if (event.data.state === "ready") {
        setLoaded(true);
      } else {
        onFailed();
      }
    };
    window.addEventListener("message", heard);
    return () => {
      window.removeEventListener("message", heard);
    };
  }, [byMessage, frame, onFailed]);
  // The still is gone once it has faded out (with reduced motion it is cut, and simply stays clear).
  const [gone, setGone] = useState(false);
  const fit = useFit(room);
  useEffect(() => {
    if (loaded) {
      return keep;
    }
    const limit = setTimeout(onFailed, LOAD_LIMIT);
    return () => {
      clearTimeout(limit);
    };
  }, [loaded, onFailed]);
  return (
    <div
      ref={setRoom}
      data-slot="app-card-running"
      data-loaded={loaded ? "" : undefined}
      {...stylex.props(styles.fill)}
    >
      <div
        data-slot="app-card-canvas"
        {...stylex.props(
          styles.canvas,
          fit !== undefined && [
            styles.measured,
            styles.fit(fit.scale, fit.width, fit.shiftX, fit.shiftY),
          ]
        )}
      >
        <iframe
          ref={setFrame}
          src={live.src}
          title={live.title ?? title}
          sandbox={live.sandbox ?? "allow-scripts"}
          referrerPolicy="no-referrer"
          loading="lazy"
          inert
          aria-hidden="true"
          tabIndex={-1}
          onLoad={() => {
            if (!byMessage) {
              setLoaded(true);
            }
          }}
          data-slot="app-card-app"
          {...stylex.props(styles.iframe)}
        />
      </div>
      {/* The still over the app until it has loaded, then fading out: one calm change, no flash. */}
      {gone ? null : (
        <div
          aria-hidden="true"
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget) {
              setGone(true);
            }
          }}
          {...stylex.props(styles.fill, styles.over, loaded && styles.faded)}
        >
          <Still poster={live.poster} />
        </div>
      )}
    </div>
  );
};

interface LiveProps {
  live: AppCardLive;
  title: string;
  /** The card is hovered or holds the focus: with reduced motion, the only time the app runs. */
  attention: boolean;
  onFailed: () => void;
}

/**
 * A running app that runs only while its card is in view (one observer for the page, watch.ts),
 * and stops a moment after it leaves, its poster standing in its place; with reduced motion only
 * while its card is hovered or focused.
 */
const Live = ({ live, title, attention, onFailed }: LiveProps) => {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const inView = useInView(box);
  const reduced = useReducedMotion();
  const runs = inView && (!reduced || attention);
  return (
    <div
      ref={setBox}
      data-slot="app-card-live"
      data-running={runs ? "" : undefined}
      {...stylex.props(styles.fill)}
    >
      {runs ? (
        <Running live={live} title={title} onFailed={onFailed} />
      ) : (
        <Still poster={live.poster} />
      )}
    </div>
  );
};

/** What the canvas holds, laid out at a desktop's width: App building, the running app, or a picture. */
const Inside = ({
  preview,
  building,
  buildingLabel,
}: Pick<WindowProps, "preview" | "building" | "buildingLabel">) => {
  if (building) {
    return <AppBuilding aria-label={buildingLabel} />;
  }
  // A screenshot and a running app stand in the window itself (Window), not on this canvas.
  if (!isNode(preview)) {
    return null;
  }
  return (
    <div aria-hidden="true" inert {...stylex.props(styles.picture)}>
      {preview}
    </div>
  );
};

/**
 * The window in the frame: a screenshot of the app, or the app scaled to fit, cropped by the
 * frame's foot; or a quiet line.
 */
export const Window = ({
  preview,
  title,
  mark,
  attention,
  building,
  failed,
  buildingLabel,
  failedLabel,
  emptyLabel,
}: WindowProps) => {
  const [room, setRoom] = useState<HTMLDivElement | null>(null);
  // The preview itself failed: its screenshot didn't load, or the app didn't load in time.
  const [broken, setBroken] = useState(false);
  const breaks = () => {
    setBroken(true);
  };
  const empty = preview === undefined || preview === null || preview === false;
  const fit = useFit(room);
  if (failed || broken || (empty && !building)) {
    const isFailed = failed || broken;
    return (
      <div
        {...stylex.props(styles.window)}
        data-slot="app-card-window"
        data-failed={isFailed ? "" : undefined}
      >
        <div {...stylex.props(styles.quiet)}>
          {mark === undefined || mark === null ? null : (
            <span aria-hidden="true" {...stylex.props(styles.quietMark)}>
              {mark}
            </span>
          )}
          <p {...stylex.props(styles.quietWords)}>
            {isFailed ? failedLabel : emptyLabel}
          </p>
        </div>
      </div>
    );
  }
  if (!building && isImage(preview)) {
    return (
      <div {...stylex.props(styles.window)} data-slot="app-card-window">
        <Shot image={preview} onFailed={breaks} />
      </div>
    );
  }
  if (!building && isLive(preview)) {
    return (
      <div {...stylex.props(styles.window)} data-slot="app-card-window">
        <Live
          live={preview}
          title={title}
          attention={attention}
          onFailed={breaks}
        />
      </div>
    );
  }
  return (
    <div
      ref={setRoom}
      {...stylex.props(styles.window)}
      data-slot="app-card-window"
    >
      <div
        data-slot="app-card-canvas"
        {...stylex.props(
          styles.canvas,
          fit !== undefined && [
            styles.measured,
            styles.fit(fit.scale, fit.width, fit.shiftX, fit.shiftY),
          ]
        )}
      >
        <Inside
          preview={preview}
          building={building}
          buildingLabel={buildingLabel}
        />
      </div>
    </div>
  );
};

interface MoreMenuProps {
  actions: readonly AppCardAction[];
  label: string;
}

/** The "…" button at the title row's end, its own press over the card's link, and its menu. */
export const MoreMenu = ({ actions, label }: MoreMenuProps) => (
  <span {...stylex.props(styles.more)}>
    <DropdownMenuMore actions={actions} label={label} />
  </span>
);
