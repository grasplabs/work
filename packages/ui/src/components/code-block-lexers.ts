// Every language @pierre/highlights ships a lexer for, by its name and each alias the lexer
// answers to, each loaded by an import of its own the first time a block in it is drawn: a
// bundler makes each a script of its own, and a page fetches only the languages it shows.
// Written by scripts/highlight-lexers.ts (`pnpm run generate`) from the package's langs/: do
// not edit.
import type { Language } from "@pierre/highlights/core";

/** Loads one language's lexer. */
export type Lexer = () => Promise<{ default: Language }>;

const abapLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/abap");
const adaLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/ada");
const ahkLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/ahk");
const angularHtmlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/angular-html");
const apacheLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/apache");
const apexLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/apex");
const aplLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/apl");
const applescriptLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/applescript");
const asciidocLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/asciidoc");
const asmLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/asm");
const astroLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/astro");
const awkLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/awk");
const ballerinaLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/ballerina");
const batLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/bat");
const beancountLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/beancount");
const berryLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/berry");
const bibtexLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/bibtex");
const bicepLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/bicep");
const bladeLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/blade");
const bslLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/bsl");
const cLexer: Lexer = async () => await import("@pierre/highlights/langs/c");
const c3Lexer: Lexer = async () => await import("@pierre/highlights/langs/c3");
const cadenceLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/cadence");
const cairoLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/cairo");
const chapelLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/chapel");
const clojureLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/clojure");
const cmakeLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/cmake");
const cobolLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/cobol");
const codeownersLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/codeowners");
const codeqlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/codeql");
const coffeeLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/coffee");
const commonLispLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/common-lisp");
const coqLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/coq");
const cppLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/cpp");
const csharpLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/csharp");
const cssLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/css");
const csvLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/csv");
const cudaLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/cuda");
const cueLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/cue");
const cypherLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/cypher");
const dLexer: Lexer = async () => await import("@pierre/highlights/langs/d");
const dartLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/dart");
const daxLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/dax");
const diffLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/diff");
const dockerLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/docker");
const dotenvLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/dotenv");
const dreamMakerLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/dream-maker");
const elixirLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/elixir");
const elmLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/elm");
const erbLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/erb");
const erlangLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/erlang");
const fishLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/fish");
const fluentLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/fluent");
const fortranFixedFormLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/fortran-fixed-form");
const fortranFreeFormLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/fortran-free-form");
const fsharpLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/fsharp");
const gdresourceLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/gdresource");
const gdscriptLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/gdscript");
const gdshaderLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/gdshader");
const gherkinLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/gherkin");
const gleamLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/gleam");
const glimmerJsLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/glimmer-js");
const glimmerTsLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/glimmer-ts");
const glslLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/glsl");
const gnuplotLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/gnuplot");
const goLexer: Lexer = async () => await import("@pierre/highlights/langs/go");
const graphqlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/graphql");
const groovyLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/groovy");
const groqLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/groq");
const hackLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/hack");
const hamlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/haml");
const handlebarsLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/handlebars");
const haskellLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/haskell");
const haxeLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/haxe");
const hjsonLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/hjson");
const hlslLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/hlsl");
const htmlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/html");
const httpLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/http");
const hurlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/hurl");
const imbaLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/imba");
const iniLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/ini");
const javaLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/java");
const jinjaLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/jinja");
const jsonLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/json");
const json5Lexer: Lexer = async () =>
  await import("@pierre/highlights/langs/json5");
const jsonlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/jsonl");
const jsonnetLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/jsonnet");
const juliaLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/julia");
const justLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/just");
const kdlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/kdl");
const kotlinLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/kotlin");
const kustoLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/kusto");
const latexLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/latex");
const leanLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/lean");
const lessLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/less");
const liquidLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/liquid");
const llvmLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/llvm");
const logLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/log");
const luaLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/lua");
const luauLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/luau");
const makeLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/make");
const markdownLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/markdown");
const markoLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/marko");
const matlabLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/matlab");
const mdxLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/mdx");
const mermaidLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/mermaid");
const moonbitLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/moonbit");
const moveLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/move");
const nginxLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/nginx");
const nimLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/nim");
const nixLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/nix");
const nsisLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/nsis");
const nushellLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/nushell");
const objectiveCLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/objective-c");
const ocamlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/ocaml");
const odinLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/odin");
const openscadLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/openscad");
const orgLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/org");
const pascalLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/pascal");
const perlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/perl");
const phpLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/php");
const pklLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/pkl");
const plsqlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/plsql");
const poLexer: Lexer = async () => await import("@pierre/highlights/langs/po");
const powerqueryLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/powerquery");
const powershellLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/powershell");
const prismaLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/prisma");
const prologLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/prolog");
const promqlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/promql");
const protoLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/proto");
const pugLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/pug");
const puppetLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/puppet");
const pythonLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/python");
const qmlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/qml");
const rLexer: Lexer = async () => await import("@pierre/highlights/langs/r");
const rakuLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/raku");
const razorLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/razor");
const regLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/reg");
const regexpLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/regexp");
const rosmsgLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/rosmsg");
const rstLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/rst");
const rubyLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/ruby");
const rustLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/rust");
const sasLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/sas");
const sassLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/sass");
const scalaLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/scala");
const scssLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/scss");
const sdblLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/sdbl");
const shaderlabLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/shaderlab");
const shellscriptLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/shellscript");
const smalltalkLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/smalltalk");
const smithyLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/smithy");
const solidityLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/solidity");
const sparqlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/sparql");
const splunkLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/splunk");
const sqlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/sql");
const stataLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/stata");
const stylusLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/stylus");
const surrealqlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/surrealql");
const svelteLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/svelte");
const swiftLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/swift");
const talonscriptLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/talonscript");
const tclLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/tcl");
const templLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/templ");
const terraformLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/terraform");
const tomlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/toml");
const tsrxLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/tsrx");
const tsvLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/tsv");
const turtleLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/turtle");
const twigLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/twig");
const typescriptLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/typescript");
const typstLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/typst");
const vLexer: Lexer = async () => await import("@pierre/highlights/langs/v");
const vbLexer: Lexer = async () => await import("@pierre/highlights/langs/vb");
const verilogLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/verilog");
const vhdlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/vhdl");
const vimlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/viml");
const vueLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/vue");
const wasmLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/wasm");
const wgslLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/wgsl");
const wikitextLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/wikitext");
const witLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/wit");
const wolframLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/wolfram");
const xmlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/xml");
const yamlLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/yaml");
const zenscriptLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/zenscript");
const zigLexer: Lexer = async () =>
  await import("@pierre/highlights/langs/zig");

