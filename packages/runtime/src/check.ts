// `@grasp-os/runtime/check`: the check of a workflow's JavaScript
// expressions (expression-check.ts) and the oxc parser it reads them with
// (oxc-parse.ts), for the compiler and @grasp-os/workflow-schema.

export {
  allowedMethods,
  blockedProperties,
  checkExpression,
  checkRoots,
  expressionRoots,
  runtimeNames,
} from "./expression-check.ts";
export type {
  ExpressionError,
  ExpressionErrorCode,
  ExpressionRead,
} from "./expression-check.ts";
export { parseExpression, parseProgram } from "./oxc-parse.ts";
export type { Comment, Language } from "./oxc-parse.ts";
