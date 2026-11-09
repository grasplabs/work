/** What the tests of sealed runs on the run host share (sealed-run*.test.ts). */

/** Task `id`'s own step, recording `record`, with `options` besides. */
export const taskStep = (id: string, record: string, options = ""): string =>
  `await step.do(${JSON.stringify(id)}, { key: "task", description: "Its task"${options} }, async () => (${record}))`;