/** Each language's lexer, by its name and each alias, in lower case. */
export const lexers: Record<string, Lexer> = {
  "1c": bslLexer,
  "1c-query": sdblLexer,
  abap: abapLexer,
  actionscript: typescriptLexer,
  "actionscript-3": typescriptLexer,
  ada: adaLexer,
  adb: adaLexer,
  adoc: asciidocLexer,
  ads: adaLexer,
  ahk: ahkLexer,
  ahk1: ahkLexer,
  ahk2: ahkLexer,
  "angular-html": angularHtmlLexer,
  "angular-ts": typescriptLexer,
  apache: apacheLexer,
  apacheconf: apacheLexer,
  apex: apexLexer,
  apl: aplLexer,
  applescript: applescriptLexer,
  ara: hackLexer,
  as3: typescriptLexer,
  asciidoc: asciidocLexer,
  asm: asmLexer,
  assembly: asmLexer,
  astro: astroLexer,
  autohotkey: ahkLexer,
  awk: awkLexer,
  bal: ballerinaLexer,
  ballerina: ballerinaLexer,
  bash: shellscriptLexer,
  bat: batLexer,
  batch: batLexer,
  batchfile: batLexer,
  be: berryLexer,
  beancount: beancountLexer,
  berry: berryLexer,
  bib: bibtexLexer,
  bibtex: bibtexLexer,
  bicep: bicepLexer,
  bird: nginxLexer,
  bird2: nginxLexer,
  blade: bladeLexer,
  bsl: bslLexer,
  c: cLexer,
  "c#": csharpLexer,
  "c++": cppLexer,
  c3: c3Lexer,
  cadence: cadenceLexer,
  cairo: cairoLexer,
  cbl: cobolLexer,
  cc: cppLexer,
  cdc: cadenceLexer,
  chapel: chapelLexer,
  chpl: chapelLexer,
  cjs: typescriptLexer,
  cl: commonLispLexer,
  clarity: commonLispLexer,
  clj: clojureLexer,
  cljc: clojureLexer,
  cljs: clojureLexer,
  clojure: clojureLexer,
  cmake: cmakeLexer,
  cmd: batLexer,
  cob: cobolLexer,
  cobol: cobolLexer,
  codeowners: codeownersLexer,
  codeql: codeqlLexer,
  coffee: coffeeLexer,
  coffeescript: coffeeLexer,
  "common-lisp": commonLispLexer,
  comp: glslLexer,
  console: shellscriptLexer,
  containerfile: dockerLexer,
  coq: coqLexer,
  cpp: cppLexer,
  cql: cypherLexer,
  crystal: rubyLexer,
  cs: csharpLexer,
  csharp: csharpLexer,
  cshtml: razorLexer,
  css: cssLexer,
  csv: csvLexer,
  cts: typescriptLexer,
  cu: cudaLexer,
  cucumber: gherkinLexer,
  cuda: cudaLexer,
  cue: cueLexer,
  cuh: cudaLexer,
  cxx: cppLexer,
  cypher: cypherLexer,
  d: dLexer,
  dart: dartLexer,
  dax: daxLexer,
  delphi: pascalLexer,
  desktop: iniLexer,
  diff: diffLexer,
  dm: dreamMakerLexer,
  docker: dockerLexer,
  dockerfile: dockerLexer,
  dos: batLexer,
  dotenv: dotenvLexer,
  dpk: pascalLexer,
  dpr: pascalLexer,
  "dream-maker": dreamMakerLexer,
  edge: bladeLexer,
  edn: clojureLexer,
  el: commonLispLexer,
  elisp: commonLispLexer,
  elixir: elixirLexer,
  elm: elmLexer,
  "emacs-lisp": commonLispLexer,
  env: dotenvLexer,
  erb: erbLexer,
  erl: erlangLexer,
  erlang: erlangLexer,
  ex: elixirLexer,
  exs: elixirLexer,
  f: fortranFixedFormLexer,
  "f#": fsharpLexer,
  f03: fortranFreeFormLexer,
  f08: fortranFreeFormLexer,
  f18: fortranFreeFormLexer,
  f77: fortranFixedFormLexer,
  f90: fortranFreeFormLexer,
  f95: fortranFreeFormLexer,
  feature: gherkinLexer,
  fennel: clojureLexer,
  fish: fishLexer,
  fluent: fluentLexer,
  for: fortranFixedFormLexer,
  fortran: fortranFreeFormLexer,
  "fortran-fixed-form": fortranFixedFormLexer,
  "fortran-free-form": fortranFreeFormLexer,
  frag: glslLexer,
  fs: fsharpLexer,
  fsharp: fsharpLexer,
  fsi: fsharpLexer,
  fsx: fsharpLexer,
  ftl: fluentLexer,
  gd: gdscriptLexer,
  gdresource: gdresourceLexer,
  gdscript: gdscriptLexer,
  gdshader: gdshaderLexer,
  gdshaderinc: gdshaderLexer,
  genie: csharpLexer,
  geom: glslLexer,
  gherkin: gherkinLexer,
  "git-commit": diffLexer,
  "git-rebase": diffLexer,
  gjs: glimmerJsLexer,
  gleam: gleamLexer,
  "glimmer-js": glimmerJsLexer,
  "glimmer-ts": glimmerTsLexer,
  glsl: glslLexer,
  gn: terraformLexer,
  gnuplot: gnuplotLexer,
  go: goLexer,
  "godot-resource": gdresourceLexer,
  "godot-shader": gdshaderLexer,
  golang: goLexer,
  gp: gnuplotLexer,
  gql: graphqlLexer,
  gradle: groovyLexer,
  graphql: graphqlLexer,
  groovy: groovyLexer,
  groq: groqLexer,
  gsh: groovyLexer,
  gts: glimmerTsLexer,
  gvy: groovyLexer,
  gy: groovyLexer,
  h: cLexer,
  hack: hackLexer,
  haml: hamlLexer,
  handlebars: handlebarsLexer,
  haskell: haskellLexer,
  haxe: haxeLexer,
  hbs: handlebarsLexer,
  hcl: terraformLexer,
  hh: cppLexer,
  hjson: hjsonLexer,
  hlsl: hlslLexer,
  hpp: cppLexer,
  hrl: erlangLexer,
  hs: haskellLexer,
  htaccess: apacheLexer,
  htm: htmlLexer,
  html: htmlLexer,
  "html-derivative": htmlLexer,
  http: httpLexer,
  hurl: hurlLexer,
  hx: haxeLexer,
  hxml: shellscriptLexer,
  hxx: cppLexer,
  hy: clojureLexer,
  imba: imbaLexer,
  ini: iniLexer,
  j2: jinjaLexer,
  jade: pugLexer,
  java: javaLexer,
  javascript: typescriptLexer,
  jinja: jinjaLexer,
  jinja2: jinjaLexer,
  jl: juliaLexer,
  js: typescriptLexer,
  json: jsonLexer,
  json5: json5Lexer,
  jsonc: jsonLexer,
  jsonl: jsonlLexer,
  jsonnet: jsonnetLexer,
  jsx: typescriptLexer,
  julia: juliaLexer,
  just: justLexer,
  justfile: justLexer,
  kdl: kdlLexer,
  kotlin: kotlinLexer,
  kql: kustoLexer,
  kt: kotlinLexer,
  kts: kotlinLexer,
  kusto: kustoLexer,
  latex: latexLexer,
  lean: leanLexer,
  lean4: leanLexer,
  less: lessLexer,
  libsonnet: jsonnetLexer,
  liquid: liquidLexer,
  lisp: commonLispLexer,
  lit: typescriptLexer,
  llvm: llvmLexer,
  log: logLexer,
  lpr: pascalLexer,
  lsp: commonLispLexer,
  lua: luaLexer,
  luau: luauLexer,
  m: objectiveCLexer,
  make: makeLexer,
  makefile: makeLexer,
  markdown: markdownLexer,
  marko: markoLexer,
  mathematica: wolframLexer,
  matlab: matlabLexer,
  mbt: moonbitLexer,
  mbti: moonbitLexer,
  md: markdownLexer,
  mdc: markdownLexer,
  mdx: mdxLexer,
  mediawiki: wikitextLexer,
  mermaid: mermaidLexer,
  mips: asmLexer,
  mipsasm: asmLexer,
  mjs: typescriptLexer,
  mk: makeLexer,
  ml: ocamlLexer,
  mli: ocamlLexer,
  mm: objectiveCLexer,
  mmd: mermaidLexer,
  mojo: pythonLexer,
  moonbit: moonbitLexer,
  move: moveLexer,
  mts: typescriptLexer,
  mustache: handlebarsLexer,
  nextflow: groovyLexer,
  "nextflow-groovy": groovyLexer,
  nf: groovyLexer,
  nginx: nginxLexer,
  nim: nimLexer,
  nix: nixLexer,
  nsh: nsisLexer,
  nsi: nsisLexer,
  nsis: nsisLexer,
  nu: nushellLexer,
  nushell: nushellLexer,
  objc: objectiveCLexer,
  objcpp: objectiveCLexer,
  "object-pascal": pascalLexer,
  "objective-c": objectiveCLexer,
  "objective-cpp": objectiveCLexer,
  objectivec: objectiveCLexer,
  objectpascal: pascalLexer,
  ocaml: ocamlLexer,
  octave: matlabLexer,
  odin: odinLexer,
  openscad: openscadLexer,
  org: orgLexer,
  pas: pascalLexer,
  pascal: pascalLexer,
  patch: diffLexer,
  perl: perlLexer,
  perl6: rakuLexer,
  php: phpLexer,
  pkl: pklLexer,
  pl: perlLexer,
  plsql: plsqlLexer,
  pm: perlLexer,
  po: poLexer,
  postcss: cssLexer,
  pot: poLexer,
  potx: poLexer,
  powerquery: powerqueryLexer,
  powershell: powershellLexer,
  pp: pascalLexer,
  pq: powerqueryLexer,
  prisma: prismaLexer,
  prolog: prologLexer,
  promql: promqlLexer,
  properties: iniLexer,
  proto: protoLexer,
  protobuf: protoLexer,
  ps: powershellLexer,
  ps1: powershellLexer,
  psd1: powershellLexer,
  psm1: powershellLexer,
  pug: pugLexer,
  puppet: puppetLexer,
  purescript: haskellLexer,
  pwsh: powershellLexer,
  py: pythonLexer,
  python: pythonLexer,
  ql: codeqlLexer,
  qml: qmlLexer,
  qmldir: apacheLexer,
  qss: cssLexer,
  r: rLexer,
  racket: commonLispLexer,
  raku: rakuLexer,
  razor: razorLexer,
  rb: rubyLexer,
  rbs: rubyLexer,
  reg: regLexer,
  regex: regexpLexer,
  regexp: regexpLexer,
  restructuredtext: rstLexer,
  riscv: asmLexer,
  rkt: commonLispLexer,
  rocq: coqLexer,
  ron: rustLexer,
  rosmsg: rosmsgLexer,
  rs: rustLexer,
  rscript: rLexer,
  rst: rstLexer,
  ruby: rubyLexer,
  "ruby-signature": rubyLexer,
  rust: rustLexer,
  s: asmLexer,
  sas: sasLexer,
  sass: sassLexer,
  sbt: scalaLexer,
  sc: scalaLexer,
  scad: openscadLexer,
  scala: scalaLexer,
  scheme: commonLispLexer,
  scm: commonLispLexer,
  scss: scssLexer,
  sdbl: sdblLexer,
  sh: shellscriptLexer,
  shader: shaderlabLexer,
  shaderlab: shaderlabLexer,
  shell: shellscriptLexer,
  shellscript: shellscriptLexer,
  shellsession: shellscriptLexer,
  smalltalk: smalltalkLexer,
  smithy: smithyLexer,
  sol: solidityLexer,
  solidity: solidityLexer,
  sparql: sparqlLexer,
  spl: splunkLexer,
  splunk: splunkLexer,
  sql: sqlLexer,
  "ssh-config": apacheLexer,
  st: smalltalkLexer,
  stata: stataLexer,
  styl: stylusLexer,
  stylus: stylusLexer,
  surql: surrealqlLexer,
  surrealql: surrealqlLexer,
  sv: verilogLexer,
  svelte: svelteLexer,
  svg: xmlLexer,
  svh: verilogLexer,
  swift: swiftLexer,
  "system-verilog": verilogLexer,
  systemd: iniLexer,
  systemverilog: verilogLexer,
  talon: talonscriptLexer,
  talonscript: talonscriptLexer,
  tcl: tclLexer,
  templ: templLexer,
  terraform: terraformLexer,
  tex: latexLexer,
  tf: terraformLexer,
  tfvars: terraformLexer,
  toml: tomlLexer,
  tres: gdresourceLexer,
  ts: typescriptLexer,
  "ts-tags": typescriptLexer,
  tscn: gdresourceLexer,
  tsp: typescriptLexer,
  tsrx: tsrxLexer,
  tsv: tsvLexer,
  tsx: typescriptLexer,
  ttl: turtleLexer,
  turtle: turtleLexer,
  twig: twigLexer,
  typ: typstLexer,
  typescript: typescriptLexer,
  typespec: typescriptLexer,
  typst: typstLexer,
  v: vLexer,
  vala: csharpLexer,
  vb: vbLexer,
  vba: vbLexer,
  vbnet: vbLexer,
  vbscript: vbLexer,
  verilog: verilogLexer,
  vert: glslLexer,
  vhd: vhdlLexer,
  vhdl: vhdlLexer,
  vim: vimlLexer,
  viml: vimlLexer,
  vimscript: vimlLexer,
  vue: vueLexer,
  "vue-html": vueLexer,
  "vue-vine": typescriptLexer,
  vy: pythonLexer,
  vyper: pythonLexer,
  wasm: wasmLexer,
  wat: wasmLexer,
  wgsl: wgslLexer,
  wiki: wikitextLexer,
  wikitext: wikitextLexer,
  wit: witLexer,
  wl: wolframLexer,
  wolfram: wolframLexer,
  xml: xmlLexer,
  xsd: xmlLexer,
  xsl: xmlLexer,
  xslt: xmlLexer,
  yaml: yamlLexer,
  yml: yamlLexer,
  zenscript: zenscriptLexer,
  zig: zigLexer,
  zon: zigLexer,
  zs: zenscriptLexer,
  zsh: shellscriptLexer,
};
