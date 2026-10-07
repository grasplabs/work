/* oxlint-disable no-bitwise -- LEB128 numbers and WebAssembly's flags are bit fields */
/**
 * Meters a WebAssembly module: adds an exported, mutable i32 global (the
 * fuel) and, at the start of every function body and every loop iteration,
 * a check that traps (`unreachable`) when the fuel is 0 and otherwise takes
 * one unit. The host sets the fuel before a call and the computation stops
 * inside the module once it runs out, wherever it is: a kill path that
 * workerd has no other way to give for a synchronous call (it doesn't
 * enforce CPU limits, and no timer can run while the call holds the
 * isolate). Every loop and every call costs fuel, so any unbounded
 * computation runs out; straight-line code between them is bounded by the
 * module's size, and bulk memory operations by its memory, which this caps.
 *
 * It decodes every instruction, and refuses one it doesn't know rather
 * than guessing its length: the input bytes are pinned, so a new jq build
 * that uses more of WebAssembly fails here, loudly, at build time.
 */

const sectionId = {
  custom: 0,
  type: 1,
  import: 2,
  function: 3,
  table: 4,
  memory: 5,
  global: 6,
  export: 7,
  start: 8,
  element: 9,
  code: 10,
  data: 11,
  dataCount: 12,
} as const;

const externalKind = { function: 0, table: 1, memory: 2, global: 3 } as const;
const valueTypeI32 = 0x7f;
// i32, i64, f32, f64, v128, funcref, externref.
const valueTypes = new Set([0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f]);
const mutable = 0x01;
const pageBytes = 65_536;

const opcode = {
  unreachable: 0x00,
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  end: 0x0b,
  globalGet: 0x23,
  globalSet: 0x24,
  i32Const: 0x41,
  i32Eqz: 0x45,
  i32Sub: 0x6b,
  emptyBlockType: 0x40,
} as const;

/** What the metered module adds, and the cap it puts on its memory. */
export interface MeterOptions {
  /** Name of the exported fuel global. */
  fuelExport: string;
  /** Maximum memory, in bytes: a multiple of 64 KiB. */
  maxMemoryBytes: number;
}

class Reader {
  offset = 0;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  byte(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) {
      throw new Error(`Unexpected end of module at byte ${this.offset}`);
    }
    this.offset += 1;
    return value;
  }

  u32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const value = this.byte();
      result += (value & 0x7f) * 2 ** shift;
      if ((value & 0x80) === 0) {
        return result;
      }
      shift += 7;
      if (shift > 35) {
        throw new Error(`LEB128 too long at byte ${this.offset}`);
      }
    }
  }

  /** Skips a signed or unsigned LEB128 of any width. */
  skipLeb(): void {
    while ((this.byte() & 0x80) !== 0) {
      // Continuation bytes.
    }
  }

  skip(count: number): void {
    if (this.offset + count > this.bytes.length) {
      throw new Error(`Unexpected end of module at byte ${this.offset}`);
    }
    this.offset += count;
  }

  slice(start: number, end = this.offset): Uint8Array {
    return this.bytes.subarray(start, end);
  }
}

const u32Leb = (value: number): number[] => {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest !== 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (rest !== 0);
  return out;
};

