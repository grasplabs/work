/**
 * Runs independent steps at once that would otherwise run one after
 * another, and settles as they would have: with their values in order,
 * or with the first failure in that order, so which refusal is said
 * first never depends on which step answered first. Settles only once
 * every step has, so none is left running unwatched.
 */
export const allInOrder = async <T extends readonly unknown[] | []>(
  steps: T
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> => {
  const settled = await Promise.allSettled(steps);
  const failed = settled.findIndex(({ status }) => status === "rejected");
  if (failed !== -1) {
    // Rethrows the first failure in order, as it was.
    await steps[failed];
  }
  return await Promise.all(steps);
};
