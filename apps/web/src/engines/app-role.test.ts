import { describe, expect, it } from "vite-plus/test";

import { buildsApp } from "./app-role.ts";

describe(buildsApp, () => {
  it("offers an App's changes to its builders alone, never to Grasp staff", () => {
    expect([
      buildsApp({ role: "builder" }, { staff: false }),
      buildsApp({ role: "builder" }, { staff: true }),
      buildsApp({ role: "user" }, { staff: false }),
      buildsApp({ role: "user" }, { staff: true }),
    ]).toStrictEqual([true, false, false, false]);
  });
});
