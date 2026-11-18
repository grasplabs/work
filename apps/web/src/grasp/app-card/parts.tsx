// App card's parts: the window with the app in it (a screenshot of it, the app running scaled to
// fit, a picture, App building, or a quiet line), and the "…" menu.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { RenderProp } from "@ui-sdk/react/primitive";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { AppBuilding } from "../app-building";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { More } from "../icons";
import type { IconData } from "../icons";
import { styles } from "./styles";

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
}

/** What the window shows: a screenshot of the app (the default kind), or the app running. */
export type AppCardPreview = AppCardImage | AppCardLive;

/** One action in the card's "…" menu. */
export interface AppCardAction {
  /** Its words ("Rename", "Duplicate"). */
  label: string;
  /** Runs when it is chosen. */
  onSelect?: () => void;
  /** An icon before the words. Import it from the icons entry (`@/components/grasp/icons`). */
  icon?: IconData;
  /** A step that cannot be undone, in the danger colour. */
  danger?: boolean;
  /** Shown, but not chosen now. */
  disabled?: boolean;
  /**
   * Where it leads ("Settings"): the item is then a link, opened by a press, Enter, a middle click
   * or in a new tab, as Dropdown menu's item is. The menu closes as it goes.
   */
  href?: string;
  /**
   * The link a router draws (`<Link to="…" />`), in place of an `<a href>`: it takes the item's look,
   * words and place in the arrows' order. Leave `href` out when the router's link carries the address.
   */
  render?: RenderProp;
}

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

// The width the app is laid out at: a desktop's, down to a tablet's in a small window (as the
// app-card-app-width token says before the window is measured), and the band a sharp scale may
// move it within.
const DESKTOP = 1280;
const TABLET = 768;
const NARROWEST = 560;
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
  const wanted = Math.min(DESKTOP, Math.max(TABLET, box.width * 2.4));
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
}

// The dark source's condition: the system's scheme until the card knows its own, then always or
// never. A picture loads only the source it chooses, and chooses again when this changes.
const darkWhen = (scheme: PictureProps["scheme"]) => {
  if (scheme === undefined) {
    return "(prefers-color-scheme: dark)";
  }
  return scheme === "dark" ? "all" : "not all";
};

/** One screenshot: only the shot of the scheme the card stands in is loaded, at the size it is drawn. */
const Picture = ({ light, dark, alt, sizes, scheme, width }: PictureProps) => (
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
const Shot = ({ image }: { image: AppCardImage }) => {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
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
      {...stylex.props(styles.shot)}
    >
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
          />
        );
      })}
    </div>
  );
};

/** What the canvas holds, laid out at a desktop's width: App building, the running app, or a picture. */
const Inside = ({
  preview,
  title,
  building,
  buildingLabel,
}: Pick<WindowProps, "preview" | "title" | "building" | "buildingLabel">) => {
  if (building) {
    return <AppBuilding aria-label={buildingLabel} />;
  }
  if (isLive(preview)) {
    return (
      <iframe
        src={preview.src}
        title={preview.title ?? title}
        sandbox={preview.sandbox ?? "allow-scripts"}
        referrerPolicy="no-referrer"
        loading="lazy"
        inert
        aria-hidden="true"
        tabIndex={-1}
        data-slot="app-card-app"
        {...stylex.props(styles.iframe)}
      />
    );
  }
  // A screenshot stands in the window itself (Window), not on the canvas.
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
  building,
  failed,
  buildingLabel,
  failedLabel,
  emptyLabel,
}: WindowProps) => {
  const [room, setRoom] = useState<HTMLDivElement | null>(null);
  const empty = preview === undefined || preview === null || preview === false;
  const fit = useFit(room);
  if (failed || (empty && !building)) {
    return (
      <div {...stylex.props(styles.window)} data-slot="app-card-window">
        <p {...stylex.props(styles.quiet)}>
          {failed ? failedLabel : emptyLabel}
        </p>
      </div>
    );
  }
  if (!building && isImage(preview)) {
    return (
      <div {...stylex.props(styles.window)} data-slot="app-card-window">
        <Shot image={preview} />
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
          title={title}
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
    <DropdownMenu>
      <DropdownMenuTrigger
        icon={More}
        aria-label={label}
        variant="ghost"
        size="sm"
      />
      <DropdownMenuContent align="end">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.label}
            icon={action.icon}
            variant={action.danger === true ? "danger" : undefined}
            disabled={action.disabled}
            href={action.href}
            render={action.render}
            onSelect={() => {
              action.onSelect?.();
            }}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  </span>
);
