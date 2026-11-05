/**
 * The rules of Ultracite's oxlint presets that App code is never held to,
 * beyond those with no equivalent the isolate runs: Grasp leaves them out
 * (ultracite-rules.ts `unmapped`), and so does an exported App's own
 * oxlint. Each was run over the repo's own TypeScript, the 3,347 files
 * its oxlint lints and passes, and reported the findings below (November
 * 2026).
 */

/**
 * The rules whose ESLint version, which Grasp's isolate runs, disagrees
 * with oxlint's, by oxlint's name. They read code differently (React
 * Compiler bailouts as `react/todo`, a function declaration as one
 * `func-style` forbids), or report at another line than oxlint, so a
 * disable comment written for oxlint misses them.
 */
export const disagreeing: Readonly<Record<string, number>> = {
  "func-style": 440,
  "jsx-a11y/anchor-has-content": 1,
  "jsx-a11y/control-has-associated-label": 4,
  "jsx-a11y/no-aria-hidden-on-focusable": 9,
  "jsx-a11y/no-noninteractive-element-interactions": 2,
  "jsx-a11y/no-noninteractive-tabindex": 1,
  "jsx-a11y/no-static-element-interactions": 3,
  "jsx-a11y/prefer-tag-over-role": 14,
  "no-div-regex": 5,
  "no-irregular-whitespace": 2,
  "no-lone-blocks": 1,
  "no-unused-vars": 36,
  "prefer-destructuring": 39,
  "promise/prefer-catch": 74,
  "react/function-component-definition": 414,
  "react/jsx-no-constructed-context-values": 5,
  "react/jsx-no-target-blank": 1,
  "react/no-set-state": 1,
  "react/style-prop-object": 10,
  "react/todo": 601,
  "require-await": 1,
  "unicorn/consistent-function-scoping": 204,
  "unicorn/custom-error-definition": 51,
  "unicorn/new-for-builtins": 1,
  "unicorn/no-await-in-promise-methods": 44,
  "unicorn/no-negated-condition": 42,
  "unicorn/no-useless-length-check": 1,
  "unicorn/no-useless-promise-resolve-reject": 590,
  "unicorn/no-useless-undefined": 33,
  "unicorn/prefer-array-some": 1,
  "unicorn/prefer-default-parameters": 284,
  "unicorn/prefer-includes": 57,
  "unicorn/prefer-logical-operator-over-ternary": 10,
  "unicorn/prefer-math-min-max": 8,
  "unicorn/prefer-number-coercion": 1,
  "unicorn/prefer-object-from-entries": 1,
  "unicorn/prefer-regexp-test": 2,
  "unicorn/prefer-set-has": 2,
  "unicorn/prefer-string-replace-all": 21,
  "unicorn/prefer-ternary": 344,
  "unicorn/require-post-message-target-origin": 27,
  "vars-on-top": 2,
};

/**
 * sonarjs's rules that would be noise: the repo's own code, which doesn't
 * hold itself to them, gets them that often. A hint that common is one
 * the agent learns to pass over.
 */
export const noisy: Readonly<Record<string, number>> = {
  "sonarjs/array-constructor": 1,
  "sonarjs/bool-param-default": 5,
  "sonarjs/code-eval": 4,
  "sonarjs/cognitive-complexity": 94,
  "sonarjs/constructor-for-side-effects": 3,
  "sonarjs/destructuring-assignment-syntax": 2,
  "sonarjs/expression-complexity": 466,
  "sonarjs/function-name": 202,
  "sonarjs/max-union-size": 193,
  "sonarjs/misplaced-loop-counter": 11,
  "sonarjs/no-all-duplicated-branches": 1,
  "sonarjs/no-built-in-override": 39,
  "sonarjs/no-clear-text-protocols": 36,
  "sonarjs/no-dead-store": 4,
  "sonarjs/no-duplicate-string": 834,
  "sonarjs/no-duplicated-branches": 8,
  "sonarjs/no-empty-collection": 4,
  "sonarjs/no-empty-test-file": 4,
  "sonarjs/no-hardcoded-ip": 37,
  "sonarjs/no-hardcoded-secrets": 2,
  "sonarjs/no-identical-functions": 23,
  "sonarjs/no-incomplete-assertions": 15,
  "sonarjs/no-invariant-returns": 3,
  "sonarjs/no-inverted-boolean-check": 4,
  "sonarjs/no-nested-assignment": 3,
  "sonarjs/no-nested-conditional": 44,
  "sonarjs/no-nested-functions": 4,
  "sonarjs/no-nested-template-literals": 200,
  "sonarjs/no-os-command-from-path": 33,
  "sonarjs/no-redundant-assignments": 2,
  "sonarjs/no-undefined-assignment": 1182,
  "sonarjs/no-unused-collection": 1,
  "sonarjs/no-unused-function-argument": 15,
  "sonarjs/no-unused-vars": 142,
  "sonarjs/no-use-of-empty-return-value": 1,
  "sonarjs/no-wildcard-import": 58,
  "sonarjs/pseudo-random": 42,
  "sonarjs/publicly-writable-directories": 3,
  "sonarjs/redundant-type-aliases": 7,
  "sonarjs/too-many-break-or-continue-in-loop": 96,
  "sonarjs/updated-loop-counter": 2,
  "sonarjs/use-type-alias": 12,
  "sonarjs/variable-name": 19,
};
