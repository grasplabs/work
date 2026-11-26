// Small things every component shares: the style a caller may pass, the live regions, a ref
// helper, a measure after layout, asChild, the words among children, and the system's dither as
// numbers.
import * as stylex from "@stylexjs/stylex";
import { announce as say, prepareAnnouncements } from "@ui-sdk/core";
import { renderElement } from "@ui-sdk/react/primitive";
import type { RenderProp } from "@ui-sdk/react/primitive";
import {
  createContext,
  createElement,
  isValidElement,
  lazy,
  use,
  useSyncExternalStore,
} from "react";
import type { ReactElement, ReactNode, Ref } from "react";

import { durations } from "./tokens.values";

type Value = string | number | null;

/**
 * What a caller may style on any part, by its `style` prop: where it sits and how much room it
 * takes, never its look, its colours, its corners or its inner spacing, which belong to the part.
 * Every part takes exactly this set, so what works on one works on all: hiding a phone-only picker
 * on wide screens is `display: { default: null, [media.md]: "none" }` on a Select as on a Button.
 */
export type LayoutStyle = stylex.StyleXStyles<{
  // Whether it shows, as a box: `none` to leave it out at some widths.
  display?: Value;
  // Its place in the row or grid around it.
  alignSelf?: Value;
  justifySelf?: Value;
  gridArea?: Value;
  gridColumn?: Value;
  gridRow?: Value;
  order?: Value;
  flexGrow?: Value;
  flexShrink?: Value;
  flexBasis?: Value;
  // The room around it.
  margin?: Value;
  marginBlock?: Value;
  marginBlockStart?: Value;
  marginBlockEnd?: Value;
  marginInline?: Value;
  marginInlineStart?: Value;
  marginInlineEnd?: Value;
  // How much room it takes, from the layout around it.
  width?: Value;
  minWidth?: Value;
  maxWidth?: Value;
  height?: Value;
  minHeight?: Value;
  maxHeight?: Value;
  aspectRatio?: Value;
  // Held in place while the page scrolls past it (a sticky bar), or laid over its neighbours.
  position?: Value;
  inset?: Value;
  insetBlock?: Value;
  insetBlockStart?: Value;
  insetBlockEnd?: Value;
  insetInline?: Value;
  insetInlineStart?: Value;
  insetInlineEnd?: Value;
  zIndex?: Value;
}>;

/** Which way a group of parts runs. */
export type Orientation = "horizontal" | "vertical";

/**
 * `asChild` onto UI SDK's `render`: with `asChild` and one element as the child, that element is
 * drawn instead of the part's own, with the part's props merged onto it; otherwise
 * the children stay the part's own.
 *
 *   <DialogTriggerPrimitive {...props} {...slotProps(asChild, children)} />
 */
export const slotProps = (
  asChild: boolean | undefined,
  children: ReactNode
): { render?: ReactElement<Record<string, unknown>>; children?: ReactNode } =>
  asChild === true && isValidElement<Record<string, unknown>>(children)
    ? { render: children }
    : { children };

/**
 * The class of some styles, where a part takes a class and not props: UI SDK's `className` (a
 * string, or a function of the part's state) and an element measured by its class.
 */
export const className = (
  ...parts: stylex.StyleXArray<
    | stylex.CompiledStyles
    | readonly [stylex.CompiledStyles, stylex.InlineStyles]
    | boolean
    | null
    | undefined
  >[]
) => stylex.props(...parts).className;

/**
 * Renders a part as `tag` with the component's own slot (`dropdown-menu-item`): UI SDK names its
 * parts after its own primitive (menu-item), and overwrites a slot given as a prop.
 */
export const slotted =
  (tag: string, slot: string, render?: RenderProp) =>
  (props: Record<string, unknown>) =>
    renderElement(tag, { ...props, "data-slot": slot }, render);

/**
 * As `slotProps`, for a part that draws more round its words (an icon, keys, a chevron): with
 * `asChild` the element given is drawn without its words, and its words come back as `children`.
 */
