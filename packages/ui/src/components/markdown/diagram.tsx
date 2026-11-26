// A finished `mermaid` fence in Markdown, drawn as its diagram, as Streamdown draws one: Mermaid,
// loaded only when a diagram is drawn, at its strict security level, once it is near the screen;
// the code in CodeBlock until it has drawn, and for good when it cannot. Download (SVG, PNG or the
// code as MMD), Copy and full screen beside it, and zoom, a drag and the arrow keys to move it.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useRef, useState } from "react";

import { useI18n } from "../../lib/i18n";
import {
  DownloadIcon,
  Icon,
  Maximize2Icon,
  RefreshCwIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "../../lib/icons";
import { focusRing, visuallyHidden } from "../../lib/styles";
import { colors, radius, space } from "../../lib/tokens.stylex";
import { nothing, saveFile } from "../../lib/utils";
import { Button } from "../button";
import * as Code from "../code-block";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { drawable, safeSvg } from "./diagram-safe";
import { themeAt, watchScheme } from "./diagram-theme";
import type { DiagramTheme } from "./diagram-theme";

const styles = stylex.create({
  view: {
    position: "relative",
    overflow: "hidden",
    minHeight: 160,
    padding: space["4"],
    // The ground the diagram's theme is resolved on (diagram-theme.ts).
    backgroundColor: colors.background,
    borderRadius: radius.md,
    cornerShape: radius.shape,
    cursor: "grab",
  },
  big: { height: "100%", minHeight: "60vh", touchAction: "none" },
  drawing: {
    display: "flex",
    justifyContent: "center",
    transformOrigin: "center",
  },
  moved: (x: number, y: number, zoom: number) => ({
    transform: `translate(${x}px, ${y}px) scale(${zoom})`,
  }),
  zoom: {
    position: "absolute",
    insetInlineStart: space["2"],
    insetBlockEnd: space["2"],
    display: "flex",
    gap: space["1"],
    // Each control's touch target reaches the middle of the gap to the next (tapTarget).
    "--tap-room-inline": `calc(${space["1"]} / 2)`,
  },
});

// Zoom as Streamdown's: from half to three times, a tenth a step. The arrow keys move it 40px.
const LEAST = 0.5;
const MOST = 3;
const STEP = 0.1;
const NUDGE = 40;

/**
 * Settings a diagram's own `%%{init}%%` may not change: Mermaid's own (its security level, its
 * limits), and every one that would put HTML, a style or a font from elsewhere in the drawing.
 */
const SECURE = [
  "secure",
  "securityLevel",
  "theme",
  "darkMode",
  "startOnLoad",
  "maxTextSize",
  "suppressErrorRendering",
  "maxEdges",
  "htmlLabels",
  "flowchart",
  "themeCSS",
  "fontFamily",
  "altFontFamily",
  "themeVariables",
];
// The policy of the frame Mermaid draws in: nothing it puts there while drawing (a picture, a
// style's `url()`, a font) can load, whatever the fence says. Its styles are inline.
const FRAME_POLICY = "default-src 'none'; style-src 'unsafe-inline'";

/** Gives Mermaid's frame its policy, once, before Mermaid draws in it. */
const guard = (frame: HTMLIFrameElement) => {
  const inside = frame.contentDocument;
  if (inside === null || inside.querySelector("meta[http-equiv]") !== null) {
    return;
  }
  const policy = inside.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = FRAME_POLICY;
  inside.head.append(policy);
};

/** The SVG in the frame Mermaid's sandbox gives back: a `data:` page of a body round it. */
const svgOfFrame = (frame: string) => {
  const encoded =
    /src="data:text\/html;charset=UTF-8;base64,(?<page>[^"]+)"/u.exec(frame)
      ?.groups?.page;
  if (encoded === undefined) {
    return null;
  }
  const page = new TextDecoder().decode(
    Uint8Array.from(atob(encoded), (character) => character.codePointAt(0) ?? 0)
  );
  return (
    /^<body[^>]*>(?<svg>[\s\S]*)<\/body>$/u.exec(page)?.groups?.svg ?? null
  );
};

