// Where the view's state lives, so a link reopens exactly that view: the row it is at, the zoom
// and the search. One small adapter; the default keeps it in the query string, under the viewer's
// own prefix, and a product can pass its own router's instead.

/** What a link remembers of a view. */
export interface ViewState {
  /** The row at the top: a line, a block, a page or a table row, counted from 1. */
  at?: number;
  /** The zoom, as a percentage, or "fit". */
  zoom?: number | "fit";
  /** The search. */
  find?: string;
  /** For a file that has a preview (HTML, Markdown): its source instead. */
  mode?: "preview" | "code";
  /** The comment thread open, by its id. */
  comment?: string;
  /** A place in the file, shared by a link: an anchor, encoded short (see anchor.ts). */
  anchor?: string;
}

/** Reads and writes the view's state. */
export interface ViewerLocation {
  read: () => ViewState;
  /** `replace` while scrolling; `push` on a deliberate jump, so Back returns. */
  write: (state: ViewState, how: "replace" | "push") => void;
  /** Runs when the state changes from outside: Back, Forward, a link. Returns a stop. */
  listen: (change: () => void) => () => void;
}

/** The id of a viewer's box in the page, which a link's hash names: `artifact-<prefix>`. */
export const viewerHash = (prefix: string) => `artifact-${prefix}`;

/** A value worth keeping in the link: an empty one is left out. */
const kept = (value: string | null | undefined) =>
  value === null || value === undefined || value === "" ? undefined : value;

/**
 * The view's state in the query string: `?<prefix>-at=120&<prefix>-zoom=150&<prefix>-find=word`,
 * `<prefix>-mode=code` when a page's source shows instead of its preview, `<prefix>-comment=<id>`
 * for the open comment and `<prefix>-anchor=t.120.164` for a place a link points at.
 */
export const queryLocation = (prefix = "view"): ViewerLocation => {
  const key = (name: string) => `${prefix}-${name}`;
  return {
    read() {
      if (typeof window === "undefined") {
        return {};
      }
      const params = new URLSearchParams(window.location.search);
      const at = Number(params.get(key("at")));
      const zoomText = params.get(key("zoom"));
      const zoom = zoomText === "fit" ? "fit" : Number(zoomText);
      const find = kept(params.get(key("find")));
      const mode = params.get(key("mode"));
      const comment = kept(params.get(key("comment")));
      const anchor = kept(params.get(key("anchor")));
      return {
        ...(comment === undefined ? {} : { comment }),
        ...(anchor === undefined ? {} : { anchor }),
        ...(mode === "code" ? { mode: "code" as const } : {}),
        ...(Number.isFinite(at) && at > 0 ? { at } : {}),
        ...(zoom === "fit" || (Number.isFinite(zoom) && zoom > 0)
          ? { zoom }
          : {}),
        ...(find === undefined ? {} : { find }),
      };
    },
    write(state, how) {
      const url = new URL(window.location.href);
      const set = (name: string, value: string | undefined) => {
        if (value === undefined) {
          url.searchParams.delete(key(name));
        } else {
          url.searchParams.set(key(name), value);
        }
      };
      set(
        "at",
        state.at !== undefined && state.at > 1 ? String(state.at) : undefined
      );
      // Fit is where every viewer starts: a link need not say so.
      set(
        "zoom",
        typeof state.zoom === "number" &&
          state.zoom !== 0 &&
          !Number.isNaN(state.zoom)
          ? String(state.zoom)
          : undefined
      );
      set("find", kept(state.find));
      // The preview is where a page starts: a link says only "code".
      set("mode", state.mode === "code" ? "code" : undefined);
      set("comment", kept(state.comment));
      set("anchor", kept(state.anchor));
      // A deliberate place (a jump, an open comment, a place to share) names this viewer in the
      // hash as well, so the link, opened fresh, brings the page to the viewer before anything
      // has loaded: the browser scrolls to the viewer's box, which is in the page from the start.
      if (
        how === "push" ||
        (state.anchor !== undefined && state.anchor !== "")
      ) {
        url.hash = viewerHash(prefix);
      }
      if (url.href === window.location.href) {
        return;
      }
      if (how === "push") {
        window.history.pushState(window.history.state, "", url);
      } else {
        window.history.replaceState(window.history.state, "", url);
      }
    },
    listen(change) {
      window.addEventListener("popstate", change);
      return () => {
        window.removeEventListener("popstate", change);
      };
    },
  };
};

/** A view that remembers nothing outside itself: for a viewer whose state belongs in no link. */
export const memoryLocation = (): ViewerLocation => {
  let state: ViewState = {};
  return {
    read: () => state,
    write: (next) => {
      state = next;
    },
    listen: () => () => {
      // Nothing outside it changes it.
    },
  };
};
