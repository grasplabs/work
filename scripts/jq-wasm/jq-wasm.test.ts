import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { jqProvenance } from "../../packages/workflow-expressions/src/provenance.ts";
import { buildJqWasm, outputPath, sha256 } from "./build.ts";
import { meter } from "./meter.ts";

const mebibyte = 1024 * 1024;

/**
 * A module with `spin`, a loop that never ends; `call`, which calls a
 * function that returns at once; and a one-page memory.
 *
 *   (func $spin (export "spin") (loop (br 0)))
 *   (func $nothing)
 *   (func (export "call") (call $nothing))
 *   (memory (export "memory") 1)
 */
const sample = Uint8Array.from(
  [
    // Header
    "0061736d 01000000",
    // Types: () -> ()
    "01 04 01 60 00 00",
    // Functions: three of type 0
    "03 04 03 00 00 00",
    // Memory: min 1 page
    "05 03 01 00 01",
    // Exports: "spin" func 0, "call" func 2, "memory" memory 0
    "07 18 03 04 7370696e 00 00 04 63616c6c 00 02 06 6d656d6f7279 02 00",
    // Code: spin, nothing, call
    "0a 11 03 07 00 03 40 0c 00 0b 0b 02 00 0b 04 00 10 01 0b",
  ]
    .join("")
    .replaceAll(" ", "")
    .match(/../gu) ?? [],
  (byte) => Number.parseInt(byte, 16)
);
// Where spin's `br` instruction is: 12 bytes from the end.
const spinBranch = sample.length - 12;

const objectOf = (value: unknown): object =>
  (typeof value === "object" && value !== null) || typeof value === "function"
    ? value
    : {};

/**
 * Calls `method` of `target`. Node runs WebAssembly, but the scripts'
 * types (Node's, without the DOM library) don't describe it.
 */
const invoke = (
  target: unknown,
  method: string,
  ...args: unknown[]
): unknown => {
  const member: unknown = Reflect.get(objectOf(target), method);
  if (typeof member !== "function") {
    throw new TypeError(`No ${method} to call`);
  }
  const result: unknown = Reflect.apply(member, target, args);
  return result;
};

/** The metered sample's exports: functions to call, the fuel and memory. */
const instantiate = (bytes: Uint8Array) => {
  const wasm: unknown = Reflect.get(globalThis, "WebAssembly");
  const construct = (name: string, args: unknown[]): unknown => {
    const constructor: unknown = Reflect.get(objectOf(wasm), name);
    if (typeof constructor !== "function") {
      throw new TypeError(`No WebAssembly.${name}`);
    }
    const constructed: unknown = Reflect.construct(constructor, args);
    return constructed;
  };
  const exports: unknown = Reflect.get(
    objectOf(construct("Instance", [construct("Module", [bytes])])),
    "exports"
  );
  const exported = (name: string): unknown =>
    Reflect.get(objectOf(exports), name);
  const fuel = exported("fuel");
  return {
    spin: () => invoke(exports, "spin"),
    call: () => invoke(exports, "call"),
    grow: () => invoke(exported("memory"), "grow", 1),
    fuel: (): unknown => {
      const value: unknown = Reflect.get(objectOf(fuel), "value");
      return value;
    },
    setFuel: (value: number) => Reflect.set(objectOf(fuel), "value", value),
  };
};

describe(meter, () => {
  const metered = meter(sample, {
    fuelExport: "fuel",
    maxMemoryBytes: 2 * 65_536,
  });

  it("stops an endless loop when its fuel runs out", () => {
    const sampleModule = instantiate(metered);
    sampleModule.setFuel(1000);
    expect(sampleModule.spin).toThrow(/unreachable/u);
    expect(sampleModule.fuel()).toBe(0);
  });

  it("charges each function call", () => {
    const sampleModule = instantiate(metered);
    sampleModule.setFuel(10);
    sampleModule.call();
    // `call` and the function it calls: two units.
    expect(sampleModule.fuel()).toBe(8);
    sampleModule.setFuel(1);
    expect(sampleModule.call).toThrow(/unreachable/u);
  });

  it("caps the memory", () => {
    const sampleModule = instantiate(metered);
    expect(sampleModule.grow()).toBe(1);
    expect(sampleModule.grow).toThrow(RangeError);
  });

  it("refuses an instruction it can't decode", () => {
    const withUnknown = new Uint8Array(sample);
    // 0xff is no instruction in any WebAssembly version.
    withUnknown[spinBranch] = 0xff;
    expect(() =>
      meter(withUnknown, { fuelExport: "fuel", maxMemoryBytes: 65_536 })
    ).toThrow(/Unsupported instruction 0xff/u);
  });

  it("rebuilds the committed jq.wasm, byte for byte, from the pinned package", () => {
    const built = buildJqWasm();
    expect({
      hash: sha256(built),
      committed: sha256(readFileSync(outputPath)),
      memoryCap: jqProvenance.maxMemoryBytes / mebibyte,
    }).toStrictEqual({
      hash: jqProvenance.sha256,
      committed: jqProvenance.sha256,
      memoryCap: 64,
    });
  });
});
