/**
 * oxc's React transform, oxlint, oxfmt and oxc's parser, as oxc.wasm
 * (oxc-wasm/src/lib.rs) runs them: an instance kept for the calls after
 * its first, through WASI with no files, environment or preopens
 * (@tybys/wasm-util, the WASI napi-rs loads oxc's own WebAssembly with):
 * nothing they do with App code reads a file.
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

/**
 * `transform`'s answer (oxc-wasm/src/transform.rs `Transformed`): every
 * place a 1-based line and a 1-based column in UTF-16 code units.
 */
const transformedSchema = z.strictObject({
  /** Null when it failed: `errors` say why. */
  code: z.string().nullable(),
  /** Its source map, as a `data:` URL, when `sourceMap` asked for one. */
  map: z.string().optional(),
  /** Whether it parsed: when not, nothing past its first error is known. */
  parsed: z.boolean(),
  errors: z.array(
    z.strictObject({
      message: z.string(),
      help: z.string().optional(),
      line: z.number().optional(),
      column: z.number().optional(),
    })
  ),
  /**
   * Every module the source names (imports.ts `ImportSite`): its imports
   * and exports from other modules, `import()`, a type's `import("…")`,
   * and ambient modules (`declare module "…"`, `declare global`).
   */
  sites: z.array(
    z.strictObject({
      specifier: z.string().nullable(),
      line: z.number(),
      names: z.array(z.string()).nullable(),
      typeOnly: z.literal(true).optional(),
      ambient: z.literal(true).optional(),
    })
  ),
  /** Its comments: whether each is a line comment, and its text between its markers. */
  comments: z.array(
    z.strictObject({
      lineComment: z.boolean(),
      value: z.string(),
      line: z.number(),
      column: z.number(),
    })
  ),
});

export type Transformed = z.infer<typeof transformedSchema>;

/** How `transform` transforms a file. */
export interface TransformConfig {
  /**
   * React code: the React Compiler (React 19, every error fails the
   * file), then types removed and JSX turned into calls to
   * `react/jsx-runtime`. Otherwise types are removed, nothing else.
   */
  react: boolean;
  /**
   * The React Compiler's opt-out directives (`"use no memo"`) honoured
   * rather than refused: the kit's own files alone.
   */
  optOuts: boolean;
  /** React Fast Refresh's instrumentation, calling these names. */
  refresh: { register: string; signature: string } | null;
  /** Without the whitespace a reader needs. */
  minify: boolean;
  /** With a source map of the code (`Transformed.map`). */
  sourceMap: boolean;
}

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
  transform: call,
});

/** oxc's parser and transform, which need no config. */
export interface OxcSyntax {
  /**
   * `source` (`path`, which picks the language) parsed by oxc's parser:
   * JSON of TS-ESTree's program and its comments, with ESLint's tokens
   * when `tokens` asks for them, every offset in UTF-16 code units, or of
   * why it doesn't parse (oxc-wasm/src/lib.rs `parse`). Throws if
   * oxc.wasm can't parse it, even in a fresh instance.
   */
  parse: (path: string, source: string, tokens?: boolean) => string;
  /**
   * `source` (`path`, which picks the language) transformed as `config`
   * says, with the modules it names and its comments. Throws if oxc.wasm
   * can't transform it, even in a fresh instance.
   */
  transform: (
    path: string,
    source: string,
    config: TransformConfig
  ) => Transformed;
}

/** What a configured instance adds: oxlint and oxfmt. */
export interface Oxc extends OxcSyntax {
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
}

/** oxlint's and oxfmt's config: an `.oxlintrc.json` with no `extends`, and oxfmt's. */
export interface OxcConfig {
  lint: unknown;
  format: unknown;
}

/**
 * The memory past which an instance is dropped after its call, so the
 * next starts fresh: WebAssembly's memory never shrinks, and an instance
 * kept warm would hold its largest file's for the isolate's life. Half
 * of the 64 MiB build.sh lets it grow to.
 */
const recycledBytes = 32 * 1024 * 1024;

/** An instance of oxc.wasm. */
interface Instance extends Oxc {
  /** How much memory it holds now. */
  bytes: () => number;
}

/** oxc.wasm's `module`, instantiated, and configured with `config` if given. */
const started = (
  module: WebAssembly.Module,
  config: OxcConfig | undefined
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
  if (config !== undefined) {
    const refused = wasm.configure(
      ...put(JSON.stringify(config.lint)),
      ...put(JSON.stringify(config.format))
    );
    if (refused < 0) {
      throw new Error(`oxc.wasm refused its config: ${out(-refused)}`);
    }
  }
  return {
    bytes: () => wasm.memory.buffer.byteLength,
    lint: (path, source) =>
      lintedSchema.parse(
        JSON.parse(out(wasm.lint(...put(path), ...put(source))))
      ),
    tidy: (path, source) => out(wasm.tidy(...put(path), ...put(source))),
    parse: (path, source, tokens = false) =>
      out(wasm.parse(...put(path), ...put(source), tokens ? 1 : 0)),
    transform: (path, source, transformConfig) =>
      transformedSchema.parse(
        JSON.parse(
          out(
            wasm.transform(
              ...put(path),
              ...put(source),
              ...put(JSON.stringify(transformConfig))
            )
          )
        )
      ),
  };
};

/**
 * oxc.wasm's `module`, configured with `config` when there is one (for
 * `lint` and `tidy`): an instance kept for the calls after it.
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
export function oxcOf(module: WebAssembly.Module): OxcSyntax;
export function oxcOf(module: WebAssembly.Module, config: OxcConfig): Oxc;
export function oxcOf(module: WebAssembly.Module, config?: OxcConfig): Oxc {
  let kept: Instance | undefined;
  const run = <T>(answer: (instance: Instance) => T): T => {
    const fresh = kept === undefined;
    const instance = kept ?? started(module, config);
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
    parse: (path, source, tokens) =>
      run((instance) => instance.parse(path, source, tokens)),
    transform: (path, source, transformConfig) =>
      run((instance) => instance.transform(path, source, transformConfig)),
  };
}

let syntax: OxcSyntax | undefined;

/**
 * Starts oxc's parser and transform on oxc.wasm's `module`, once per
 * isolate or process: the compiler's isolate as it loads (worker.ts),
 * the kit's build and the tests in Node (oxc-wasm/wasm.ts).
 */
export const startOxc = (module: WebAssembly.Module): void => {
  syntax ??= oxcOf(module);
};

/** oxc's parser and transform, once `startOxc` started them. */
export const oxc = (): OxcSyntax => {
  if (syntax === undefined) {
    throw new Error("oxc hasn't started (startOxc)");
  }
  return syntax;
};
