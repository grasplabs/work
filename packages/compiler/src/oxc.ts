/**
 * oxlint, oxfmt and oxc's parser, as oxc.wasm (oxc-wasm/src/lib.rs) runs them: an
 * instance configured once and kept, through WASI with no files,
 * environment or preopens (@tybys/wasm-util, the WASI napi-rs loads oxc's
 * own WebAssembly with): nothing they do with App code reads a file.
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
  parse: call,
});

export interface Oxc {
  /**
   * What oxlint says of `source` (`path`); null if it doesn't parse.
   * Throws if oxc.wasm can't lint it, even in a fresh instance.
   */
  lint: (path: string, source: string) => Finding[] | null;
  /**
   * `source` (`path`) with what `oxlint --fix` fixes fixed, then formatted
   * by oxfmt. Throws if oxc.wasm can't tidy it, even in a fresh instance.
   */
  tidy: (path: string, source: string) => string;
  /**
   * `source` (`path`, which picks the language) parsed by oxc's parser:
   * JSON of TS-ESTree's program, its comments and ESLint's tokens, every
   * offset in UTF-16 code units, or of why it doesn't parse
   * (oxc-wasm/src/lib.rs `parse`). Throws if oxc.wasm can't parse it,
   * even in a fresh instance.
   */
  parse: (path: string, source: string) => string;
}

/**
 * The memory past which an instance is dropped after its call, so the
 * next starts fresh: WebAssembly's memory never shrinks, and an instance
 * kept warm would hold its largest file's for the isolate's life. Half
 * of the 64 MiB build.sh lets it grow to.
 */
const recycledBytes = 32 * 1024 * 1024;

/** An instance of oxc.wasm, configured. */
interface Instance extends Oxc {
  /** How much memory it holds now. */
  bytes: () => number;
}

/** oxc.wasm's `module`, instantiated and configured. */
const configured = (
  module: WebAssembly.Module,
  { lint, format }: { lint: unknown; format: unknown }
): Instance => {
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
  const refused = wasm.configure(
    ...put(JSON.stringify(lint)),
    ...put(JSON.stringify(format))
  );
  if (refused < 0) {
    throw new Error(`oxc.wasm refused its config: ${out(-refused)}`);
  }
  return {
    bytes: () => wasm.memory.buffer.byteLength,
    lint: (path, source) =>
      lintedSchema.parse(
        JSON.parse(out(wasm.lint(...put(path), ...put(source))))
      ),
    tidy: (path, source) => out(wasm.tidy(...put(path), ...put(source))),
    parse: (path, source) => out(wasm.parse(...put(path), ...put(source))),
  };
};

/**
 * oxc.wasm's `module`, configured with an `.oxlintrc.json` with no
 * `extends` (`lint`) and oxfmt's config (`format`): an instance kept for
 * the calls after it.
 *
 * oxc recurses, and has no option that bounds how deep: a file nested
 * deep enough runs out of V8's stack or the Rust stack, and one large
 * enough out of the memory's ceiling (build.sh); a panic aborts. Each
 * traps, and leaves the instance's stack pointer, allocator and cells as
 * they were, so every later call into it would fail too, whoever's file it
 * is. So an instance that threw is never called again: the call is tried
 * once more in a fresh one, so a file never fails for what the one before
 * it left, and throws only if it fails there too.
 */
export const oxcOf = (
  module: WebAssembly.Module,
  config: { lint: unknown; format: unknown }
): Oxc => {
  let kept: Instance | undefined;
  const run = <T>(answer: (instance: Instance) => T): T => {
    const fresh = kept === undefined;
    const instance = kept ?? configured(module, config);
    kept = undefined;
    let answered: T;
    try {
      answered = answer(instance);
    } catch (error) {
      if (fresh) {
        throw error;
      }
      return run(answer);
    }
    if (instance.bytes() <= recycledBytes) {
      kept = instance;
    }
    return answered;
  };
  return {
    lint: (path, source) => run((instance) => instance.lint(path, source)),
    tidy: (path, source) => run((instance) => instance.tidy(path, source)),
    parse: (path, source) => run((instance) => instance.parse(path, source)),
  };
};
