import { describe, expect, it } from "vite-plus/test";

import { svgRefusal } from "./svg.ts";

// The SVG check on its own, tried with every way to get a reference out of
// an SVG we could think of (the probe a review asked for, kept as tests).
// Each was refused or taken as listed; eight got through the earlier
// denylist (`style` with `\\75 rl(`, `image-set`, `-webkit-image-set`,
// comments splitting `url(` and `@import`, CSS comments inside `url`, a
// CSS-escaped `@import`, and an external DOCTYPE), which is why this is now
// an allowlist. CSS is read by CSS's own tokenizer, so a comment splits
// what it is in (`u/**/rl(` is no URL), as a browser reads it.

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
      srcFunction: [
        '<style>@font-face{src:src("https://x.example/f.woff")}</style>',
      ],
      crossFade: [
        '<style>rect{fill:cross-fade("https://x.example/a.png" 50%, red)}</style>',
      ],
      customProperty: [
        '<style>rect{--photo:"https://x.example/a.png";fill:image-set(var(--photo) 1x)}</style>',
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

describe("an SVG's text and values, second probe", () => {
  it("is refused for references hidden by character references, quotes, CDATA or nesting", () => {
    const probes: Record<string, string> = {
      decimalAtImport: '<style>&#64;import "https://x.example/a.css";</style>',
      decimalUrl: "<style>rect{fill:&#117;rl(https://x.example/a)}</style>",
      hexUrl: "<style>rect{fill:&#x75;rl(https://x.example/a)}</style>",
      midWordReference:
        "<style>rect{fill:u&#x72;l(https://x.example/a)}</style>",
      ltAdjacent: '<style>&lt;x&gt;@import "https://x.example/a.css";</style>',
      mixedCdata:
        '<style>@im<![CDATA[port "https://x.example/a.css";]]></style>',
      cdataThenText:
        "<style><![CDATA[rect{fill:u]]>rl(https://x.example/a)}</style>",
      nested:
        '<g><svg><style>@import "https://x.example/a.css";</style></svg></g>',
      prefixedStyle:
        '<svg:style xmlns:svg="http://www.w3.org/2000/svg">@import "https://x.example/a.css";</svg:style>',
      styleAttributeEntity:
        '<rect style="fill:&#117;rl(https://x.example/a)"/>',
      styleAttributeImport:
        '<rect style="&#64;import &quot;https://x.example/a.css&quot;"/>',
      presentationEntity: '<rect fill="&#117;rl(https://x.example/a)"/>',
      hrefAfterQuotedGt:
        '<image data-x="a > b" href="https://x.example/a.png"/>',
      hrefAfterQuotedQuote:
        '<image data-x=\'"\' href="https://x.example/a.png"/>',
      hrefEntityColon: '<image href="https&#58;//x.example/a.png"/>',
      hrefEntityHash: '<use href="&#35;a/../https://x.example/b.svg"/>',
      hrefLeadingSpace: '<image href=" https://x.example/a.png"/>',
      hrefTab: '<image href="&#9;https://x.example/a.png"/>',
    };
    const outcomes = Object.fromEntries(
      Object.entries(probes).map(([name, inner]) => [name, refusalOf(inner)])
    );
    // Only the one that stays: `#a/../https://…` is a fragment of this
    // document, whatever it reads like, so nothing is loaded.
    expect(
      Object.entries(outcomes)
        .filter(([, outcome]) => outcome === "taken")
        .map(([name]) => name)
    ).toStrictEqual(["hrefEntityHash"]);
  });

  it("refuses markup no XML parser reads, and takes what one does", () => {
    expect({
      notAComment: refusalOf(
        "<style>@im<!-->port 'https://x.example/a.css';</style>"
      ),
      oddName: refusalOf("<r\u00E9ct/>"),
      bareAmpersandInStyle: refusalOf("<style>a & b {}</style>"),
      unknownEntityInStyle: refusalOf("<style>&commat;import 'x';</style>"),
      quotedGt: refusalOf('<rect data-x="a > b"/>'),
      ltInText: refusalOf("<style>rect::after{content:'&lt;'}</style>"),
    }).toStrictEqual({
      notAComment: "is an SVG Grasp can't read",
      oddName: "is an SVG with an element that isn't drawing: r",
      bareAmpersandInStyle: "is an SVG Grasp can't read",
      unknownEntityInStyle: "is an SVG Grasp can't read",
      quotedGt: "taken",
      ltInText: "taken",
    });
  });
});

describe("an SVG's style sheets, read as CSS", () => {
  it("is refused for any element inside a style sheet, whose text would join it", () => {
    expect({
      group: refusalOf(
        '<style><g>@import "https://x.example/a.css";</g></style>'
      ),
      nestedStyle: refusalOf(
        '<style><style>@import "https://x.example/a.css";</style></style>'
      ),
      emptyElement: refusalOf(
        '<style>@im<rect/>port "https://x.example/a.css";</style>'
      ),
    }).toStrictEqual({
      group: "is an SVG with an element inside a style sheet",
      nestedStyle: "is an SVG with an element inside a style sheet",
      emptyElement: "is an SVG with an element inside a style sheet",
    });
  });

  it("takes text that only looks like a URL, where nothing is fetched", () => {
    expect({
      content: refusalOf(
        '<style>text::after{content:"https://x.example/a"}</style>'
      ),
      commentSplit: refusalOf(
        "<style>rect{fill:u/**/rl(https://x.example/a)}</style>"
      ),
      inComment: refusalOf(
        "<style>/* url(https://x.example/a) @import 'b' */rect{fill:red}</style>"
      ),
      fontFamily: refusalOf(
        "<text font-family=\"'https://x.example/a'\">x</text>"
      ),
      typeString: refusalOf(
        '<style>rect{fill:image-set(url(#g) type("image/png") 1x)}</style>'
      ),
    }).toStrictEqual({
      content: "taken",
      commentSplit: "taken",
      inComment: "taken",
      fontFamily: "taken",
      typeString: "taken",
    });
  });
});
