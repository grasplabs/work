import { describe, expect, it } from "vite-plus/test";

import { pagesOf, pathOfRoute } from "./preview-controls.tsx";

describe("an App's pages, from its route files", () => {
  it("names each page by the path its file serves", () => {
    expect(
      [
        "src/routes/index.tsx",
        "src/routes/orders.tsx",
        "src/routes/orders/index.tsx",
        "src/routes/orders/archive.tsx",
        "src/routes/settings.billing.tsx",
        "src/routes/_layout/team.tsx",
        "src/routes/(admin)/audit.tsx",
        "src/routes/posts_.edit.tsx",
      ].map(pathOfRoute)
    ).toStrictEqual([
      "/",
      "/orders",
      "/orders",
      "/orders/archive",
      "/settings/billing",
      "/team",
      "/audit",
      "/posts/edit",
    ]);
  });

  it("leaves out what is no page: parameters, layouts, excluded files and other files", () => {
    expect(
      [
        "src/routes/orders/$orderId.tsx",
        "src/routes/__root.tsx",
        "src/routes/_layout.tsx",
        "src/routes/-parts.tsx",
        "src/routes/orders/-row.tsx",
        "server/orders.ts",
        "src/routes/notes.md",
      ].map(pathOfRoute)
    ).toStrictEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("lists each page once, the first route first", () => {
    expect(
      pagesOf([
        "src/routes/orders/index.tsx",
        "src/routes/orders.tsx",
        "src/routes/about.tsx",
        "src/routes/index.tsx",
        "grasp.config.ts",
      ])
    ).toStrictEqual(["/", "/about", "/orders"]);
  });
});