// One drawing at a time: Mermaid then makes its frame as it is asked, and it has its policy before
// Mermaid draws in it. The drawing before this one ends when this promise does.
let turn: Promise<unknown> = Promise.resolve();

/**
 * Draws `code` with Mermaid, loaded the first time: its SVG, held to SVG's own shapes, or null when
 * it cannot. A fence that is not `drawable` is never drawn (`check: false` is for the spec that
 * shows the frame alone loads nothing). Mermaid draws in its sandbox's frame, out of sight and with
 * a policy that loads nothing, never in the page: what it measures is measured there.
 */
export const drawDiagram = async (
  code: string,
  id: string,
  { check = true, theme }: { check?: boolean; theme?: DiagramTheme } = {}
) => {
  if (check && !drawable(code)) {
    return null;
  }
  const before = turn;
  let done = nothing;
  // oxlint-disable-next-line promise/avoid-new -- this drawing's turn, which ends when it does
  turn = new Promise<void>((resolve) => {
    done = resolve;
  });
  await before;
  const box = document.createElement("div");
  const watch = new MutationObserver(() => {
    for (const frame of box.querySelectorAll("iframe")) {
      guard(frame);
    }
  });
  try {
    box.setAttribute("aria-hidden", "true");
    // Out of sight, at a size of its own, so what Mermaid measures is laid out.
    box.setAttribute(
      "style",
      "position:fixed;inset-inline-start:-10000px;top:0;width:1000px;height:1000px;visibility:hidden;pointer-events:none"
    );
    document.body.append(box);
    watch.observe(box, { childList: true, subtree: true });
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "sandbox",
      secure: SECURE,
      suppressErrorRendering: true,
      // The design system's look, from its tokens as they resolve where the diagram stands.
      theme: "base",
      themeVariables: theme?.variables ?? {},
      // Labels as SVG text, not HTML in the drawing.
      htmlLabels: false,
      // Mermaid's own bounds, under the fence's own (drawable).
      maxTextSize: 20_000,
      maxEdges: 200,
    });
    const pending = mermaid.render(id, code, box);
    // Made as Mermaid was asked, before it reads the fence and draws.
    for (const frame of box.querySelectorAll("iframe")) {
      guard(frame);
    }
    const { svg: framed } = await pending;
    const svg = svgOfFrame(framed);
    return svg === null ? null : safeSvg(svg, id);
  } catch {
    return null;
  } finally {
    watch.disconnect();
    box.remove();
    done();
  }
};

/** The numbers of the drawing's `viewBox`: where it starts, and its size. */
const boxOf = (svg: string) =>
  /viewBox="(?<box>[^"]*)"/u
    .exec(svg)
    ?.groups?.box?.split(/[\s,]+/u)
    .map(Number) ?? [];

/** The drawing on a ground of its own, as it is on the page: for a file, seen anywhere. */
const onGround = (svg: string, ground: string) => {
  const [x = 0, y = 0, width = 0, height = 0] = boxOf(svg);
  return svg.replace(
    /<svg\b[^>]*>/u,
    (open) =>
      `${open}<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${ground}"/>`
  );
};

/** The drawing as a PNG, at twice its size (less for a huge one): drawn onto a canvas. */
const pngOf = async (svg: string) => {
  const box = boxOf(svg);
  const width = box[2] ?? 0;
  const height = box[3] ?? 0;
  if (!(width > 0 && height > 0)) {
    throw new Error("The drawing has no size");
  }
  // A data: address, which a policy that allows pictures from data: allows (a blob: one, not).
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const scale = Math.min(2, 8192 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  context?.scale(scale, scale);
  context?.drawImage(image, 0, 0, width, height);
  // oxlint-disable-next-line promise/avoid-new -- a canvas gives its blob by a callback
  const png = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/png");
  });
  if (png === null) {
    throw new Error("The drawing could not be drawn as a PNG");
  }
  return png;
};

