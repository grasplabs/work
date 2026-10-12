import { rpcArgumentDepth } from "@grasp-os/shared/screens";
import { describe, expect, it } from "vite-plus/test";

import { capability, sessionForwarder } from "../src/sandbox-session.ts";

// What reaches a capability through a sandbox session (on-prem) arrives
// over Cap'n Web from the sandbox host, where App code runs: the forwarder
// core hands the session holds every argument to the session's bounds
// before the capability's own code runs, and refuses once its call is over.

/** A value `levels` deep. */
const deep = (levels: number): unknown =>
  levels <= 1 ? 1 : [deep(levels - 1)];

/** A capability counting what reached it. */
const counted = () => {
  const reached: unknown[] = [];
  const target = {
    take: (value: unknown): number => reached.push(value),
  };
  return { reached, target };
};

/** The forwarder's `take`, as the session calls it. */
const takeOf = (forwarder: object) => {
  const take: unknown = Reflect.get(forwarder, "take");
  if (typeof take !== "function") {
    throw new TypeError("The forwarder has no take");
  }
  return async (value: unknown): Promise<unknown> =>
    await Promise.resolve(Reflect.apply(take, forwarder, [value]));
};

describe("a session's forwarder to a capability", () => {
  it("refuses an argument deeper than a session's message lets one be", async () => {
    const { reached, target } = counted();
    const take = takeOf(
      sessionForwarder(capability(target, ["take"]), () => true)
    );
    await expect(take(deep(3))).resolves.toBe(1);
    await expect(take(deep(rpcArgumentDepth + 5))).rejects.toMatchObject({
      code: "request.too_deep",
    });
    expect(reached).toHaveLength(1);
  });

  it("refuses an argument of no kind a call takes", async () => {
    const { reached, target } = counted();
    const take = takeOf(
      sessionForwarder(capability(target, ["take"]), () => true)
    );
    const odd = { x: 1 };
    Object.setPrototypeOf(odd, { polluted: true });
    await expect(take(odd)).rejects.toMatchObject({
      code: "request.unsupported_value",
    });
    expect(reached).toHaveLength(0);
  });

  it("refuses every call once its call is over", async () => {
    const { reached, target } = counted();
    let live = true;
    const take = takeOf(
      sessionForwarder(capability(target, ["take"]), () => live)
    );
    await expect(take(1)).resolves.toBe(1);
    live = false;
    await expect(take(2)).rejects.toThrow("is over");
    expect(reached).toStrictEqual([1]);
  });
});
