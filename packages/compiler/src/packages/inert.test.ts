import { describe, expect, it } from "vite-plus/test";

import { computedInCss, remoteInCss, unbundledInCss } from "./inert.ts";
import { svgRefusal } from "./svg.ts";

// The checks on what an artifact carries, on their own: pure, so tested in
// isolation, each with the ways around a naive check (the builds that use
// them are core's test/package-builds.test.ts).

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** `text` as UTF-16 (little-endian) with its byte-order mark. */
const utf16 = (text: string): Uint8Array => {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes.set([0xff, 0xfe]);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0;
    bytes[2 + index * 2] = code % 256;
    bytes[3 + index * 2] = Math.floor(code / 256);
  }
  return bytes;
};

const svg = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/2000/svg">${inner}</svg>`;

describe("an SVG an artifact carries", () => {
  it("is taken when it only draws", () => {
    expect(
      svgRefusal(utf8(svg('<path d="M0 0h10v10z" fill="#0af"/>')))
    ).toBeUndefined();
  });

  it("is refused for elements that run or embed something, under any prefix", () => {
    const elements = [
      "<script>alert(1)</script>",
      "<x:script>alert(1)</x:script>",
      "<SCRIPT>alert(1)</SCRIPT>",
      "<foreignObject><div/></foreignObject>",
      '<x:iframe src="/"/>',
      '<embed src="/"/>',
      '<object data="/"/>',
    ];
    expect(
      new Set(elements.map((element) => svgRefusal(utf8(svg(element)))))
    ).toStrictEqual(
      new Set(["is an SVG with an element that can run or embed something"])
    );
  });

  it("is refused for any event handler attribute", () => {
    const handlers = [
      '<rect onload="x()"/>',
      '<rect x:onclick="x()"/>',
      "<rect\nonmouseover='x()'/>",
      "<rect ONCLICK='x()'/>",
    ];
    expect(
      new Set(handlers.map((handler) => svgRefusal(utf8(svg(handler)))))
    ).toStrictEqual(new Set(["is an SVG with an event handler"]));
    // Markup HTML would read as a handler isn't XML at all.
    expect(svgRefusal(utf8(svg('<rect/onfocus="x()"/>')))).toBe(
      "is an SVG Grasp can't read"
    );
  });

  it("is refused for a link to script, however it is encoded", () => {
    const links = [
      '<a href="javascript:alert(1)"><text>x</text></a>',
      '<a href="jav&#x61;script:alert(1)"><text>x</text></a>',
      '<a href="jav&#97;script&#58;alert(1)"><text>x</text></a>',
      '<a href="java\tscript:alert(1)"><text>x</text></a>',
      '<a href="data:text/html,&lt;b&gt;"><text>x</text></a>',
    ];
    expect(
      new Set(links.map((link) => svgRefusal(utf8(svg(link)))))
    ).toStrictEqual(new Set(["is an SVG that links to script"]));
  });

  it("is refused for anything it would load from outside itself", () => {
    const references = [
      '<image href="https://cdn.example/a.png"/>',
      '<image xlink:href="//cdn.example/a.png"/>',
      '<use href="https://cdn.example/sprite.svg#icon"/>',
      "<style>rect { fill: url(https://cdn.example/p.svg#g); }</style>",
      "<rect style=\"fill: url('http://cdn.example/p')\"/>",
      '<style>@import "https://cdn.example/a.css";</style>',
      '<image href="sprite.png"/>',
    ];
    expect(
      new Set(references.map((reference) => svgRefusal(utf8(svg(reference)))))
    ).toStrictEqual(
      new Set(["is an SVG that loads something from outside itself"])
    );
  });

  it("takes references within itself and inline images", () => {
    const references = [
      '<use href="#icon"/><symbol id="icon"/>',
      '<rect fill="url(#gradient)"/>',
      '<image href="data:image/png;base64,iVBORw0KGgo="/>',
    ];
    expect(
      references.map((reference) => svgRefusal(utf8(svg(reference))))
    ).toStrictEqual([undefined, undefined, undefined]);
  });

  it("is refused when it isn't plain UTF-8, or declares entities", () => {
    expect([
      svgRefusal(utf16(svg("<script>alert(1)</script>"))),
      svgRefusal(utf8(`﻿${svg("<rect/>")}`)),
      svgRefusal(new Uint8Array([0x3c, 0x73, 0xff, 0x3e])),
      svgRefusal(
        utf8(`<!DOCTYPE svg [<!ENTITY s "script">]>${svg("<rect/>")}`)
      ),
    ]).toStrictEqual([
      "is an SVG that isn't plain UTF-8",
      "is an SVG that isn't plain UTF-8",
      "is an SVG that isn't plain UTF-8",
      "is an SVG that declares its own entities or document type",
    ]);
  });
});

