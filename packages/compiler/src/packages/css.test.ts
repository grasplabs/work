import { describe, expect, it } from "vite-plus/test";

import { cssWithQuery } from "./css.ts";

// A package artifact's stylesheet as core serves it: each URL of the
// artifact's own that it fetches carries the address's query, which holds
// its token. What can go wrong: a URL of its own left without the token
// (the file it fetches is refused), text that only looks like a URL
// changed, the token handed to a URL outside the artifact (`../` up
// into another artifact or another route of core's), or a name a package
// may ship (`image@2x.png`, a space, a percent-escape) left without it.

const query = "?token=1.abc_-";

describe("a stylesheet's own URLs, carrying its query", () => {
  it("carries the query on each URL of the artifact's own it fetches, and nothing else", () => {
    const css = [
      '@import "./base.css";',
      '@font-face{font-family:F;src:url("./assets/face-AB12.woff2") format("woff2")}',
      ".a{background:url(./assets/mark-CD34.svg),url(assets/photo-EF56.png)}",
      '.b::after{content:"./assets/mark-CD34.svg"}',
      "/* url(./assets/in-a-comment.png) */",
      ".c{background:url(https://elsewhere.example/x.png),url(data:image/png;base64,AA==),url(/rooted.png),url(var(--x))}",
    ].join("\n");
    expect(cssWithQuery(css, query, "main.css").split("\n")).toStrictEqual([
      `@import "./base.css${query}";`,
      `@font-face{font-family:F;src:url("./assets/face-AB12.woff2${query}") format("woff2")}`,
      `.a{background:url("./assets/mark-CD34.svg${query}"),url("assets/photo-EF56.png${query}")}`,
      '.b::after{content:"./assets/mark-CD34.svg"}',
      "/* url(./assets/in-a-comment.png) */",
      ".c{background:url(https://elsewhere.example/x.png),url(data:image/png;base64,AA==),url(/rooted.png),url(var(--x))}",
    ]);
  });

  it("carries the query only on URLs that resolve inside the artifact's directory", () => {
    const css = [
      "a { background: url(../../../../../api/rpc); }",
      "b { background: url(../other-artifact-hash/file.png); }",
      'c { background: url("../../../../../page-modules/kit/x.js"); }',
      "d { background: url(./ok.png); }",
      "e { background: url(../x.png); }",
    ].join("\n");
    const carried = (file: string): string[] =>
      cssWithQuery(css, query, file)
        .split("\n")
        .filter((line) => line.includes(query))
        .map((line) => line.slice(0, 1));
    expect({
      atRoot: carried("main.css"),
      // From a stylesheet in a folder, one `../` stays in the artifact.
      inFolder: carried("styles/main.css"),
    }).toStrictEqual({ atRoot: ["d"], inFolder: ["b", "d", "e"] });
  });

  it("carries the query on any name a file of the artifact may have, written as CSS reads it", () => {
    const token = query.slice(1);
    const css = [
      ".a{background:url(./assets/image@2x-AB12.png)}",
      ".b{background:url(./assets/c++-AB12.png)}",
      ".c{background:url(./assets/~tilde-AB12.png)}",
      '.d{src:url("./assets/my font-AB12.woff2")}',
      ".e{background:url(./assets/a%20b-AB12.png)}",
      '.f{background:url("./assets/say \\"hi\\"-AB12.png")}',
      ".g{src:url(./assets/icons-AB12.woff2?#iefix)}",
      ".h{background:url(./assets/sprite-AB12.svg#mark)}",
      ".i{background:url(./assets/v-AB12.png?v=2)}",
      // A fragment of the document the rule is in, which fetches nothing.
      ".j{filter:url(#blur)}",
    ].join("\n");
    expect(cssWithQuery(css, query, "main.css").split("\n")).toStrictEqual([
      `.a{background:url("./assets/image@2x-AB12.png${query}")}`,
      `.b{background:url("./assets/c++-AB12.png${query}")}`,
      `.c{background:url("./assets/~tilde-AB12.png${query}")}`,
      `.d{src:url("./assets/my font-AB12.woff2${query}")}`,
      `.e{background:url("./assets/a%20b-AB12.png${query}")}`,
      `.f{background:url("./assets/say \\"hi\\"-AB12.png${query}")}`,
      `.g{src:url("./assets/icons-AB12.woff2?${token}#iefix")}`,
      `.h{background:url("./assets/sprite-AB12.svg${query}#mark")}`,
      `.i{background:url("./assets/v-AB12.png?v=2&${token}")}`,
      ".j{filter:url(#blur)}",
    ]);
  });

  it("carries no query on a URL a backslash or an encoded dot takes out of the artifact", () => {
    const css = [
      // `\\` is CSS's escape for one backslash, which the URL parser reads
      // as `/` (a lone one would escape the next character).
      "a { background: url(..\\\\..\\\\..\\\\api\\\\rpc); }",
      "b { background: url(%2e%2e/%2e%2e/api/rpc); }",
      "c { background: url(//elsewhere.example/x.png); }",
      'd { background: url("./ok@2x.png"); }',
    ].join("\n");
    expect(
      cssWithQuery(css, query, "main.css")
        .split("\n")
        .filter((line) => line.includes(query))
        .map((line) => line.slice(0, 1))
    ).toStrictEqual(["d"]);
  });

  it("leaves a stylesheet that fetches nothing of its own as it is, byte for byte", () => {
    const css = '.a{color:red}\r\n.b{content:"\0"}';
    expect(cssWithQuery(css, query, "main.css")).toBe(css);
  });
});