export const slotWords = (
  asChild: boolean | undefined,
  children: ReactNode
): { render?: ReactElement<Record<string, unknown>>; children?: ReactNode } => {
  if (
    asChild !== true ||
    !isValidElement<Record<string, unknown> & { children?: ReactNode }>(
      children
    )
  ) {
    return { children };
  }
  const { children: words, ...own } = children.props;
  return { render: createElement(children.type, own), children: words };
};

/** Children as one flat list, from lists at any depth, without the ones that draw nothing. */
export const listOf = (children: ReactNode): ReactNode[] =>
  [children]
    .flat(Number.POSITIVE_INFINITY)
    .filter(
      (child: unknown): child is ReactNode =>
        child !== null && child !== undefined && typeof child !== "boolean"
    );

/**
 * Whether children draw nothing: none, null, false, empty words, or a list of only those. A number
 * is content, 0 too.
 */
export const isBlank = (children: unknown): boolean =>
  children === undefined ||
  children === null ||
  children === false ||
  children === "" ||
  (Array.isArray(children) && children.every(isBlank));

/**
 * What `table` holds under `key` as its own, or undefined: never what every object inherits
 * (`__proto__`, `constructor`, `toString`). For a key that comes from content or data, such as a
 * code fence's language or a column's key.
 */
export const ownValue = <T>(
  table: Readonly<Record<string, T>>,
  key: string
): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** The schemes a link may lead to. Any other (javascript:, data:, file:) leads nowhere. */
const ALLOWED = new Set(["http:", "https:", "mailto:", "tel:"]);
/** The site a relative address is read against, to tell a path on this site from another's. */
const SAME_SITE = "https://same-site.invalid";

/**
 * Where a link given as data may lead (an answer's, a source's), resolved; null when nowhere: any
 * scheme but http, https, mailto and tel, or nothing. With `relative`, a path on the same site
 * (`/files/report`) leads there as written; one that leaves it (`//elsewhere.com`) never does.
 */
export const safeHref = (
  url: string | undefined,
  { relative = false }: { relative?: boolean } = {}
): string | null => {
  if (url === undefined || url === "") {
    return null;
  }
  try {
    const parsed = new URL(url);
    return ALLOWED.has(parsed.protocol) ? parsed.href : null;
  } catch {
    // Not a whole address: a path, perhaps.
  }
  try {
    return relative && new URL(url, `${SAME_SITE}/`).origin === SAME_SITE
      ? url
      : null;
  } catch {
    return null;
  }
};

/** A source's checked address, and where it lives as people read it ("example.com"). */
export interface CitedSource {
  href: string;
  host: string;
}

/**
 * A cited source's address as a link can take it (`safeHref`: http, https, mailto or tel), with the
 * host read from that checked address (without "www.") or, for mail, the address. Anything else
 * (`javascript:`, `data:`, a path, words) is null, and the source is shown as words.
 */
export const citedSource = (url: string | undefined): CitedSource | null => {
  const href = safeHref(url);
  if (href === null) {
    return null;
  }
  const parsed = new URL(href);
  const host = parsed.hostname.replace(/^www\./u, "");
  return { href, host: host === "" ? parsed.pathname : host };
};

// The media a browser plays or draws as pixels only, written into the address itself. SVG is left
// out: it is a document, and can carry script and links of its own.
const INLINE_MEDIA =
  /^data:(?:image\/(?:png|jpeg|gif|webp|avif)|audio\/(?:mpeg|mp4|ogg|wav|webm|aac|flac)|video\/(?:mp4|webm|ogg))[;,]/iu;

/**
 * Where a picture, a sound or a video given as data may load from, or null when it may not. A
 * remote address that a model or another person wrote is a beacon: loading it tells that site who
 * read it and when. So by default only what cannot reach another site loads: media written into
 * the address (`data:` of a picture, sound or video type; never SVG), a file the page made
 * (`blob:`), or a path on this site (`/media/chart.png`). An `http(s)` address loads only with
 * `remote`, which the caller turns on for a source it trusts.
 *
 *   <img src={safeMediaSrc(src, { remote: allowRemote }) ?? undefined} />
 */