describe("a stylesheet an artifact carries", () => {
  it("names every URL that would load from outside the artifact", () => {
    const css = [
      '.a{background:image-set("https://cdn.example/a.png" 1x)}',
      ".b{background:-webkit-image-set('//cdn.example/b.png' 2x)}",
      '@import "https://fonts.example/c.css";',
      ".d{background:url(https://cdn.example/d.png)}",
      '.e{background:url("h\\74tps://cdn.example/e.png")}',
      ".f{background:url(data:image/svg+xml,%3Csvg%3E)}",
    ].join("\n");
    expect(remoteInCss(css).toSorted()).toStrictEqual(
      [
        "https://cdn.example/a.png",
        "//cdn.example/b.png",
        "https://fonts.example/c.css",
        "https://cdn.example/d.png",
        "https://cdn.example/e.png",
        "data:image/svg+xml,%3Csvg%3E",
      ].toSorted()
    );
  });

  it("stops at as many as it reports", () => {
    const css = Array.from(
      { length: 500 },
      (_, index) =>
        `.a${index}{background:url(https://cdn.example/${index}.png)}`
    ).join("");
    expect(remoteInCss(css, 3)).toStrictEqual([
      "https://cdn.example/0.png",
      "https://cdn.example/1.png",
      "https://cdn.example/2.png",
    ]);
  });

  it("names local files image-set() takes as strings, which aren't bundled", () => {
    const css =
      '.p{background:image-set("./photo.png" 1x, url(./assets/x-HASH.png) 2x, "data:image/png;base64,AAAA" 3x)}';
    expect(unbundledInCss(css)).toStrictEqual(["./photo.png"]);
  });

  it("reads image-set() strings in image position only, never a type()", () => {
    expect([
      unbundledInCss(
        '.p{background:image-set(url("./assets/p-HASH.png") type("image/png") 1x)}'
      ),
      unbundledInCss('.p{background:image-set("./photo.png" 1x)}'),
      unbundledInCss(
        ".p{background:-webkit-image-set(url(a.png) 1x, 'b.png' type('image/png') 2x)}"
      ),
    ]).toStrictEqual([[], ["./photo.png"], ["b.png"]]);
  });

  it("leaves what stays within the artifact", () => {
    const css = [
      ".a{background:url(./assets/a-HASH.png)}",
      ".b{mask:url(#clip)}",
      ".c{background:url(data:image/png;base64,iVBORw0KGgo=)}",
      '.d::before{content:"Note: see below"}',
      '.e{font-family:"Inter: Display"}',
    ].join("\n");
    expect(remoteInCss(css)).toStrictEqual([]);
  });

  it("reads CSS as a browser does: escapes name a URL, comments split one", () => {
    const css = [
      ".a{background:\\75 rl(https://cdn.example/a.png)}",
      ".b{background:URL( 'https://cdn.example/b.png' )}",
      '.c{background:image("https://cdn.example/c.png")}',
      '.d{background:cross-fade("https://cdn.example/d.png" 50%, red)}',
      '@font-face{src:src("https://cdn.example/e.woff")}',
      '@import url("https://cdn.example/f.css") supports(display:grid);',
      ".g{background:u/**/rl(https://cdn.example/g.png)}",
    ].join("\n");
    expect(remoteInCss(css).toSorted()).toStrictEqual(
      [
        "https://cdn.example/a.png",
        "https://cdn.example/b.png",
        "https://cdn.example/c.png",
        "https://cdn.example/d.png",
        "https://cdn.example/e.woff",
        "https://cdn.example/f.css",
      ].toSorted()
    );
  });

  it("leaves text that only looks like a URL, where nothing is fetched", () => {
    const css = [
      '.a::before{content:"https://cdn.example/a.png"}',
      ".b{font-family:'//cdn.example/b'}",
      "/* @import 'https://cdn.example/c.css'; url(https://cdn.example/c) */",
      '@namespace svg "https://cdn.example/svg";',
      '.d{grid-template-areas:"https" "x"}',
      '.e{background:image-set(url(./assets/e-HASH.png) type("https://x/y") 1x)}',
      '@supports (content:"url(https://cdn.example/f)"){.f{color:red}}',
    ].join("\n");
    expect([remoteInCss(css), unbundledInCss(css)]).toStrictEqual([[], []]);
  });

  it("names var() and env() in image position, wherever they would give a URL to fetch", () => {
    const fetching = [
      '.a{--photo:"https://cdn.example/a.png";background:image-set(var(--photo) 1x)}',
      ".a2{background:image-set(url(./assets/a-HASH.png) 1x, var(--photo) 2x)}",
      ".a3{background:cross-fade(url(./assets/a-HASH.png) 30%, var(--img) 70%)}",
      ".b{background:-webkit-image-set(env(--b) 1x)}",
      ".c{background:image(var(--c))}",
      ".d{background:cross-fade(var(--d) 50%, red)}",
      "@font-face{src:src(var(--e))}",
      "@import var(--f);",
    ];
    expect(fetching.map((css) => computedInCss(css))).toStrictEqual([
      ["var()"],
      ["var()"],
      ["var()"],
      ["env()"],
      ["var()"],
      ["var()"],
      ["var()"],
      ["var()"],
    ]);
  });

  it("takes var() where nothing is fetched (a resolution, type(), modifier, fallback colour or percentage), and catches a url() in a custom property", () => {
    const css = [
      ".a{color:var(--accent);margin:env(safe-area-inset-top)}",
      ".b{background:image-set(url(./assets/b-HASH.png) type(var(--t)) 1x)}",
      ".c{--photo:url(https://cdn.example/c.png);background:var(--photo)}",
      '.d{background:image-set(url("./assets/d-HASH.png") var(--density))}',
      ".e{background:image(url(./assets/e-HASH.png), var(--fallback))}",
      ".f{background:cross-fade(var(--p) url(./assets/f-HASH.png), red)}",
      '@font-face{src:src("./assets/g-HASH.woff" var(--modifier))}',
      ".h{background:-webkit-image-set(url(./assets/h-HASH.png) var(--x), url(./assets/i-HASH.png) 2x)}",
    ].join("\n");
    expect([computedInCss(css), remoteInCss(css)]).toStrictEqual([
      [],
      ["https://cdn.example/c.png"],
    ]);
  });
});
