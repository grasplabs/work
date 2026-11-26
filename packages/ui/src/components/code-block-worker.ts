// CodeBlock's worker (code-block.tsx starts it): Prism reads a block's code here, off the page
// (why: code-block-prism.ts). Prism 1.30.0, pinned, and every grammar a block can name, loaded
// once with the worker: its core first, which puts `Prism` on the worker's global for the
// language files, and each language after those it builds on.
//
// Prism, loaded in a worker, answers the worker's own messages itself, each read as JSON. So the
// page asks through a port this worker hands it when it is ready, never by a message to the worker.
// oxlint-disable-next-line typescript/triple-slash-reference -- Prism's language files have no types and nothing to import: it brings their declaration to every program this file is in
/// <reference path="./code-block-grammars.d.ts" />
import "prismjs";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-json.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-markdown.js";
import "prismjs/components/prism-yaml.js";
import "prismjs/components/prism-sql.js";
import "prismjs/components/prism-diff.js";
import "prismjs/components/prism-go.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-java.js";
import "prismjs/components/prism-c.js";
import "prismjs/components/prism-cpp.js";
import "prismjs/components/prism-csharp.js";
import "prismjs/components/prism-markup-templating.js";
import "prismjs/components/prism-php.js";
import "prismjs/components/prism-ruby.js";
import "prismjs/components/prism-kotlin.js";
import "prismjs/components/prism-swift.js";
import "prismjs/components/prism-toml.js";
import "prismjs/components/prism-docker.js";
import { isPrism, runsOf } from "./code-block-prism";

const Prism: unknown = Reflect.get(globalThis, "Prism");

/** The runs for what the page asked, `{ code, grammar }`; none when Prism fails on it. */
const read = (asked: unknown) => {
  if (
    !isPrism(Prism) ||
    typeof asked !== "object" ||
    asked === null ||
    !("code" in asked) ||
    !("grammar" in asked)
  ) {
    return null;
  }
  const { code, grammar } = asked;
  try {
    return typeof code === "string" && typeof grammar === "string"
      ? runsOf(Prism, code, grammar)
      : null;
  } catch {
    return null;
  }
};

const { port1, port2 } = new MessageChannel();
port1.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
  // The page counts Prism's time from this word.
  port1.postMessage("reading");
  const runs = read(data);
  port1.postMessage(runs, runs ? [runs.ends.buffer, runs.kinds.buffer] : []);
});
port1.start();
postMessage(null, { transfer: [port2] });
