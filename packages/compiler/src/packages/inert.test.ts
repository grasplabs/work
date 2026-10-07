import { describe, expect, it } from "vite-plus/test";

import { remoteInCss, svgRefusal } from "./inert.ts";

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
      '<rect/onfocus="x()"/>',
    ];
    expect(
      new Set(handlers.map((handler) => svgRefusal(utf8(svg(handler)))))
    ).toStrictEqual(new Set(["is an SVG with an event handler"]));
  });

  it("is refused for a link to script, however it is encoded", () => {
    const links = [
      '<a href="javascript:alert(1)"><text>x</text></a>',
      '<a href="jav&#x61;script:alert(1)"><text>x</text></a>',
      '<a href="jav&#97;script&colon;alert(1)"><text>x</text></a>',
      '<a href="java\tscript:alert(1)"><text>x</text></a>',
      '<a href="data:text/html,&lt;b&gt;"><text>x</text></a>',
    ];
    expect(
      new Set(links.map((link) => svgRefusal(utf8(svg(link)))))
    ).toStrictEqual(new Set(["is an SVG that links to script"]));
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
      "is an SVG that declares its own entities",
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
});
