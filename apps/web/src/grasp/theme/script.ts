// The pre-paint script: a few lines a product puts in its <head>, before any stylesheet that draws,
// so the page opens in the person's mode and theme with no flash of the wrong one. It reads the
// choice the storage helper (storage.ts) keeps, and sets `data-grasp-mode` and `data-grasp-theme`
// on <html>. If storage cannot be read, or holds something else, it sets the defaults. Without
// script nothing sets them, and themes.css lets the system's setting win.
//
//   <script dangerouslySetInnerHTML={{ __html: themeScript() }} />          React, in the <head>
//   <script is:inline set:html={themeScript()} />                           Astro
import { themeIds, themeModes } from "./themes";
import type { ThemeId, ThemeMode } from "./themes";

/** The key the choice is kept under, unless a product names its own. */
export const themeStorageKey = "grasp-theme";

export interface ThemeScriptOptions {
  /**
   * Where the choice is kept in localStorage.
   * @default "grasp-theme"
   */
  storageKey?: string;
  /**
   * The mode before a person has chosen one.
   * @default "system"
   */
  mode?: ThemeMode;
  /**
   * The theme before a person has chosen one.
   * @default "evergreen"
   */
  theme?: ThemeId;
}

/** The script's source, ready for a <script> in the <head>. Plain ES5, no module, under 500 bytes. */
export const themeScript = (options?: ThemeScriptOptions): string => {
  const key = JSON.stringify(options?.storageKey ?? themeStorageKey);
  const mode = JSON.stringify(options?.mode ?? "system");
  const theme = JSON.stringify(options?.theme ?? "evergreen");
  return [
    "(function(){",
    "var d=document.documentElement,s=null;",
    `try{s=JSON.parse(localStorage.getItem(${key})||"null")}catch(e){}`,
    `var m=s&&${JSON.stringify(themeModes)}.indexOf(s.mode)>-1?s.mode:${mode};`,
    `var t=s&&${JSON.stringify(themeIds)}.indexOf(s.theme)>-1?s.theme:${theme};`,
    "d.setAttribute('data-grasp-mode',m);d.setAttribute('data-grasp-theme',t);",
    "})();",
  ].join("");
};
