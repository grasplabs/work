// What an App's tests import as `vitest` (packages/compiler, app-code.ts):
// vitest's own `expect` (app-test-expect.ts), and nothing else of vitest,
// whose runner doesn't run in the sandbox an App's tests run in. They
// import it from `vitest`, as any vitest test does and as Ultracite's
// vitest rules hold them to (`prefer-importing-vitest-globals`).
export { expect } from "./app-test-expect.ts";
