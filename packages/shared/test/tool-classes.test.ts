import { describe, expect, it } from "vite-plus/test";

import { toolClassOf } from "../src/connect.ts";

describe("a tool's class", () => {
  it("reads or changes what the person or the company has, by its flag", () => {
    expect([
      toolClassOf({ readOnly: true, reach: "own" }),
      toolClassOf({ readOnly: false, reach: "own" }),
      toolClassOf({ readOnly: true, reach: "company" }),
      toolClassOf({ readOnly: false, reach: "company" }),
    ]).toStrictEqual([
      "read-own",
      "change-own",
      "read-company",
      "change-company",
    ]);
  });

  it("reaches others whatever its flag says", () => {
    expect([
      toolClassOf({ readOnly: true, reach: "others" }),
      toolClassOf({ readOnly: false, reach: "others" }),
    ]).toStrictEqual(["reach-others", "reach-others"]);
  });
});
