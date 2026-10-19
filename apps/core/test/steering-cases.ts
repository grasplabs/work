// What would steer a type check rather than be checked by it, as code of
// a kind whose types are checked holds none (packages/compiler,
// `typeChecked`): triple-slash directives, which reach the whole program;
// suppressions, in every spelling and after every kind of line break; and
// ambient declarations, of globals or of a module of the SDK the code
// imports (`sdkModule`). Each must be refused before the type check reads
// it, in App workflows and compute modules alike.

/** The steering cases, each a name and a file's source. */
export const steeringCases = (
  sdkModule: string
): (readonly [string, string])[] => [
  [
    "a reference path into the kit",
    '/// <reference path="../../node_modules/@grasp-os/sdk/src/client.ts" />\nexport const extra = 1;\n',
  ],
  [
    "a lib it references, the DOM's",
    '/// <reference lib="dom" />\nexport const title = (): string => document.title;\n',
  ],
  [
    "a types reference",
    '/// <reference types="node" />\nexport const extra = 1;\n',
  ],
  [
    "a line the type check is told to ignore",
    "// @ts-ignore\nexport const title = (): string => document.title;\n",
  ],
  [
    "an error the type check is told to expect",
    "// @ts-expect-error\nexport const title = (): string => document.title;\n",
  ],
  [
    "an error the type check is told to expect, on a block comment's last line",
    "/* Expected:\n @ts-expect-error */\nexport const title = (): string => document.title;\n",
  ],
  [
    "a line the type check is told to ignore, after a carriage return in a block comment",
    "/* x\r @ts-ignore */\nexport const title = (): string => document.title;\n",
  ],
  [
    "an error the type check is told to expect, after a line separator in a block comment",
    "/* x\u2028 @ts-expect-error */\nexport const title = (): string => document.title;\n",
  ],
  [
    "an error the type check is told to expect, after a paragraph separator in a block comment",
    "/* x\u2029 @ts-expect-error */\nexport const title = (): string => document.title;\n",
  ],
  [
    "a file the type check is told to skip",
    "// @ts-nocheck\nexport const title = (): string => document.title;\n",
  ],
  [
    "a file the type check is told to skip, in another case",
    "// @ts-NoCheck\nexport const title = (): string => document.title;\n",
  ],
  [
    "an ambient module that adds to the SDK's, which a file then reads",
    `import { leak } from "${sdkModule}";\n\ndeclare module "${sdkModule}" {\n  export const leak: number;\n}\nexport const extra: number = leak;\n`,
  ],
  [
    "globals it declares for every file",
    "export {};\ndeclare global {\n  var document: { title: string };\n}\n",
  ],
];
