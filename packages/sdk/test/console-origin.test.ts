import { describe, expect, it } from "vite-plus/test";

import { appModuleAddresses, calledByApp } from "../src/console-origin.ts";

// Whose code called `console.error` in a screen's frame: the App's (a
// problem that fails a draft's check) or the kit's, such as React's
// development warnings in a preview (a warning that fails nothing). Pure,
// so tested on its own, on stacks as Chrome and Firefox write them. What
// can go wrong: an App's own call let off as a warning (from an update's
// `data:` module, or an address with another token), or a stack the
// runtime can't read taken for the kit's.

const origin = "https://acme.grasp.test/screen-modules";
const runtime = `${origin}/${"a".repeat(64)}.js?token=1.x`;
const app = `${origin}/${"b".repeat(64)}.js`;
const reactDom = `${origin}/${"c".repeat(64)}.js?token=1.y`;

const importMap = JSON.stringify({
  imports: {
    "app~screens~desk.js": `${app}?token=1.z`,
    "react-dom~client.js": reactDom,
  },
});

const chrome = (caller: string): string => `Error
    at console.error (${runtime}:1:2048)
    at render (${caller}:1:99)
    at more (${reactDom}:1:5)`;

const firefox = (caller: string): string => `console.error@${runtime}:1:2048
render@${caller}:1:99`;

describe("a console.error call in a screen's frame", () => {
  it("is the App's when its caller is an App module or a data: module, the kit's otherwise", () => {
    const apps = appModuleAddresses(importMap);
    const update = "data:text/javascript;base64,ZXhwb3J0IGRlZmF1bHQgMQ==";
    const from = (stack: string) => calledByApp(stack, runtime, apps);

    expect({
      app: [from(chrome(app)), from(firefox(app))],
      // Another token on the same module: the same module.
      appOtherToken: from(chrome(`${app}?token=9.q`)),
      update: [from(chrome(update)), from(firefox(update))],
      react: [from(chrome(reactDom)), from(firefox(reactDom))],
      unreadable: [from(""), from("Error\n    at <anonymous>")],
    }).toStrictEqual({
      app: [true, true],
      appOtherToken: true,
      update: [true, true],
      react: [false, false],
      unreadable: [true, true],
    });
  });

  it("reads the App's modules from the import map alone, and nothing from a broken one", () => {
    expect({
      apps: [...appModuleAddresses(importMap)],
      broken: [...appModuleAddresses("{")],
      none: [...appModuleAddresses()],
    }).toStrictEqual({
      apps: [`${app}?token=1.z`],
      broken: [],
      none: [],
    });
  });
});