const concat = (parts: (Uint8Array | number[])[]): Uint8Array => {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const vector = (count: number, items: Uint8Array): Uint8Array =>
  concat([u32Leb(count), items]);

const section = (id: number, payload: Uint8Array): Uint8Array =>
  concat([[id], u32Leb(payload.length), payload]);

/** `if fuel == 0 { unreachable } fuel -= 1` */
const fuelCheck = (fuelGlobal: number): number[] => {
  const index = u32Leb(fuelGlobal);
  return [
    opcode.globalGet,
    ...index,
    opcode.i32Eqz,
    opcode.if,
    opcode.emptyBlockType,
    opcode.unreachable,
    opcode.end,
    opcode.globalGet,
    ...index,
    opcode.i32Const,
    1,
    opcode.i32Sub,
    opcode.globalSet,
    ...index,
  ];
};

const skipBlockType = (reader: Reader): void => {
  const first = reader.bytes[reader.offset];
  // 0x40 (empty) or a value type is one byte; otherwise an s33 type index.
  if (
    first === opcode.emptyBlockType ||
    (first !== undefined && valueTypes.has(first))
  ) {
    reader.skip(1);
    return;
  }
  reader.skipLeb();
};

const skipMemarg = (reader: Reader): void => {
  const align = reader.u32();
  // Bit 6 of the alignment flags a memory index (multi-memory).
  if ((align & 0x40) !== 0) {
    reader.skipLeb();
  }
  reader.skipLeb();
};

/** The 0xfc prefix: saturating truncation, bulk memory and table ops. */
const skipPrefixed = (reader: Reader): void => {
  const sub = reader.u32();
  if (sub <= 7) {
    return;
  }
  // memory.init, table.init, table.copy and memory.copy take two indices;
  // data.drop, memory.fill, elem.drop and table.grow/size/fill take one.
  const twoIndices = new Set([8, 10, 12, 14]);
  const oneIndex = new Set([9, 11, 13, 15, 16, 17]);
  if (twoIndices.has(sub)) {
    reader.skipLeb();
    reader.skipLeb();
    return;
  }
  if (oneIndex.has(sub)) {
    reader.skipLeb();
    return;
  }
  throw new Error(
    `Unsupported instruction 0xfc ${sub} at byte ${reader.offset}`
  );
};

const immediateFree = (op: number): boolean =>
  op === 0x00 ||
  op === 0x01 ||
  op === 0x05 ||
  op === 0x0b ||
  op === 0x0f ||
  op === 0x1a ||
  op === 0x1b ||
  op === 0xd1 ||
  (op >= 0x45 && op <= 0xc4);

const oneIndexOps = new Set([
  0x0c, 0x0d, 0x10, 0x12, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x3f, 0x40,
  0xd2,
]);

/** Skips one instruction's immediates; `op` is already read. */
const skipImmediates = (reader: Reader, op: number): void => {
  if (immediateFree(op)) {
    return;
  }
  if (op === opcode.block || op === opcode.loop || op === opcode.if) {
    skipBlockType(reader);
    return;
  }
  if (oneIndexOps.has(op) || op === 0x41 || op === 0x42) {
    reader.skipLeb();
    return;
  }
  if (op >= 0x28 && op <= 0x3e) {
    skipMemarg(reader);
    return;
  }
  switch (op) {
    case 0x0e: {
      const targets = reader.u32();
      for (let index = 0; index <= targets; index += 1) {
        reader.skipLeb();
      }
      return;
    }
    case 0x11:
    case 0x13: {
      reader.skipLeb();
      reader.skipLeb();
      return;
    }
    case 0x1c: {
      reader.skip(reader.u32());
      return;
    }
    case 0x43: {
      reader.skip(4);
      return;
    }
    case 0x44: {
      reader.skip(8);
      return;
    }
    case 0xd0: {
      reader.skip(1);
      return;
    }
    case 0xfc: {
      skipPrefixed(reader);
      return;
    }
    default: {
      throw new Error(
        `Unsupported instruction 0x${op.toString(16)} at byte ${reader.offset - 1}`
      );
    }
  }
};

/** One function body, with the fuel check at its entry and in every loop. */
const meterBody = (body: Uint8Array, fuelGlobal: number): Uint8Array => {
  const reader = new Reader(body);
  const localGroups = reader.u32();
  for (let group = 0; group < localGroups; group += 1) {
    reader.skipLeb();
    reader.skip(1);
  }
  const check = fuelCheck(fuelGlobal);
  const parts: (Uint8Array | number[])[] = [
    reader.slice(0, reader.offset),
    check,
  ];
  let copiedTo = reader.offset;
  while (!reader.done) {
    const op = reader.byte();
    skipImmediates(reader, op);
    if (op === opcode.loop) {
      parts.push(reader.slice(copiedTo), check);
      copiedTo = reader.offset;
    }
  }
  parts.push(reader.slice(copiedTo));
  return concat(parts);
};

const meterCode = (payload: Uint8Array, fuelGlobal: number): Uint8Array => {
  const reader = new Reader(payload);
  const count = reader.u32();
  const bodies: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const size = reader.u32();
    const start = reader.offset;
    reader.skip(size);
    const metered = meterBody(reader.slice(start), fuelGlobal);
    bodies.push(concat([u32Leb(metered.length), metered]));
  }
  return vector(count, concat(bodies));
};

const countImportedGlobals = (payload: Uint8Array): number => {
  const reader = new Reader(payload);
  const count = reader.u32();
  let globals = 0;
  for (let index = 0; index < count; index += 1) {
    reader.skip(reader.u32());
    reader.skip(reader.u32());
    const kind = reader.byte();
    if (kind === externalKind.function) {
      reader.skipLeb();
    } else if (kind === externalKind.table) {
      reader.skip(1);
      const flags = reader.u32();
      reader.skipLeb();
      if ((flags & 1) !== 0) {
        reader.skipLeb();
      }
    } else if (kind === externalKind.memory) {
      throw new Error("An imported memory can't be capped here");
    } else if (kind === externalKind.global) {
      reader.skip(2);
      globals += 1;
    } else {
      throw new Error(`Unsupported import kind ${kind}`);
    }
  }
  return globals;
};

