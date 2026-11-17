// ThemeProvider: puts a person's mode and theme on the page, or on one part of it. The choice comes
// in as props and changes go out through callbacks: where it is kept is the product's (storage.ts
// is a small helper for localStorage). While a value is still undefined (being read), the page
// keeps what the pre-paint script (script.ts) set, so nothing flashes.
//
//   const stored = useStoredTheme();
//   <ThemeProvider mode={stored.mode} theme={stored.theme} onModeChange={stored.setMode} onThemeChange={stored.setTheme}>
//     <App />
//   </ThemeProvider>
//
// `scope="page"` (the default) writes `data-grasp-mode` and `data-grasp-theme` on <html>;
// `scope="subtree"` draws its own element with them, so a part of a page can be night while the
// rest is day. `accent` sets a product's own main-action colour (accent.ts) on the same element.
"use client";

import * as stylex from "@stylexjs/stylex";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { grasp } from "../tokens/tokens.stylex";
import { accentRamp } from "./accent";
import { changeTheme } from "./change";
import type { ThemeChange, ThemeChangeOrigin } from "./change";
import type { ThemeId, ThemeMode } from "./themes";

/** Every prop a ThemeProvider takes. */
export interface ThemeProviderProps {
  /** The person's mode. Leave it undefined while it is being read: the page keeps what it has. */
  mode: ThemeMode | undefined;
  /** The person's theme. Leave it undefined while it is being read. */
  theme: ThemeId | undefined;
  /** A person chose a mode: keep it, and pass it back as `mode`. */
  onModeChange?: (mode: ThemeMode) => void;
  /** A person chose a theme: keep it, and pass it back as `theme`. */
  onThemeChange?: (theme: ThemeId) => void;
  /**
   * How a person's own change is drawn: a circle growing from the switch, a crossfade, or one
   * frame. Any other change (loading, the system's setting, a subtree) is always one frame.
   * @default "reveal"
   */
  change?: ThemeChange;
  /** A product's own main-action colour, one `oklch()` value; see `checkAccent` for its contrast. */
  accent?: string;
  /**
   * `page` puts the theme on <html>; `subtree` on an element of its own around its children.
   * @default "page"
   */
  scope?: "page" | "subtree";
  /**
   * With `scope="subtree"`: paint the theme's own ground (paper, its words' colour) under what it
   * holds, with a little room round it. Use it wherever the subtree's mode differs from the page's,
   * so dark words never stand on a light page or the other way round.
   * @default false
   */
  ground?: boolean;
  /** What the theme holds. */
  children: ReactNode;
}

/** What a Theme switch reads and calls. */
export interface ThemeControls {
  /** The person's mode; undefined while it is being read, or outside a provider. */
  mode: ThemeMode | undefined;
  /** The person's theme; undefined while it is being read, or outside a provider. */
  theme: ThemeId | undefined;
  /** The theme being shown: a preview while there is one, the chosen theme otherwise. */
  shown: ThemeId | undefined;
  /**
   * A mode was chosen, from a control whose centre is `origin`. `way` overrides the provider's
   * `change` for this one: an agent's change, which is not the person's own, is `instant`.
   */
  chooseMode: (
    mode: ThemeMode,
    origin?: ThemeChangeOrigin,
    way?: ThemeChange
  ) => void;
  /** A theme was chosen; as `chooseMode`. */
  chooseTheme: (
    theme: ThemeId,
    origin?: ThemeChangeOrigin,
    way?: ThemeChange
  ) => void;
  /** Shows a theme for a moment; called with nothing, puts the chosen one back. */
  showPreview: (theme?: ThemeId) => void;
}

const ignore = () => {
  // Outside a provider a switch shows what it is given and changes nothing.
};

const outside: ThemeControls = {
  mode: undefined,
  theme: undefined,
  shown: undefined,
  chooseMode: ignore,
  chooseTheme: ignore,
  showPreview: ignore,
};

// The provider passes only values it does not build: its props, its state's setter and its own
// element's ref, each in a context of its own; useTheme builds the controls from them.
const ModeContext = createContext<ThemeMode | undefined>(undefined);
const ThemeIdContext = createContext<ThemeId | undefined>(undefined);
const PreviewContext = createContext<ThemeId | undefined>(undefined);
const SetPreviewContext = createContext<
  ((theme: ThemeId | undefined) => void) | undefined
>(undefined);
const OnModeContext = createContext<((mode: ThemeMode) => void) | undefined>(
  undefined
);
const OnThemeContext = createContext<((theme: ThemeId) => void) | undefined>(
  undefined
);
const ChangeContext = createContext<ThemeChange>("reveal");
const TargetContext = createContext<
  RefObject<HTMLDivElement | null> | undefined
>(undefined);

