import { loadJq } from "jq-wasm";

import jqModule from "./jq.wasm";
import { jqProvenance } from "./provenance.ts";

/**
 * How much work one jq run may do, in fuel: one unit per function call and
 * loop iteration inside jq (see scripts/jq-wasm/meter.ts), plus a charge
 * per call out to its JavaScript runtime. When it runs out, the run traps
 * where it is: the computation stops, it isn't merely abandoned.
 *
 * Fuel, unlike time, is deterministic: the same expression on the same
 * values succeeds or runs out the same way on every replay, on any machine
 * or load. It is sized to the 100 ms CPU limit. Measured on V8 (Apple
 * M-series), jq spends about 230,000 to 2,500,000 units a millisecond
 * evaluating, and about 120,000 parsing JSON, which the 1 MiB context
 * bounds; runaways of every kind in the tests (loops, date parsing, string
 * copies, collecting) ran out in 23 to 45 ms in workerd. Wherever the
 * platform enforces CPU limits, the isolate's 100 ms limit
 * (`evaluatorLimits.cpuMs`) stays the backstop.
 */
export const runFuel = 2 ** 24;

/**
 * What a call into jq's JavaScript runtime costs (a system call: output,
 * time conversion, memory growth), in fuel. strptime is the dear one: it
 * builds and runs regular expressions in JavaScript, about 5 µs a call.
 */
const importFuel = 256;
const importFuelByName: Readonly<Record<string, number>> = {
  _strptime: 2048,
};

/** How one jq run ended. */
export type JqRun =
  | { kind: "completed"; exitCode: number; stdout: string; stderr: string }
  | { kind: "exhausted"; resource: "fuel" | "memory" | "stack" }
  | { kind: "crashed" };

class FuelExhaustedError extends Error {
  constructor() {
    super("jq ran out of fuel");
    this.name = "FuelExhaustedError";
  }
}

interface Meter {
  fuel: WebAssembly.Global | undefined;
  memoryRefused: boolean;
}

const isGlobal = (value: unknown): value is WebAssembly.Global =>
  value instanceof WebAssembly.Global;

/** Takes `cost` fuel, or stops the run where it is. */
const charge = (meter: Meter, cost: number): void => {
  const { fuel } = meter;
  if (fuel === undefined) {
    return;
  }
  const left = Number(fuel.value);
  if (left < cost) {
    fuel.value = 0;
    throw new FuelExhaustedError();
  }
  fuel.value = left - cost;
};

/**
 * jq's imports, each charging fuel before it runs. A refused memory growth
 * is noted, so the abort that follows reads as exhaustion, not a crash.
 */
const meterImports = (
  imports: WebAssembly.Imports,
  meter: Meter
): WebAssembly.Imports => {
  const metered: WebAssembly.Imports = {};
  for (const [namespace, members] of Object.entries(imports)) {
    const wrapped: WebAssembly.ModuleImports = {};
    for (const [name, member] of Object.entries(members)) {
      if (typeof member !== "function") {
        wrapped[name] = member;
        continue;
      }
      const cost = importFuelByName[member.name] ?? importFuel;
      const growsMemory = member.name === "_emscripten_resize_heap";
      wrapped[name] = (...args: unknown[]): unknown => {
        charge(meter, cost);
        const result: unknown = Reflect.apply(member, undefined, args);
        // Emscripten's resize answers false when the memory can't grow.
        if (growsMemory && result === false) {
          meter.memoryRefused = true;
        }
        return result;
      };
    }
    metered[namespace] = wrapped;
  }
  return metered;
};

const exhaustedBy = (error: unknown, meter: Meter): JqRun => {
  if (error instanceof FuelExhaustedError) {
    return { kind: "exhausted", resource: "fuel" };
  }
  if (error instanceof RangeError) {
    return { kind: "exhausted", resource: "stack" };
  }
  if (error instanceof WebAssembly.RuntimeError) {
    if (meter.fuel !== undefined && Number(meter.fuel.value) === 0) {
      return { kind: "exhausted", resource: "fuel" };
    }
    if (meter.memoryRefused) {
      return { kind: "exhausted", resource: "memory" };
    }
  }
  return { kind: "crashed" };
};

/**
 * Runs jq once, in a fresh instance with `runFuel` fuel: `program` on the
 * JSON text `stdin`, printing compact JSON. Nothing carries over between
 * runs, so one that ran out or crashed can't affect the next. jq can reach
 * only its runtime's imports: an in-memory file system holding stdin, a
 * synthetic environment, time conversion and output. No network, bindings
 * or host state.
 */
export const runJq = async (program: string, stdin: string): Promise<JqRun> => {
  const meter: Meter = { fuel: undefined, memoryRefused: false };
  const jq = await loadJq({
    instantiateWasm: (imports, onSuccess) => {
      const instance = new WebAssembly.Instance(
        jqModule,
        meterImports(imports, meter)
      );
      const fuel = instance.exports[jqProvenance.fuelExport];
      if (!isGlobal(fuel)) {
        throw new Error(
          "jq.wasm has no fuel global: rebuild it with scripts/jq-wasm"
        );
      }
      // Starting the runtime runs jq's constructors, metered too.
      fuel.value = runFuel;
      meter.fuel = fuel;
      onSuccess(instance, jqModule);
    },
  });
  if (meter.fuel === undefined) {
    throw new Error("jq started without its fuel global");
  }
  meter.fuel.value = runFuel;
  try {
    // `--` ends the options: the program is never read as a flag.
    const { exitCode, stdout, stderr } = jq.raw(stdin, program, ["-c", "--"]);
    return { kind: "completed", exitCode, stdout, stderr };
  } catch (error) {
    return exhaustedBy(error, meter);
  }
};
