import { describe, expect, it } from "vite-plus/test";

import { svgRefusal } from "./svg.ts";

// The SVG check on its own, tried with every way to get a reference out of
// an SVG we could think of (the probe a review asked for, kept as tests).
// Each was refused or taken as listed; eight got through the earlier
// denylist (`style` with `\\75 rl(`, `image-set`, `-webkit-image-set`,
// comments splitting `url(` and `@import`, CSS comments inside `url`, a
// CSS-escaped `@import`, and an external DOCTYPE), which is why this is now
// an allowlist.

const svg = (inner: string, head = ""): Uint8Array =>
  new TextEncoder().encode(
    `${head}<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:foo="http://www.w3.org/1999/xlink">${inner}</svg>`
  );

const refusalOf = (inner: string, head = ""): string =>
  svgRefusal(svg(inner, head)) ?? "taken";

describe("an SVG's references", () => {
  it("is refused for every way to load from outside it", () => {
    const probes: Record<string, [string, string?]> = {
      feImage: [
        '<filter id="f"><feImage href="https://x.example/a.png"/></filter>',
      ],
      anchor: ['<a href="https://x.example/"><text>x</text></a>'],
      spacedEquals: ['<image href = "https://x.example/a.png"/>'],
      singleQuoted: ["<image href='https://x.example/a.png'/>"],
      entityScheme: ['<image href="&#104;ttps://x.example/a.png"/>'],
      entitySlashes: ['<image href="&#47;&#47;x.example/a.png"/>'],
      upperCase: ['<image HREF="https://x.example/a.png"/>'],
      anyPrefix: ['<image foo:href="https://x.example/a.png"/>'],
      srcAnywhere: ['<rect src="https://x.example/a.png"/>'],
      escapedUrl: ['<rect style="fill:\\75 rl(https://x.example/a)"/>'],
      imageSet: [
        '<style>rect{fill:image-set("https://x.example/a.png" 1x)}</style>',
      ],
      webkitImageSet: [
        "<style>rect{fill:-webkit-image-set('//x.example/a.png' 1x)}</style>",
      ],
      importString: ['<style>@import "https://x.example/a.css";</style>'],
      cdata: ["<style><![CDATA[rect{fill:url(https://x.example/a)}]]></style>"],
      xmlCommentSplit: [
        "<style>rect{fill:u<!-- x -->rl(https://x.example/a)}</style>",
      ],
      xmlCommentImport: [
        '<style>@im<!-- -->port "https://x.example/a.css";</style>',
      ],
      cssCommentSplit: [
        "<style>rect{fill:u/**/rl(https://x.example/a)}</style>",
      ],
      cssEscapedImport: [
        '<style>@\\69mport "https://x.example/a.css";</style>',
      ],
      presentationAttribute: ['<rect fill="url(https://x.example/p.svg#g)"/>'],
      xmlBase: ['<g xml:base="https://x.example/"><image href="#a"/></g>'],
      otherDocument: ['<use href="other.svg#x"/>'],
      relative: ['<image href="sprite.png"/>'],
      stylesheet: [
        "<rect/>",
        '<?xml-stylesheet href="https://x.example/a.css"?>',
      ],
    };
    const outcomes = Object.fromEntries(
      Object.entries(probes).map(([name, [inner, head]]) => [
        name,
        refusalOf(inner, head),
      ])
    );
    expect(outcomes).toStrictEqual(
      Object.fromEntries(
        Object.keys(probes).map((name) => [
          name,
          "is an SVG that loads something from outside itself",
        ])
      )
    );
  });

  it("is refused for markup it can't read as plain SVG", () => {
    expect([
      refusalOf("<image href=https://x.example/a.png />"),
      refusalOf("<rect/>", '<!DOCTYPE svg SYSTEM "https://x.example/x.dtd">'),
      refusalOf('<rect fill="&ext;"/>'),
      refusalOf("<foreignObject><div/></foreignObject>"),
      refusalOf("<x:script>alert(1)</x:script>"),
      refusalOf("<animate attributeName='href' to='https://x.example'/>"),
    ]).toStrictEqual([
      "is an SVG Grasp can't read",
      "is an SVG that declares its own entities or document type",
      "is an SVG Grasp can't read",
      "is an SVG with an element that can run or embed something",
      "is an SVG with an element that can run or embed something",
      "is an SVG with an element that isn't drawing: animate",
    ]);
  });

  it("takes references within itself, inline images and plain drawing", () => {
    expect([
      refusalOf('<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/>'),
      refusalOf(
        '<use href="#icon"/><symbol id="icon"><path d="M0 0"/></symbol>'
      ),
      refusalOf('<image href="data:image/png;base64,iVBORw0KGgo="/>'),
      refusalOf("<style><![CDATA[rect{fill:url(#g)}]]></style><!-- note -->"),
      refusalOf("<text>Q&amp;A &lt;1&gt;</text>", '<?xml version="1.0"?>'),
    ]).toStrictEqual(["taken", "taken", "taken", "taken", "taken"]);
  });
});