/** The drawing's own title (Mermaid's `accTitle`), when it has one. */
const titleOf = (svg: string) =>
  new DOMParser()
    .parseFromString(svg, "image/svg+xml")
    .querySelector(":root > title")
    ?.textContent?.trim() ?? "";

/**
 * The drawing, zoomed by its buttons, moved by a drag and by the arrow keys; named by its title,
 * else as a Mermaid diagram.
 */
const View = ({
  svg,
  code,
  title,
  big = false,
}: {
  svg: string;
  code: string;
  title: string;
  big?: boolean;
}) => {
  const words = useI18n().markdown;
  const source = useId();
  const box = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [at, setAt] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const drawing = new DOMParser().parseFromString(svg, "image/svg+xml");
    box.current?.replaceChildren(
      document.importNode(drawing.documentElement, true)
    );
  }, [svg]);
  const zoomBy = (step: number) => {
    setZoom((now) => Math.min(MOST, Math.max(LEAST, now + step)));
  };
  const arrows: Record<string, { x: number; y: number }> = {
    ArrowLeft: { x: NUDGE, y: 0 },
    ArrowRight: { x: -NUDGE, y: 0 },
    ArrowUp: { x: 0, y: NUDGE },
    ArrowDown: { x: 0, y: -NUDGE },
  };
  return (
    <div
      {...stylex.props(styles.view, big && styles.big)}
      onPointerDown={(event) => {
        // A finger scrolls the answer past a diagram, and moves it only in full screen.
        if (event.button === 0 && (big || event.pointerType !== "touch")) {
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({ x: event.clientX - at.x, y: event.clientY - at.y });
        }
      }}
      onPointerMove={(event) => {
        if (drag !== null) {
          setAt({ x: event.clientX - drag.x, y: event.clientY - drag.y });
        }
      }}
      onPointerUp={() => {
        setDrag(null);
      }}
      onPointerCancel={() => {
        setDrag(null);
      }}
    >
      {/* Named as a diagram, its code its description; the arrow keys move it. */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the arrow keys move the drawing, as Streamdown's pan area moves */}
      <div
        ref={box}
        role="application"
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- it takes focus for the arrow keys
        tabIndex={0}
        aria-label={title === "" ? words.diagram : title}
        aria-describedby={source}
        data-slot="markdown-diagram-drawing"
        onKeyDown={(event) => {
          const by = arrows[event.key];
          if (by !== undefined) {
            event.preventDefault();
            setAt((now) => ({ x: now.x + by.x, y: now.y + by.y }));
          }
        }}
        {...stylex.props(
          styles.drawing,
          focusRing,
          styles.moved(at.x, at.y, zoom)
        )}
      />
      <span id={source} {...stylex.props(visuallyHidden)}>
        {code}
      </span>
      <div
        {...stylex.props(styles.zoom)}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
      >
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={words.zoomIn}
          disabled={zoom >= MOST}
          onClick={() => {
            zoomBy(STEP);
          }}
        >
          <Icon icon={ZoomInIcon} />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={words.zoomOut}
          disabled={zoom <= LEAST}
          onClick={() => {
            zoomBy(-STEP);
          }}
        >
          <Icon icon={ZoomOutIcon} />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={words.resetZoom}
          onClick={() => {
            setZoom(1);
            setAt({ x: 0, y: 0 });
          }}
        >
          <Icon icon={RefreshCwIcon} />
        </Button>
      </div>
    </div>
  );
};

/**
 * A finished `mermaid` fence: its diagram once Mermaid has drawn it (once it is near the screen),
 * the code until then and for good when Mermaid cannot read it; Download, Copy and full screen,
 * out of use while the answer is written.
 */
