import { generatedPaths } from "./codegen-contracts.ts";
import { banner } from "./codegen-render.ts";

/**
 * A tree of symbolic references, for inspection only: any path read of it
 * is a reference to that path, which the registration resolves or
 * refuses.
 */
const symbolicTree = "symbolic()";

/**
 * The modules inspection loads in place of `@server/_generated/api` and
 * `@server/_generated/internal` before the App's references exist: the
 * registration is what says which paths there are, so its code
 * gets symbolic references, which grant nothing and resolve only against
 * that registration. Sealing then generates the real modules and builds
 * the code again with them; nothing symbolic survives into a release.
 *
 * Typed `any`, they also stand in for the real modules in a draft's type
 * check while its server code doesn't register (core's save-builds.ts):
 * what imports them is checked for everything else, and the one reason
 * the server code doesn't register is the one error, never one per file
 * that names a reference.
 */
/** The SDK's type the stand-in trees name, imported as a type. */
const standInImport =
  'import type { FunctionReference } from "@grasp-os/runtime";\n';

/**
 * The stand-in trees' type: at every path, a reference that takes and
 * answers `any`, so a call through one (`useQuery`, `ctx.runQuery`) types
 * its answer `any` too, never `unknown`, and nothing that uses it fails
 * for want of the real references. A reference's fields follow its kind,
 * and an `any` kind makes them a query's or a mutation's, never both, so
 * the stand-in also holds a mutation's and an action's `kind` and `args`:
 * it passes for a reference of every kind.
 */
const standInTree = `
type StandIn = FunctionReference<any, any, any, any, any> & { readonly kind: any; readonly args: any } & { readonly [name: string]: StandIn };
`;

export const symbolicModules = (): Record<string, string> => {
  const prelude = `${banner}const symbolic = () => {
  const nodes = new Map<string, object>();
  const node = (path: string): object => {
    const known = nodes.get(path);
    if (known !== undefined) {
      return known;
    }
    const target = Object.freeze({ name: path });
    const made: object = new Proxy(target, {
      get: (_target, name) => {
        if (typeof name !== "string" || name === "then") {
          return undefined;
        }
        if (name === "name") {
          return target.name;
        }
        return node(path === "" ? name : \`\${path}.\${name}\`);
      },
    });
    nodes.set(path, made);
    return made;
  };
  return node("");
};
`;
  return {
    [generatedPaths.internal]: `${standInImport}${prelude}${standInTree}\nexport const internal = ${symbolicTree} as unknown as StandIn;\n`,
    [generatedPaths.api]: `${standInImport}${prelude}${standInTree}\nexport const api = ${symbolicTree} as unknown as StandIn;\nexport const workflows: any = Object.freeze({});\nexport const permissions: any = Object.freeze({});\n`,
  };
};
