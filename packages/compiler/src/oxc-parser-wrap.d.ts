// oxc-parser ships its result wrapper (`wrap`, which its own `parseSync`
// runs over the binding's result) without types. This covers what the
// compiler uses of it.
declare module "oxc-parser/src-js/wrap" {
  import type { Comment, OxcError } from "@oxc-parser/binding-wasm32-wasip1";

  export const wrap: (result: unknown) => {
    /** The TS-ESTree program, parsed from the binding's JSON on first read. */
    readonly program: unknown;
    readonly comments: Comment[];
    readonly errors: OxcError[];
  };
}