export const safeMediaSrc = (
  url: string | undefined,
  { remote = false }: { remote?: boolean } = {}
): string | null => {
  if (url === undefined || url === "") {
    return null;
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    // Not a whole address: a path, perhaps.
  }
  if (parsed === null) {
    return safeHref(url, { relative: true });
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return remote ? parsed.href : null;
  }
  if (parsed.protocol === "blob:") {
    return url;
  }
  return parsed.protocol === "data:" && INLINE_MEDIA.test(url) ? url : null;
};

/** Whether there are words to say: a string that is not empty. */
export const hasText = (text: string | undefined): text is string =>
  text !== undefined && text !== "";

/** The plain words among children, not those inside an element: what typeahead and an agent find. */
export const wordsOf = (children: ReactNode): string =>
  listOf(children)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : ""
    )
    .join("")
    .trim();

/** All the words of a node, inside its elements too: `Delete <b>{name}</b>` reads "Delete Weekly notes". */
export const textOf = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textOf(node.props.children);
  }
  return "";
};

/** Whether a size is an icon-only square's (`icon`, `icon-sm`…): a control that holds no words. */
export const isIconSize = <Size extends string>(
  size: Size | undefined
): size is Extract<Size, `icon${string}`> => size?.startsWith("icon") === true;

/**
 * Whether a field is marked wrong: `aria-invalid` as React and UI SDK give it, a boolean or the
 * string. Any other ARIA state given the same way reads the same (`aria-busy`).
 */
export const isInvalid = (value: unknown) => value === true || value === "true";

// Declared here, for this module only, so a project without Node's types (a Vite app's) type-checks
// it; where Node's types are present this one stands in front of theirs, which agree.
declare const process: { env: { NODE_ENV?: string } };

/**
 * Whether the page is a development build, for the console messages a developer reads. Every
 * bundler a product builds with (Vite, Next, webpack) writes in `process.env.NODE_ENV`.
 */
export const isDevelopment = process.env.NODE_ENV !== "production";

/**
 * In development, says so on the console when nothing names a form control: no label (a
 * FieldLabel in its Field, or a `<label>`), no `aria-label`, no `aria-labelledby`. `part` is the
 * component's name, as the message starts with it. Does nothing in a production build.
 */
export const warnUnnamed = (
  part: string,
  control:
    | HTMLInputElement
    | HTMLButtonElement
    | HTMLTextAreaElement
    | HTMLSelectElement
    | null
) => {
  if (!(isDevelopment && control)) {
    return;
  }
  const named =
    (control.labels?.length ?? 0) > 0 ||
    Boolean(control.getAttribute("aria-label")?.trim()) ||
    Boolean(control.getAttribute("aria-labelledby"));
  if (!named) {
    console.error(
      `${part}: nothing names it. Give it a label (a FieldLabel in its Field) or an aria-label.`
    );
  }
};

/**
 * A part fetched the first time it is drawn: React's `lazy` over one export of a module, so a
 * page that never draws it never pays for it (Markdown in an answer, CodeBlock in a tool call).
 * Draw it inside a Suspense whose fallback shows the same words plainly.
 *
 *   const Markdown = lazyPart(async () => await import("./markdown"), (module) => module.Markdown);
 */
export const lazyPart = <Module, Props extends object>(
  load: () => Promise<Module>,
  pick: (module: Module) => (props: Props) => ReactNode
) =>
  lazy(async () => {
    const loaded = await load();
    return { default: pick(loaded) };
  });

// oxlint-disable-next-line promise/avoid-new -- a promise that never settles has nothing to wrap
const never = new Promise<never>(() => {
  // Never settles: the part it stands in for loads once it shows.
});

