import type { Memory, Reader } from "./contract.ts";

/**
 * An instruction is only ever its writer's own (contract.ts v4): one is
 * found for its writer alone, never handed to anyone else's agent, even
 * where the store would let another read it. `m` is the memory, `?2` the
 * reader.
 */
export const writersOwnSql = `(
  (m.type != 'instruction' AND coalesce(m.attribute, '') != 'instruction')
  OR m.writer = ?2
)`;

/** `writersOwnSql`, for a memory already read. */
export const isWritersOwn = (
  { type, attribute, writer }: Memory,
  reader: Reader
): boolean =>
  (type !== "instruction" && attribute !== "instruction") ||
  writer === reader.person;