/** Caps the module's one memory at `maxPages`. */
const capMemory = (payload: Uint8Array, maxPages: number): Uint8Array => {
  const reader = new Reader(payload);
  if (reader.u32() !== 1) {
    throw new Error("Expected exactly one memory");
  }
  const flags = reader.byte();
  if (flags !== 0 && flags !== 1) {
    throw new Error(`Unsupported memory flags ${flags}`);
  }
  const initialPages = reader.u32();
  if (initialPages > maxPages) {
    throw new Error(
      `The memory starts at ${initialPages} pages, over the cap of ${maxPages}`
    );
  }
  return concat([[1, 1], u32Leb(initialPages), u32Leb(maxPages)]);
};

const addGlobal = (payload: Uint8Array | undefined): Uint8Array => {
  // mut i32 = i32.const 0
  const fuel = [valueTypeI32, mutable, opcode.i32Const, 0, opcode.end];
  if (payload === undefined) {
    return vector(1, new Uint8Array(fuel));
  }
  const reader = new Reader(payload);
  const count = reader.u32();
  return vector(
    count + 1,
    concat([reader.slice(reader.offset, payload.length), fuel])
  );
};

const addExport = (
  payload: Uint8Array,
  name: string,
  index: number
): Uint8Array => {
  const reader = new Reader(payload);
  const count = reader.u32();
  const nameBytes = new TextEncoder().encode(name);
  return vector(
    count + 1,
    concat([
      reader.slice(reader.offset, payload.length),
      u32Leb(nameBytes.length),
      nameBytes,
      [externalKind.global],
      u32Leb(index),
    ])
  );
};

const countDefinedGlobals = (payload: Uint8Array | undefined): number =>
  payload === undefined ? 0 : new Reader(payload).u32();

const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** Returns the metered module; deterministic for the same input. */
export const meter = (input: Uint8Array, options: MeterOptions): Uint8Array => {
  if (options.maxMemoryBytes % pageBytes !== 0) {
    throw new Error("maxMemoryBytes must be a multiple of 64 KiB");
  }
  for (const [index, byte] of header.entries()) {
    if (input[index] !== byte) {
      throw new Error("Not a WebAssembly 1.0 module");
    }
  }
  const reader = new Reader(input);
  reader.skip(header.length);
  const sections: { id: number; payload: Uint8Array }[] = [];
  while (!reader.done) {
    const id = reader.byte();
    const size = reader.u32();
    const start = reader.offset;
    reader.skip(size);
    sections.push({ id, payload: reader.slice(start) });
  }
  const payloadOf = (id: number): Uint8Array | undefined =>
    sections.find((entry) => entry.id === id)?.payload;

  const importPayload = payloadOf(sectionId.import);
  const importedGlobals =
    importPayload === undefined ? 0 : countImportedGlobals(importPayload);
  const fuelGlobal =
    importedGlobals + countDefinedGlobals(payloadOf(sectionId.global));
  const exportPayload = payloadOf(sectionId.export);
  const memoryPayload = payloadOf(sectionId.memory);
  if (exportPayload === undefined || memoryPayload === undefined) {
    throw new Error("Expected the module to define and export its memory");
  }

  const out: Uint8Array[] = [new Uint8Array(header)];
  let globalWritten = false;
  const writeGlobal = (): void => {
    out.push(section(sectionId.global, addGlobal(payloadOf(sectionId.global))));
    globalWritten = true;
  };
  for (const { id, payload } of sections) {
    // A module without a global section gets one in its place: after
    // memory, before export.
    if (!globalWritten && id > sectionId.global && id !== sectionId.custom) {
      writeGlobal();
    }
    if (id === sectionId.global) {
      writeGlobal();
    } else if (id === sectionId.memory) {
      out.push(
        section(id, capMemory(payload, options.maxMemoryBytes / pageBytes))
      );
    } else if (id === sectionId.export) {
      out.push(section(id, addExport(payload, options.fuelExport, fuelGlobal)));
    } else if (id === sectionId.code) {
      out.push(section(id, meterCode(payload, fuelGlobal)));
    } else {
      out.push(section(id, payload));
    }
  }
  return concat(out);
};