/**
 * Until a part first shows, a stand-in that waits for ever, inside the part's Suspense: the
 * browser keeps what the server drew in its place, or shows the fallback when it draws it itself.
 * Once the part shows, draw the lazyPart instead, and it loads then.
 */
export const NotYetShown = (): ReactNode => use(never);

// Words that start like a formula (=, +, -, @, a tab or a return) run as one when a spreadsheet
// opens the file: a leading apostrophe keeps them text. Figures, numbers or written as one ("-12",
// "+3.5%", "1,200"), are left alone.
const formula = /^[=+\-@\t\r]/u;
const figure = /^[+-]?\d[\d,]*(?:\.\d+)?%?$/u;

/** `value` as a spreadsheet's cell: words that start like a formula kept text by an apostrophe. */
const sheetCell = (value: string | number) =>
  typeof value === "string" && formula.test(value) && !figure.test(value)
    ? `'${value}`
    : String(value);

const csvCell = (value: string | number) => {
  const text = sheetCell(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Rows as CSV, each line ended as a spreadsheet expects. */
export const csvOf = (rows: readonly (readonly (string | number)[])[]) =>
  rows.map((line) => line.map(csvCell).join(",")).join("\r\n");

/** Rows as TSV, cells kept text as in CSV: a tab or a line break in a cell written as `\t` or `\n`. */
export const tsvOf = (rows: readonly (readonly string[])[]) =>
  rows
    .map((cells) =>
      cells
        .map((cell) =>
          sheetCell(cell).replaceAll("\t", "\\t").replaceAll(/\r?\n/gu, "\\n")
        )
        .join("\t")
    )
    .join("\n");

/** Saves `text` (or a Blob) as a file of that name and type, which the browser downloads. */
export const saveFile = (text: string | Blob, name: string, type: string) => {
  const href = URL.createObjectURL(
    typeof text === "string" ? new Blob([text], { type }) : text
  );
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.click();
  // Freed once the download has started: some browsers drop a download whose address is gone.
  setTimeout(() => {
    URL.revokeObjectURL(href);
  }, 0);
};

/** What an effect or a subscription that started nothing gives back to undo it. */
export const nothing = () => {
  // Nothing was started, so nothing stops.
};

const REDUCE = "(prefers-reduced-motion: reduce)";
const watchMotion = (changed: () => void) => {
  const query = window.matchMedia(REDUCE);
  query.addEventListener("change", changed);
  return () => {
    query.removeEventListener("change", changed);
  };
};
/** Whether the reader asked for less motion, kept current; on the server, not. */
export const useReducedMotion = () =>
  useSyncExternalStore(
    watchMotion,
    () => window.matchMedia(REDUCE).matches,
    () => false
  );

/** Sets a ref, a function or an object, to `node`. */
export const assignRef = <T>(ref: Ref<T> | undefined, node: T | null) => {
  if (typeof ref === "function") {
    ref(node);
  } else if (ref) {
    ref.current = node;
  }
};

/** How urgently the live region speaks: `polite` waits for a pause, `assertive` interrupts. */
export type Politeness = "polite" | "assertive";

const regions = new Map<Politeness, HTMLElement>();
/**
 * What waits to be said, in order: assertive messages first, then polite ones. A message with a
 * `key` stands for the latest news of one thing (where an item being moved is now).
 */
const waiting: { message: string; politeness: Politeness; key?: string }[] = [];
let speaking = false;
// How long a message stays alone in its region before the next replaces it: long enough for a
// screen reader to have taken it, so one said straight after another never cuts it off.
const HOLD = 400;

// When a message last came into a region from elsewhere (UI SDK's own: a toast, a field's error),
// and what this queue last wrote, so its own words are not taken for another's.
let othersSaidAt = Number.NEGATIVE_INFINITY;
let ours = "";

// A deferred step (the queue's timer, its frame, a region's watch) can run after the page has gone,
// as a test's environment is torn down with a message still waiting: it then does nothing, and the
// queue ends.
const pageGone = (region?: HTMLElement) =>
  typeof document === "undefined" || region?.isConnected === false;

const stop = () => {
  waiting.length = 0;
  speaking = false;
};

/** A message another part said into `region`: the next of ours waits its hold, so it never cuts that one off. */
const heedOthers = (region: HTMLElement) => {
  new MutationObserver(() => {
    if (pageGone(region)) {
      return;
    }
    const text = region.textContent;
    if (text !== "" && text !== ours) {
      othersSaidAt = performance.now();
    }
  }).observe(region, { childList: true, characterData: true, subtree: true });
};

/**
 * The page's two live regions, UI SDK's (`prepareAnnouncements`), so the page has one pair, there
 * before anything is said. UI SDK makes them `role="status"` and `role="alert"`: an empty status
 * and an empty alert on every page, which a page's own `getByRole("status")` or "no alert here"
 * then finds. The roles go; `aria-live` and `aria-atomic`, all either role means to a screen
 * reader, stay. Does nothing on the server, or where UI SDK speaks through an announcer of its own.
 *
 * What it relies on in UI SDK (platform/announce.js, at the pinned version; live-regions.spec
 * fails if it changes): each region is a child of the body marked `data-ui-sdk-announcer`, `""`
 * for the polite one and `"assertive"` for the other, and one that has left the page is made anew,
 * with its role, at its next message. So a new region is readied as it comes (`watchLiveRegions`).
 */
export const readyLiveRegions = (): void => {
  if (typeof document === "undefined" || document.body === null) {
    return;
  }
  prepareAnnouncements(document);
  for (const politeness of ["polite", "assertive"] as const) {
    const region = document.querySelector<HTMLElement>(
      politeness === "assertive"
        ? '[data-ui-sdk-announcer="assertive"]'
        : '[data-ui-sdk-announcer=""]'
    );
    if (region === null || regions.get(politeness) === region) {
      continue;
    }
    region.removeAttribute("role");
    heedOthers(region);
    regions.set(politeness, region);
  }
};

/** Readies the regions now, and again whenever UI SDK puts a new one in the body. */
const watchLiveRegions = () => {
  readyLiveRegions();
  new MutationObserver((changes) => {
    if (
      changes.some((change) =>
        [...change.addedNodes].some(
          (node) =>
            node instanceof HTMLElement &&
            node.dataset.uiSdkAnnouncer !== undefined
        )
      )
    ) {
      readyLiveRegions();
    }
  }).observe(document.body, { childList: true });
};

// Ready from the start, so a screen reader knows the regions before their first message.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watchLiveRegions, {
      once: true,
    });
  } else if (document.body !== null) {
    watchLiveRegions();
  }
}

