/**
 * oxlint and oxfmt, as oxc.wasm (oxc-wasm/src/lib.rs) runs them: one
 * instance, configured once, through WASI with no files, environment or
 * preopens (@tybys/wasm-util, the WASI napi-rs loads oxc's own WebAssembly
 * with): nothing they do with App code reads a file.
 */
import { WASI } from "@tybys/wasm-util";
import { z } from "zod";

/** A finding as oxc.wasm answers it. */
const findingSchema = z.object({
  rule: z.string(),
  severity: z.enum(["error", "warning"]),
  message: z.string(),
  help: z.string().optional(),
  line: z.number(),
  column: z.number(),
});

export type Finding = z.infer<typeof findingSchema>;

/** `lint`'s answer: null when the file doesn't parse. */
const lintedSchema = z.array(findingSchema).nullable();

/** One of oxc.wasm's calls: numbers in (pointers and lengths), a number out. */
const call = z.custom<(...args: number[]) => number>(
  (value) => typeof value === "function"
);

const exportsSchema = z.object({
  memory: z.instanceof(WebAssembly.Memory),
  alloc: call,
  out_ptr: call,
  configure: call,
  lint: call,
  tidy: call,
});

export interface Oxc {
  /** What oxlint says of `source` (`path`); null if it doesn't parse. */
  lint: (path: string, source: string) => Finding[] | null;
  /** `source` (`path`) with what `oxlint --fix` fixes fixed, then formatted by oxfmt. */
  tidy: (path: string, source: string) => string;
}

/**
 * oxc.wasm's `module`, configured with an `.oxlintrc.json` with no
 * `extends` (`lint`) and oxfmt's config (`format`).
 */
export const oxcOf = (
  module: WebAssembly.Module,
  { lint, format }: { lint: unknown; format: unknown }
): Oxc => {
  const wasi = new WASI({ version: "preview1" });
  const instance = new WebAssembly.Instance(module, wasi.getImportObject());
  // Synchronous: oxc.wasm uses no Asyncify, so nothing is awaited.
  void wasi.initialize(instance);
  const wasm = exportsSchema.parse(instance.exports);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const put = (text: string): [number, number] => {
    const bytes = encoder.encode(text);
    const at = wasm.alloc(bytes.length);
    new Uint8Array(wasm.memory.buffer, at, bytes.length).set(bytes);
    return [at, bytes.length];
  };
  const out = (length: number): string =>
    decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.out_ptr(), length));
  const configured = wasm.configure(
    ...put(JSON.stringify(lint)),
    ...put(JSON.stringify(format))
  );
  if (configured < 0) {
    throw new Error(`oxc.wasm refused its config: ${out(-configured)}`);
  }
  return {
    lint: (path, source) =>
      lintedSchema.parse(
        JSON.parse(out(wasm.lint(...put(path), ...put(source))))
      ),
    tidy: (path, source) => out(wasm.tidy(...put(path), ...put(source))),
  };
};
