/**
 * V8's background JavaScript compilation off, for a local workerd that
 * builds packages: the tests' (vite.config.ts) and `vp run dev`'s
 * (scripts/dev.ts). Each package build loads a fresh Loader isolate
 * (esbuild's WebAssembly), which then sits idle in a runtime that lives on:
 * the one `isolate: false` keeps for a whole test worker, or the dev
 * server's. A Maglev or concurrent Sparkplug job of such an isolate that
 * needs a garbage collection waits on a V8 worker thread for the isolate's
 * main thread to run it, which workerd only does when it runs code in that
 * isolate again: never. On CI's 4-vCPU runners workerd has three worker
 * threads; once three jobs wait like that, the runtime stops, and Vitest
 * never times its test out (GRA-554: the stalls of package-builds and
 * package-artifacts, each runtime's three worker threads parked in
 * `CollectionBarrier::AwaitCollectionBackground`). The dev server builds
 * in-process the same way (`SANDBOX_IN_PROCESS`), so enough builds stop it
 * too, sooner on a machine with few cores (GRA-664). Compiled on the main
 * thread, no job waits; on CI the build-heavy files took as long with it as
 * without. A fresh isolate per build is the security design, so it stays.
 *
 * Production is unaffected: Cloudflare runs builds, and on-prem the sandbox
 * host runs each call in a process of its own.
 */
const noBackgroundCompile = [
  "--no-concurrent-recompilation",
  "--no-concurrent-sparkplug",
];

/**
 * `MINIFLARE_WORKERD_V8_FLAGS` with background compilation off, keeping
 * any flags it already has. Miniflare, and with it Wrangler, passes the
 * variable on to every workerd it starts.
 */
export const withNoBackgroundCompile = (flags: string | undefined): string =>
  [...new Set([...(flags ?? "").split(" "), ...noBackgroundCompile])]
    .filter((flag) => flag !== "")
    .join(" ");
