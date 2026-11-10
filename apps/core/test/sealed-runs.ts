/** What the tests of sealed runs on the run host share (sealed-run*.test.ts). */

/** Task `id`'s own step, recording `record`, with `options` besides. */
export const taskStep = (id: string, record: string, options = ""): string =>
  `await step.do(${JSON.stringify(id)}, { key: "task", description: "Its task"${options} }, async () => (${record}))`;

/**
 * A step of task `id` whose code fails: with its data's own failure,
 * which the host keeps (`workflow.task_data_invalid`), or with an error
 * of the code's own, which it takes as `internal.unexpected`.
 */
export const failingStep = (id: string, options = "", data = true): string =>
  taskStep(
    id,
    data
      ? '(() => { const error = new Error("x"); error.code = "workflow.task_data_invalid"; throw error; })()'
      : '(() => { throw new Error("down"); })()',
    options
  );
