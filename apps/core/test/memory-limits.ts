import { memoryLimits } from "@grasp-os/shared/memory";
import type { MemoryFileName } from "@grasp-os/shared/memory";

/**
 * Runs `run` with `name`'s limit lowered to `tokens`, as a release that
 * lowered it would: a file saved within the old limit is over the new one.
 */
export const withLoweredLimit = async <T>(
  name: MemoryFileName,
  tokens: number,
  run: () => Promise<T>
): Promise<T> => {
  const limit = memoryLimits[name];
  Reflect.set(memoryLimits, name, tokens);
  try {
    return await run();
  } finally {
    Reflect.set(memoryLimits, name, limit);
  }
};
