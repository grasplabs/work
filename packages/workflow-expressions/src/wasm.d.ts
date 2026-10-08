// A .wasm import is the compiled module, as Wrangler and the Workers test
// pool load it.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
