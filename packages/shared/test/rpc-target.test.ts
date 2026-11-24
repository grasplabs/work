import { describe, expect, it } from "vite-plus/test";

import { boundedRpcTarget } from "../src/rpc-target.ts";
import type { CallAround } from "../src/rpc-target.ts";

// A bounded target checks every argument before its method runs; a method
// it can't wrap must stop it from being made, never take arguments
// unchecked.

/** A value `levels` deep. */
const deep = (levels: number): unknown =>
  levels <= 1 ? 1 : [deep(levels - 1)];

/**
 * A class of targets counting the calls their method ran, new each time,
 * so no test's wrapped prototype is another's.
 */
const targetClass = (around?: CallAround) =>
  class Target extends boundedRpcTarget({ depth: 3, size: 1000 }, around) {
    ran = 0;

    take(value: unknown): number {
      this.ran += value === undefined ? 0 : 1;
      return this.ran;
    }
  };

const Target = targetClass();

/** A subclass of Target, made by hand, whose prototype fixes a method in place. */
const Locked = function Locked(): void {
  // Its prototype is all that matters here.
};
const lockedPrototype = {};
Object.setPrototypeOf(lockedPrototype, Target.prototype);
Object.defineProperty(lockedPrototype, "fixed", {
  value: (value: unknown) => value,
  writable: false,
  configurable: false,
});
Locked.prototype = lockedPrototype;

/** A subclass below {@link Locked}, whose own prototype wraps cleanly. */
const BelowLocked = function BelowLocked(): void {
  // Its prototype is all that matters here.
};
const belowPrototype = {};
Object.setPrototypeOf(belowPrototype, lockedPrototype);
Object.defineProperty(belowPrototype, "more", {
  value: (value: unknown) => value,
  writable: true,
  configurable: true,
});
BelowLocked.prototype = belowPrototype;

describe("a bounded RPC target", () => {
  it("refuses an argument deeper than its bound before the method runs", () => {
    const target = new Target();
    expect(() => target.take(deep(2))).not.toThrow();
    expect(() => target.take(deep(10))).toThrow("deep");
    expect(target.ran).toBe(1);
  });

  it("refuses to be made with a method it can't wrap, every time", () => {
    for (const attempt of [1, 2]) {
      expect(() => {
        Reflect.construct(Target, [], Locked);
      }, `attempt ${attempt}`).toThrow("can't be bounded");
    }
  });

  it("refuses to be made, every time, as a subclass of one with a method it can't wrap", () => {
    for (const attempt of [1, 2]) {
      expect(() => {
        Reflect.construct(Target, [], BelowLocked);
      }, `attempt ${attempt}`).toThrow("can't be bounded");
    }
  });
});

// A host names each method's parameters in a generated table; a target
// whose class or method it leaves out is refused, never called unnamed.

/** A hook that runs every call, noting the names it was told of each. */
const noting = (told: (readonly string[])[]): CallAround["hook"] => {
  const hook: CallAround["hook"] = (call, run) => {
    told.push(call.params);
    return run();
  };
  return hook;
};

describe("a bounded RPC target with parameter names", () => {
  it("refuses to be made, every time, when its class has no names", () => {
    const Unnamed = targetClass({ hook: noting([]), params: {} });
    for (const attempt of [1, 2]) {
      expect(() => new Unnamed(), `attempt ${attempt}`).toThrow(
        "Target.take has no parameter names"
      );
    }
  });

  it("refuses to be made, every time, when its method has no names", () => {
    const Unnamed = targetClass({ hook: noting([]), params: { Target: {} } });
    for (const attempt of [1, 2]) {
      expect(() => new Unnamed(), `attempt ${attempt}`).toThrow(
        "Target.take has no parameter names"
      );
    }
  });

  it("tells the hook the names its method gives its parameters", () => {
    const told: (readonly string[])[] = [];
    const Named = targetClass({
      hook: noting(told),
      params: { Target: { take: ["value"] } },
    });
    expect(new Named().take("a")).toBe(1);
    expect(told).toStrictEqual([["value"]]);
  });
});