const sayNext = () => {
  if (pageGone()) {
    stop();
    return;
  }
  const next = waiting.shift();
  speaking = next !== undefined;
  if (next === undefined) {
    return;
  }
  readyLiveRegions();
  const region = regions.get(next.politeness);
  if (region === undefined) {
    // UI SDK speaks through an announcer of its own: this goes there.
    say(next.message, { priority: next.politeness });
    setTimeout(sayNext, HOLD);
    return;
  }
  // Another part's message is still being taken: this one waits until it has been.
  const wait = othersSaidAt + HOLD - performance.now();
  if (wait > 0) {
    waiting.unshift(next);
    setTimeout(sayNext, wait);
    return;
  }
  // Emptied first, so the same message twice in a row is said twice.
  region.textContent = "";
  requestAnimationFrame(() => {
    if (pageGone(region)) {
      stop();
      return;
    }
    ours = next.message;
    region.textContent = next.message;
    setTimeout(sayNext, HOLD);
  });
};

/**
 * Says `message` once to a screen reader, through the page's one pair of live regions, UI SDK's,
 * readied as the page starts (`readyLiveRegions`). A part never puts a live region beside
 * itself, so nothing is added next to a button in a row. Messages said in quick succession wait
 * their turn, each said whole: polite ones in order, an assertive one ahead of the polite ones
 * still waiting. A message with a `key` takes the place of the one with that key still waiting,
 * so news that is out of date by the time its turn comes is never said: a move, not every step
 * of it. Does nothing on the server.
 *
 *   announce(saved);
 *   announce(`${name}, position ${at} of ${total}.`, "assertive", "move");
 */
