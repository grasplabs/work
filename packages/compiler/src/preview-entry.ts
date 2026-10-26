import Babel from "@babel/standalone";

/**
 * A chat's preview as one ES module (spec 19.2.1): the App's modules a
 * screen loads, put together into one entry, which the preview frame
 * evaluates for each update and React Fast Refresh swaps in. The kit's
 * modules stay outside it, imported by their flat names, which the
 * frame's import map resolves to the same modules every update: one
 * React, one SDK client, one Refresh runtime for the whole session.
 *
 * Each App module, already compiled and instrumented for Refresh, becomes
 * a function in the entry's own module table, with its imports and
 * exports made calls and properties (Babel's CommonJS transform) and its
 * dynamic imports resolved in the same table. Nothing is recompiled:
 * assembly only rewrites how modules reach each other, so it is measured
 * on its own, never claimed as a compile of unchanged source.
 */

/** The names the entry's own code uses: none an App module can shadow at its top level. */
const names = {
  kit: "__graspKit",
  table: "__graspModules",
  cache: "__graspLoaded",
  load: "__graspLoad",
} as const;

/** One App module as CommonJS: its body, reaching others through `require`. */
const asCommonJs = (code: string, name: string): string =>
  Babel.transform(code, {
    filename: name,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    compact: true,
    plugins: ["transform-dynamic-import", "transform-modules-commonjs"],
  }).code ?? "";

/**
 * The entry for screen module `entry`: the App's `modules` in its closure
 * (`closure`, by flat name, the entry among them) and the kit modules
 * they import (`kitModules`, by flat name). Its default export is the
 * screen's component. Deterministic: the same modules make the same
 * entry, byte for byte.
 */
export const previewEntry = ({
  entry,
  closure,
  modules,
  kitModules,
}: {
  entry: string;
  closure: readonly string[];
  modules: Readonly<Record<string, string>>;
  kitModules: readonly string[];
}): string => {
  const kit = [...new Set(kitModules)].toSorted();
  const own = [...new Set(closure)].toSorted();
  if (!own.includes(entry)) {
    throw new Error(`The preview's closure doesn't hold its entry, ${entry}.`);
  }
  const imports = kit
    .map((name, index) => `import * as k${index} from ${JSON.stringify(name)};`)
    .join("\n");
  // A kit module as the CommonJS interop reads it: an ES module's
  // namespace, marked as one so its default export is its `default`.
  const kitTable = kit
    .map(
      (name, index) =>
        `${JSON.stringify(name)}: Object.freeze(Object.assign(Object.create(null), k${index}, { __esModule: true }))`
    )
    .join(",\n");
  const table = own
    .map((name) => {
      const code = modules[name];
      if (code === undefined) {
        throw new Error(
          `The preview's closure names ${name}, which is missing.`
        );
      }
      return `${JSON.stringify(name)}: (module, exports, require) => {${asCommonJs(code, name)}\n}`;
    })
    .join(",\n");
  return `${imports}
const ${names.kit} = {
${kitTable}
};
const ${names.table} = {
${table}
};
const ${names.cache} = Object.create(null);
const ${names.load} = (name) => {
  if (Object.hasOwn(${names.kit}, name)) return ${names.kit}[name];
  const loaded = ${names.cache}[name];
  if (loaded !== undefined) return loaded.exports;
  const define = ${names.table}[name];
  if (define === undefined) throw new Error("The preview has no module " + name + ".");
  const module = { exports: {} };
  ${names.cache}[name] = module;
  define(module, module.exports, ${names.load});
  return module.exports;
};
export default ${names.load}(${JSON.stringify(entry)}).default;
`;
};
