// @babel/standalone ships without types. This covers the part the compiler uses.
declare module "@babel/standalone" {
  interface TransformOptions {
    filename: string;
    babelrc: false;
    configFile: false;
    sourceType: "module";
    compact?: boolean;
    retainLines?: boolean;
    /** False: nothing is generated, only the plugins run. */
    code?: false;
    /** The parser's own plugins, for a pass with no preset. */
    parserOpts?: { plugins: unknown[] };
    presets?: unknown[];
    plugins: unknown[];
  }

  interface TransformResult {
    code?: string | null;
  }

  const Babel: {
    transform: (code: string, options: TransformOptions) => TransformResult;
  };
  export default Babel;
}
