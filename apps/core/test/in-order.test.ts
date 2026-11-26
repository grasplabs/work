import { describe, expect, it } from "vite-plus/test";

import { allInOrder } from "../src/in-order.ts";

// Steps run at once settle as one after another would (src/in-order.ts).

const after = async <T>(ms: number, value: () => T): Promise<T> => {
  await scheduler.wait(ms);
  return value();
};

describe("steps run at once, settled in order", () => {
  it("gives every value in order, however soon each came", async () => {
    await expect(
      allInOrder([after(20, () => "first"), after(0, () => 2)])
    ).resolves.toStrictEqual(["first", 2]);
  });

  it("fails with the first failure in order, not the soonest, once all have settled", async () => {
    const settled: string[] = [];
    const failing = async (ms: number, name: string) =>
      await after(ms, () => {
        settled.push(name);
        throw new Error(name);
      });
    await expect(
      allInOrder([
        after(0, () => settled.push("fine")),
        failing(30, "earlier step"),
        failing(0, "later step"),
        after(50, () => settled.push("slow")),
      ])
    ).rejects.toThrow("earlier step");
    expect(settled).toStrictEqual([
      "fine",
      "later step",
      "earlier step",
      "slow",
    ]);
  });
});
