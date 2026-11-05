import { describe, expect, it } from "vite-plus/test";

import { calledByApp } from "../src/console-origin.ts";

// Whose code called `console.error` in a screen's frame: the App's (a
// problem that fails a draft's check) or the kit's, such as React's
// development warnings in a preview (a warning that fails nothing). Pure,
// so tested on its own, on stacks as Chrome and Firefox write them. What
// can go wrong: an App's own call let off as a warning (from a module a
// preview's update loaded later, or one evaluated afresh under a visit),
// or a stack the runtime can't read taken for the kit's.

const origin = "https://acme.grasp.test/screen-modules";
const kit = `${origin}/kit`;
const appDirectory = `${origin}/${"d".repeat(64)}/`;
// Each address with its directory's token in the query (core's
// screen-frame.ts), which stacks keep.
const runtime = `${kit}/${"a".repeat(64)}.js?token=1.x`;
const app = `${appDirectory}${"b".repeat(64)}.js?token=1.z`;
const reactDom = `${kit}/${"c".repeat(64)}.js?token=1.x`;

const chrome = (caller: string): string => `Error
    at console.error (${runtime}:1:2048)
    at render (${caller}:1:99)
    at more (${reactDom}:1:5)`;

const firefox = (caller: string): string => `console.error@${runtime}:1:2048
render@${caller}:1:99`;

describe("a console.error call in a screen's frame", () => {
  it("is the App's when its caller is a module of the App's directory, the kit's otherwise", () => {
    const later = `${appDirectory}${"e".repeat(64)}.js?token=1.z`;
    const visited = `${appDirectory}3/${"b".repeat(64)}.js?token=1.z`;
    const from = (stack: string) => calledByApp(stack, runtime, appDirectory);

    expect({
      app: [from(chrome(app)), from(firefox(app))],
      // A module an update loaded later, and one evaluated afresh.
      later: [from(chrome(later)), from(chrome(visited))],
      react: [from(chrome(reactDom)), from(firefox(reactDom))],
      unreadable: [from(""), from("Error\n    at <anonymous>")],
    }).toStrictEqual({
      app: [true, true],
      later: [true, true],
      react: [false, false],
      unreadable: [true, true],
    });
  });
});
