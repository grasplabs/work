import { describe, expect, it } from "vite-plus/test";

import { unscopedInCss } from "./scope.ts";

// The scope check on a package's stylesheet, on its own: pure, so tested
// in isolation (the build that refuses with it is core's
// test/package-builds.test.ts).

describe("a package's stylesheet", () => {
  it("may style its own classes and ids, however its selectors are written", () => {
    const own = [
      ".rdp-day { color: red; }",
      ".react-flow__node, .react-flow__edge:hover { stroke: blue; }",
      "#chart > g text { font-size: 12px; }",
      ".dark .rf-panel button { color: white; }",
      ":where(.calendar) td { padding: 0; }",
      ":is(.lib-a, .lib-b:hover) span { margin: 0; }",
      "@media (min-width: 40rem) { @supports (display: grid) { .grid { display: grid; } } }",
      "@layer base { .lib-root * { box-sizing: border-box; } }",
      "@keyframes spin { from { opacity: 0; } to { opacity: 1; } }",
      "@font-face { font-family: Lib; src: url(./lib.woff2); }",
      "@import './more.css'; .lib { --lib-gap: 4px; }",
      ".lib { & a { color: red; } }",
    ];
    expect(own.flatMap((css) => unscopedInCss(css))).toStrictEqual([]);
  });

  it("may not style the whole screen: the root, the page, every element, or the kit's own controls", () => {
    const css = `*, ::before { box-sizing: border-box; }
html { font-size: 20px; }
body{margin:0}
:root { --primary: red; }
@media (prefers-color-scheme: dark) { button { color: white; } }
[data-slot="button"] { border-radius: 0; }
.dark a { color: pink; }
:not(.lib) p { margin: 0; }
:is(.lib, body) { margin: 0; }
:where(.lib, *) { box-sizing: border-box; }
.ok { color: red; }`;
    expect(unscopedInCss(css)).toStrictEqual([
      "*",
      "::before",
      "html",
      "body",
      ":root",
      "button",
      '[data-slot="button"]',
      ".dark a",
      ":not(.lib) p",
      ":is(.lib, body)",
      ":where(.lib, *)",
    ]);
  });

  it("can't be tricked by comments, escapes or a selector split over lines", () => {
    const css = `/* .lib */ body { color: red; }
.lib/**/ { color: blue; }
\\62 utton { margin: 0; }
h1,
.lib-title { font-weight: 600; }`;
    expect(unscopedInCss(css)).toStrictEqual(["body", "button", "h1"]);
  });

  it("can't be tricked by a closer that doesn't match its opener", () => {
    const css = `:is(] ), body, .lib { margin: 0; }
:is({ ) } ), html, .lib { margin: 0; }
.lib { content: f(}); } button { color: red; }`;
    expect(unscopedInCss(css)).toStrictEqual([
      ":is(] )",
      "body",
      ":is({ ) } )",
      "html",
      "button",
    ]);
  });
});
