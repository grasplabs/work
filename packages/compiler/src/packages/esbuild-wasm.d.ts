// esbuild's WebAssembly, as the package builder's isolate is loaded with
// it: a module compiled by the Worker Loader, imported by name.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