const styles = stylex.create({
  // The subtree's own element draws nothing: its children lay out as if it were not there, and
  // still inherit its color-scheme and its theme's tokens.
  subtree: { display: "contents" },
  // A subtree on its own ground: the tokens resolve on this element, so it paints its own theme's
  // paper and words, whatever the page's mode.
  ground: {
    display: "inline-grid",
    placeItems: "center",
    padding: grasp.space3,
    backgroundColor: grasp.paper,
    color: grasp.text,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
  },
});

/** Writes the attributes the CSS reads, at once. */
const applyTheme = (
  element: HTMLElement,
  mode: ThemeMode | undefined,
  theme: ThemeId | undefined
) => {
  if (mode !== undefined && element.dataset.graspMode !== mode) {
    element.dataset.graspMode = mode;
  }
  if (theme !== undefined && element.dataset.graspTheme !== theme) {
    element.dataset.graspTheme = theme;
  }
};

/** Sets an accent's ramp on an element; the returned function takes it off. */
const setAccent = (element: HTMLElement, accent: string | undefined) => {
  const ramp = accent === undefined ? undefined : accentRamp(accent);
  const properties = ramp?.properties ?? {};
  for (const [property, value] of Object.entries(properties)) {
    element.style.setProperty(property, value);
  }
  return () => {
    for (const property of Object.keys(properties)) {
      element.style.removeProperty(property);
    }
  };
};

export const ThemeProvider = ({
  mode,
  theme,
  onModeChange,
  onThemeChange,
  change = "reveal",
  accent,
  scope = "page",
  ground = false,
  children,
}: ThemeProviderProps) => {
  const [preview, setPreview] = useState<ThemeId | undefined>();
  const own = useRef<HTMLDivElement>(null);

  // The props onto the target; a preview stands over the chosen theme until the pointer leaves.
  useEffect(() => {
    const element = scope === "page" ? document.documentElement : own.current;
    if (element !== null) {
      applyTheme(element, mode, preview ?? theme);
    }
  }, [mode, theme, preview, scope]);

  useEffect(() => {
    const element = scope === "page" ? document.documentElement : own.current;
    return element === null ? ignore : setAccent(element, accent);
  }, [accent, scope]);

  const holder = (
    <TargetContext.Provider value={own}>
      <ChangeContext.Provider value={change}>
        <OnModeContext.Provider value={onModeChange}>
          <OnThemeContext.Provider value={onThemeChange}>
            <ModeContext.Provider value={mode}>
              <ThemeIdContext.Provider value={theme}>
                <SetPreviewContext.Provider value={setPreview}>
                  <PreviewContext.Provider value={preview}>
                    {children}
                  </PreviewContext.Provider>
                </SetPreviewContext.Provider>
              </ThemeIdContext.Provider>
            </ModeContext.Provider>
          </OnThemeContext.Provider>
        </OnModeContext.Provider>
      </ChangeContext.Provider>
    </TargetContext.Provider>
  );
  if (scope === "page") {
    return holder;
  }
  return (
    <div
      ref={own}
      data-grasp-mode={mode}
      data-grasp-theme={preview ?? theme}
      {...stylex.props(ground ? styles.ground : styles.subtree)}
    >
      {holder}
    </div>
  );
};

/**
 * A person's own change: the attributes are written inside the change (a View Transition needs the
 * new look before its callback returns), then the owner is told, and its props catch up. The
 * target is the provider's own element for a subtree, <html> for the page.
 */
const choose = (
  target: RefObject<HTMLDivElement | null> | undefined,
  change: ThemeChange,
  next: { mode: ThemeMode | undefined; theme: ThemeId | undefined },
  origin: ThemeChangeOrigin | undefined
) => {
  const element = target?.current ?? document.documentElement;
  changeTheme(
    change,
    () => {
      applyTheme(element, next.mode, next.theme);
    },
    origin
  );
};

/** The theme of the nearest ThemeProvider, and how to change it. Outside one, nothing changes. */
export const useTheme = (): ThemeControls => {
  const target = useContext(TargetContext);
  const change = useContext(ChangeContext);
  const onMode = useContext(OnModeContext);
  const onTheme = useContext(OnThemeContext);
  const mode = useContext(ModeContext);
  const theme = useContext(ThemeIdContext);
  const preview = useContext(PreviewContext);
  const setPreview = useContext(SetPreviewContext);
  if (target === undefined) {
    return outside;
  }
  return {
    mode,
    theme,
    shown: preview ?? theme,
    chooseMode: (nextMode, origin, way) => {
      choose(target, way ?? change, { mode: nextMode, theme }, origin);
      setPreview?.(undefined);
      onMode?.(nextMode);
    },
    chooseTheme: (nextTheme, origin, way) => {
      choose(target, way ?? change, { mode, theme: nextTheme }, origin);
      setPreview?.(undefined);
      onTheme?.(nextTheme);
    },
    showPreview: (next) => {
      setPreview?.(next);
    },
  };
};