export const announce = (
  message: string,
  politeness: Politeness = "polite",
  key?: string
) => {
  if (typeof document === "undefined") {
    return;
  }
  // The out-of-date news goes, and this takes its turn as a new message: after anything said
  // since (a drop, the next pick up), never before it.
  const stale =
    key === undefined ? -1 : waiting.findIndex((each) => each.key === key);
  if (stale !== -1) {
    waiting.splice(stale, 1);
  }
  const at =
    politeness === "assertive"
      ? waiting.findIndex((each) => each.politeness === "polite")
      : -1;
  waiting.splice(at === -1 ? waiting.length : at, 0, {
    message,
    politeness,
    key,
  });
  if (!speaking) {
    sayNext();
  }
};

/**
 * Says that work is under way. Words the caller gave for it (`own`) are said at once; the
 * catalogue's plain word only once the work has run for loading-delay, so quick work with no words
 * of its own (a copy) says only how it went. Returns what to call when the work is over.
 *
 *   const over = announceWork(saving, true);   await work;   over();   announce(saved);
 */
export const announceWork = (message: string, own: boolean) => {
  const timer = setTimeout(
    () => {
      announce(message);
    },
    own ? 0 : durations.loadingDelay
  );
  return () => {
    clearTimeout(timer);
  };
};

// The system's dither, as numbers: ordered dither on a 4×4 Bayer matrix, in two textures. Charts
// draw it as SVG patterns, Empty draws what will stand in a place with it. One matrix and one set
// of sizes, so every dither in Damsko is this dither.

/** The ordered-dither thresholds, 0 to 15: a cell is lit while the level is above its number. */
export const BAYER_MATRIX: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** How many levels the dither has, and so how many bands a fill is cut into. */
export const DITHER_LEVELS = 16;

/** A dither's texture: 2px cells that fill their square (`pixels`), or 1px dots on a 3px pitch. */
export type DitherTexture = "pixels" | "dots";

/** A cell's pitch and the square drawn in it, per texture, in CSS pixels. */
export const DITHER_GEOMETRY: Readonly<
  Record<DitherTexture, { pitch: number; square: number }>
> = {
  pixels: { pitch: 2, square: 2 },
  dots: { pitch: 3, square: 1 },
};

/** Whether a value is a Promise or another thenable: an action that is still working. */
export const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

/**
 * What a CheckboxGroup or a RadioGroup hands the rows inside it: the id of the Field round the
 * group ("" when it stands in none), and null outside a group. A horizontal Field inside a group is
 * one of its rows (field.tsx); a box or a circle tells its row's wiring from the group's Field's by
 * this id.
 */
export const ChoiceGroupContext = createContext<string | null>(null);

/** The wiring of the Field round a checkbox or a radio, as field.tsx's useFieldControl hands it. */
interface ChoiceFieldWiring {
  id?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  disabled?: boolean;
}

/**
 * A grouped row's wiring, handed to its box or circle by hand, with only what the row set; and
 * whether the row is out of use. Nothing outside a group, nor from the group's own Field, which
 * names the group and not the box.
 */
export const rowWiring = (
  group: string | null,
  field: ChoiceFieldWiring | null
) => {
  if (group === null || field === null || field.id === group) {
    return { props: {}, disabled: undefined };
  }
  return {
    props: Object.fromEntries(
      Object.entries({
        id: field.id,
        "aria-labelledby": field["aria-labelledby"],
        "aria-describedby": field["aria-describedby"],
        "aria-invalid": field["aria-invalid"],
      }).filter(([, value]) => value !== undefined)
    ),
    disabled: field.disabled,
  };
};
