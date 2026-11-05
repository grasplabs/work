import { describe, expect, it } from "vite-plus/test";

import { cssWithQuery } from "./css.ts";

// A package artifact's stylesheet as core serves it: each URL of the
// artifact's own that it fetches carries the address's query, which holds
// its token. What can go wrong: a URL of its own left without the token
// (the file it fetches is refused), text that only looks like a URL
// changed, or the token handed to a URL outside the artifact (`../` up
// into another artifact or another route of core's).

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
      `.a{background:url(./assets/mark-CD34.svg${query}),url(assets/photo-EF56.png${query})}`,
      '.b::after{content:"./assets/mark-CD34.svg"}',
      "/* url(./assets/in-a-comment.png) */",
      ".c{background:url(https://elsewhere.example/x.png),url(data:image/png;base64,AA==),url(/rooted.png),url(var(--x))}",
    ]);
  });

  it("carries the query only on URLs that resolve inside the artifact's directory", () => {
    const css = [
      "a { background: url(../../../../../api/rpc); }",
      "b { background: url(../other-artifact-hash/file.png); }",
      'c { background: url("../../../../../screen-modules/kit/x.js"); }',
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

  it("leaves a stylesheet that fetches nothing of its own as it is, byte for byte", () => {
    const css = '.a{color:red}\r\n.b{content:"\0"}';
    expect(cssWithQuery(css, query, "main.css")).toBe(css);
  });
});
