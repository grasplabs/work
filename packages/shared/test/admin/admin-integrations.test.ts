import { describe, expect, it } from "vite-plus/test";

import {
  askedBy,
  firstAsked,
  sortAsked,
} from "../../src/admin/admin-integrations.ts";
import type { AskedApp } from "../../src/admin/admin-integrations.ts";

const app = (
  id: string,
  requests: AskedApp["requests"],
  name = id
): AskedApp => ({ id, app: name, requests });

describe("the apps asked of Grasp", () => {
  it("names each company that asked once, in the order they asked, and the day it was first asked", () => {
    const asked = app("acme", [
      { org: "hartog", on: "2026-09-10" },
      { org: "noordkade", on: "2026-09-02" },
      { org: "hartog", on: "2026-09-20" },
    ]);
    expect({
      by: askedBy(asked),
      first: firstAsked(asked),
    }).toStrictEqual({ by: ["noordkade", "hartog"], first: "2026-09-02" });
  });

  it("lists the app most companies asked for first, then the one asked for longest ago", () => {
    const apps = [
      app("late", [{ org: "a", on: "2026-10-01" }]),
      app("many", [
        { org: "a", on: "2026-10-05" },
        { org: "b", on: "2026-10-06" },
      ]),
      app("early", [{ org: "a", on: "2026-09-01" }]),
    ];
    expect(sortAsked(apps).map(({ id }) => id)).toStrictEqual([
      "many",
      "early",
      "late",
    ]);
  });
});
