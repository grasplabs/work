import { defaultExclude, defineProject } from "vite-plus";

// The kit's tests in Node. Its component tests in a real browser are a
// project of their own (vite.browser.config.ts).
export default defineProject({
  test: {
    exclude: [...defaultExclude, "test/**/*.browser.test.tsx"],
  },
});
