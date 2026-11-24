/** WebAssembly a Worker imports: the module, compiled with its bundle. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
