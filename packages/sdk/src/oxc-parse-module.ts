// oxc-parse.wasm compiled, as a Worker imports WebAssembly: a module of
// its bundle, as a Worker can't compile WebAssembly at run time. Node.js
// compiles it from the file instead (oxc-parse-module.node.ts).
export { default } from "./oxc-parse.wasm";