export const Diagram = ({
  code,
  streaming,
}: {
  code: string;
  streaming: boolean;
}) => {
  const words = useI18n().markdown;
  const id = `mermaid-${useId().replaceAll(/[^\w-]/gu, "")}`;
  const frame = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  // The last drawing, and the code it is of: its SVG, or null for code Mermaid could not draw.
  const [drawn, setDrawn] = useState<{
    code: string;
    theme: string;
    svg: string | null;
    title: string;
  } | null>(null);
  const svg = drawn?.svg ?? null;
  // The look it is drawn in, resolved where it stands; drawn again when the colour scheme changes.
  const [theme, setTheme] = useState<DiagramTheme | null>(null);
  useEffect(() => {
    const at = frame.current;
    if (!near || at === null) {
      return nothing;
    }
    const resolve = () => {
      const now = themeAt(at);
      setTheme((was) => (was?.key === now.key ? was : now));
    };
    resolve();
    return watchScheme(resolve);
  }, [near]);
  // Drawn once it comes within 300px of the screen, as Streamdown draws one.
  useEffect(() => {
    const at = frame.current;
    if (at === null || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return nothing;
    }
    const watch = new IntersectionObserver(
      (seen) => {
        if (seen.some((each) => each.isIntersecting)) {
          setNear(true);
          watch.disconnect();
        }
      },
      { rootMargin: "300px" }
    );
    watch.observe(at);
    return () => {
      watch.disconnect();
    };
  }, []);
  useEffect(() => {
    let live = true;
    const draw = async (look: DiagramTheme) => {
      const made = await drawDiagram(code, id, { theme: look });
      if (live) {
        setDrawn({
          code,
          theme: look.key,
          svg: made === null ? null : onGround(made, look.background),
          title: made === null ? "" : titleOf(made),
        });
      }
    };
    if (theme !== null) {
      void draw(theme);
    }
    return () => {
      live = false;
    };
  }, [code, id, theme]);
  return (
    // Busy while Mermaid loads and draws it, once it is near the screen.
    <div
      ref={frame}
      data-slot="markdown-diagram"
      aria-busy={near && (drawn?.code !== code || drawn.theme !== theme?.key)}
    >
      <Code.CodeBlock language="mermaid">
        <Code.CodeBlockHeader>
          <Code.CodeBlockTitle />
          <Code.CodeBlockActions>
            <DropdownMenu>
              <DropdownMenuTrigger asChild disabled={streaming}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={words.downloadDiagram}
                >
                  <Icon icon={DownloadIcon} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {svg !== null && (
                  <DropdownMenuItem
                    onSelect={() => {
                      saveFile(svg, "diagram.svg", "image/svg+xml");
                    }}
                  >
                    {words.svg}
                  </DropdownMenuItem>
                )}
                {svg !== null && (
                  <DropdownMenuItem
                    onSelect={async () => {
                      saveFile(await pngOf(svg), "diagram.png", "image/png");
                    }}
                  >
                    {words.png}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onSelect={() => {
                    saveFile(code, "diagram.mmd", "text/plain");
                  }}
                >
                  {words.mmd}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Code.CodeBlockCopyButton value={code} disabled={streaming} />
            {svg !== null && (
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={words.fullScreen}
                    disabled={streaming}
                  >
                    <Icon icon={Maximize2Icon} />
                  </Button>
                </DialogTrigger>
                <DialogContent size="full">
                  <DialogHeader>
                    <DialogTitle>{words.mermaid}</DialogTitle>
                  </DialogHeader>
                  <View svg={svg} code={code} title={drawn?.title ?? ""} big />
                </DialogContent>
              </Dialog>
            )}
          </Code.CodeBlockActions>
        </Code.CodeBlockHeader>
        {svg === null ? (
          <Code.CodeBlockContent lineNumbers>{code}</Code.CodeBlockContent>
        ) : (
          <View svg={svg} code={code} title={drawn?.title ?? ""} />
        )}
      </Code.CodeBlock>
    </div>
  );
};
