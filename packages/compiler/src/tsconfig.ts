/**
 * A type check's compiler options as a `tsconfig.json` writes them, so a
 * project outside Grasp (scripts/package-definition-lib.ts) checks App
 * code with the very options the platform does (type-check.ts).
 */
import ts from "typescript";

/** Each enum option's values as a tsconfig names them. */
const enumNames: Readonly<Record<string, ReadonlyMap<number, string>>> = {
  target: new Map([
    [ts.ScriptTarget.ES2022, "es2022"],
    [ts.ScriptTarget.ES2024, "es2024"],
    [ts.ScriptTarget.ESNext, "esnext"],
  ]),
  module: new Map([
    [ts.ModuleKind.ESNext, "esnext"],
    [ts.ModuleKind.Preserve, "preserve"],
  ]),
  moduleResolution: new Map([[ts.ModuleResolutionKind.Bundler, "bundler"]]),
  moduleDetection: new Map([[ts.ModuleDetectionKind.Force, "force"]]),
  jsx: new Map([
    [ts.JsxEmit.ReactJSX, "react-jsx"],
    [ts.JsxEmit.Preserve, "preserve"],
  ]),
};

/** A lib's file (`lib.es2024.d.ts`), as a tsconfig names it (`es2024`). */
const libFile = /^lib\.(?<name>.+)\.d\.ts$/u;

/** `value` with its object keys sorted, to compare two option sets. */
const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => sorted(item));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .toSorted(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, item]) => [key, sorted(item)])
    );
  }
  return value;
};

/** One option's value as a tsconfig writes it. */
const jsonValue = (key: string, value: unknown): unknown => {
  const names = enumNames[key];
  if (names !== undefined) {
    const name = typeof value === "number" ? names.get(value) : undefined;
    if (name === undefined) {
      throw new Error(`${key}: no tsconfig name for ${String(value)}.`);
    }
    return name;
  }
  if (key === "lib" && Array.isArray(value)) {
    return value.map((file: unknown) => {
      const name =
        typeof file === "string" ? libFile.exec(file)?.groups?.name : undefined;
      if (name === undefined) {
        throw new Error(`lib: ${String(file)} isn't a lib's file.`);
      }
      return name;
    });
  }
  return value;
};

/**
 * `options` as a tsconfig's `compilerOptions`, with `paths` as written,
 * relative to the tsconfig's directory as they are to the App's root.
 * Throws unless TypeScript reads them back as exactly `options`, so an
 * option this can't write fails here, never as a looser check.
 */
export const tsconfigOptions = (
  options: ts.CompilerOptions
): Record<string, unknown> => {
  const json = Object.fromEntries(
    Object.entries(options)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, jsonValue(key, value)])
  );
  const read = ts.convertCompilerOptionsFromJson(json, "/");
  // TypeScript records where `paths` are relative to; the App's root.
  const { pathsBasePath: _base, ...readOptions } = read.options;
  if (
    read.errors.length > 0 ||
    JSON.stringify(sorted(readOptions)) !== JSON.stringify(sorted(options))
  ) {
    throw new Error("These compiler options don't round-trip as a tsconfig.");
  }
  return json;
};
