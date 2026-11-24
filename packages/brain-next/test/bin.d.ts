/** A test model's file, imported as its bytes (vite.config.ts). */
declare module "*.bin" {
  const bytes: ArrayBuffer;
  export default bytes;
}
