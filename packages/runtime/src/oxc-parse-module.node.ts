// oxc-parse.wasm compiled, in Node.js (the seed and the build scripts),
// which imports no WebAssembly module as a Worker does.
import { readFileSync } from "node:fs";

import { z } from "zod";

// WebAssembly's `Module` as Node has it: Node's types, with no DOM's,
// declare its types but not its value.
const { Module } = z
  .object({
    Module: z.custom<new (bytes: Uint8Array) => WebAssembly.Module>(
      (value) => typeof value === "function"
    ),
  })
  .parse(Reflect.get(globalThis, "WebAssembly"));

export default new Module(
  readFileSync(new URL("oxc-parse.wasm", import.meta.url))
);
