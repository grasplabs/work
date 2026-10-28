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
 * an async function in the entry's own module table, with its imports and
 * exports made calls and properties (Babel's CommonJS transform) and its
 * dynamic imports resolved in the same table. Async, as a module may
 * await at its top level as any ES module may: the modules it imports
 * are evaluated first, in the order it imports them, each awaited, so
 * its `require`s find them done, as an ES module's imports would be. One
 * already started and not done is one importing it, a cycle, and is not
 * awaited, as ES modules don't await a cycle either. Nothing is recompiled:
 * assembly only rewrites how modules reach each other, so it is measured
 * on its own, never claimed as a compile of unchanged source.
 */

/** The names the entry's own code uses: none an App module can shadow at its top level. */
const names = {
  kit: "__graspKit",
  table: "__graspModules",
  cache: "__graspLoaded",
  load: "__graspLoad",
  require: "__graspRequire",
  dynamicImport: "__graspImport",
} as const;

/** The parts of a Babel node the entry's own plugin reads. */
interface Node {
  readonly type: string;
  readonly source?: { readonly value: unknown } | null;
}

/** The parts of Babel's plugin API the entry's own plugin uses. */
interface PluginApi {
  readonly types: { identifier: (name: string) => unknown };
}

/** One App module as CommonJS, and the modules it imports statically, in order. */
interface CommonJsModule {
  readonly code: string;
  readonly imports: readonly string[];
}

/**
 * One App module as CommonJS: its body, reaching others through
 * `require`, and its dynamic imports made calls of the entry's own.
 */
const asCommonJs = (code: string, name: string): CommonJsModule => {
  const imports: string[] = [];
  const entryPlugin = ({ types }: PluginApi) => ({
    visitor: {
      Program: {
        enter: (path: { node: { body: readonly Node[] } }) => {
          for (const statement of path.node.body) {
            const source = statement.source?.value;
            const imported =
              statement.type === "ImportDeclaration" ||
              statement.type === "ExportAllDeclaration" ||
              statement.type === "ExportNamedDeclaration";
            if (imported && typeof source === "string") {
              imports.push(source);
            }
          }
        },
      },
      CallExpression: (path: {
        node: { callee: unknown };
        get: (key: "callee") => { isImport: () => boolean };
      }) => {
        if (path.get("callee").isImport()) {
          path.node.callee = types.identifier(names.dynamicImport);
        }
      },
    },
  });
  const transformed =
    Babel.transform(code, {
      filename: name,
      babelrc: false,
      configFile: false,
      sourceType: "module",
      compact: true,
      plugins: [entryPlugin, "transform-modules-commonjs"],
    }).code ?? "";
  return { code: transformed, imports: [...new Set(imports)] };
};

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
      const module = asCommonJs(code, name);
      return `${JSON.stringify(name)}: [${JSON.stringify(module.imports)}, async (module, exports, require, ${names.dynamicImport}) => {${module.code}\n}]`;
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
const ${names.require} = (name) => {
  if (Object.hasOwn(${names.kit}, name)) return ${names.kit}[name];
  const loaded = ${names.cache}[name];
  if (loaded === undefined) throw new Error("The preview has no module " + name + ".");
  return loaded.module.exports;
};
const ${names.load} = async (name) => {
  if (Object.hasOwn(${names.kit}, name) || Object.hasOwn(${names.cache}, name)) return;
  const defined = ${names.table}[name];
  if (defined === undefined) throw new Error("The preview has no module " + name + ".");
  const [needs, define] = defined;
  const loaded = { module: { exports: {} } };
  ${names.cache}[name] = loaded;
  loaded.done = (async () => {
    for (const need of needs) await ${names.load}(need);
    await define(loaded.module, loaded.module.exports, ${names.require}, ${names.dynamicImport});
  })();
  await loaded.done;
};
const ${names.dynamicImport} = async (name) => {
  const loaded = ${names.cache}[name];
  await (loaded === undefined ? ${names.load}(name) : loaded.done);
  return ${names.require}(name);
};
await ${names.load}(${JSON.stringify(entry)});
export default ${names.require}(${JSON.stringify(entry)}).default;
`;
};
