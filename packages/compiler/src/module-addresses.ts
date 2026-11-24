import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import { parse } from "es-module-lexer/js";

// Where each of an App's page modules is served: an address of its
// content, the way Vite's dev server serves a module, so a browser that
// loaded one never loads it again, and a write loads only what it changed.
// Each module imports the App's others by their addresses, relative to
// its own (`./<address>.js`), so a changed file changes its address and
// that of every module importing it, up to its page, and nothing else:
// a chat's preview loads only that chain for each write (core's
// page-frame.ts). The kit's modules keep their flat names, which the
// frame's import map resolves.
//
// Modules may import each other in a cycle, which no address can hold of
// its own: an address names the content, and that content names the
// other's address. So the modules of each cycle (a strongly connected
// component of the import graph) are addressed together: the digest of
// their code and of the addresses of what they import outside it, each
// with its own name. A module in no cycle is a component of one, so the
// same rule addresses every module.
//
// The lexer is the one Vite rewrites imports with; its JavaScript build,
// since an isolate can't compile WebAssembly of its own.

/** The addressed modules: each one's code, importing the others by address. */
export interface AddressedModules {
  modules: Record<string, string>;
  /** Each module's address, by flat name. */
  addresses: Record<string, string>;
}

/** Where an import names a module of the App: its span, and the module. */
interface Site {
  start: number;
  end: number;
  /** Whether the span holds a string literal (an `import()`), not its text. */
  quoted: boolean;
  name: string;
}

/** The imports of `code` that name one of `names`, in order. */
const sitesIn = (code: string, names: ReadonlySet<string>): Site[] => {
  const [imports] = parse(code);
  // An `import()`'s span is its argument, quotes and all; a static
  // import's, the specifier's text alone.
  return imports.flatMap(({ specifier, start, end, type }) =>
    typeof specifier === "string" && names.has(specifier)
      ? [{ start, end, quoted: type === "dynamic", name: specifier }]
      : []
  );
};

/** `code` with each of `sites` pointing at its module's address. */
const pointed = (
  code: string,
  sites: readonly Site[],
  addresses: ReadonlyMap<string, string>
): string => {
  let text = "";
  let at = 0;
  for (const { start, end, quoted, name } of sites) {
    const specifier = `./${addresses.get(name) ?? ""}.js`;
    text += code.slice(at, start);
    text += quoted ? JSON.stringify(specifier) : specifier;
    at = end;
  }
  return text + code.slice(at);
};

/**
 * The strongly connected components of the graph `edges`, each sorted,
 * in the order Tarjan's algorithm finds them: a component comes after
 * every component it reaches, so each can be addressed in turn.
 */
const components = (
  edges: ReadonlyMap<string, readonly string[]>
): string[][] => {
  const found: string[][] = [];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (node: string): void => {
    index.set(node, index.size);
    low.set(node, index.get(node) ?? 0);
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member !== undefined) {
          onStack.delete(member);
          component.push(member);
        }
      } while (member !== undefined && member !== node);
      found.push(component.toSorted());
    }
  };
  for (const node of [...edges.keys()].toSorted()) {
    if (!index.has(node)) {
      visit(node);
    }
  }
  return found;
};

/**
 * `modules` (compiled, importing each other by flat name) at their
 * addresses: deterministic, so the same modules always have the same
 * addresses and code, whatever order they come in.
 */
export const addressModules = async (
  modules: Readonly<Record<string, string>>
): Promise<AddressedModules> => {
  const names = new Set(Object.keys(modules));
  const sites = new Map(
    [...names].map((name) => [name, sitesIn(modules[name] ?? "", names)])
  );
  const edges = new Map(
    [...sites].map(([name, found]) => [
      name,
      [...new Set(found.map((site) => site.name))],
    ])
  );
  const addresses = new Map<string, string>();
  for (const component of components(edges)) {
    const members = new Set(component);
    const outside = [
      ...new Set(
        component.flatMap((name) =>
          (edges.get(name) ?? []).filter((next) => !members.has(next))
        )
      ),
    ].toSorted();
    // oxlint-disable-next-line no-await-in-loop -- each after what it imports
    const digest = await sha256Hex(
      canonicalJson([
        component.map((name) => [name, modules[name] ?? ""]),
        outside.map((name) => [name, addresses.get(name) ?? ""]),
      ])
    );
    for (const name of component) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      addresses.set(name, await sha256Hex(canonicalJson([digest, name])));
    }
  }
  return {
    modules: Object.fromEntries(
      [...sites].map(([name, found]) => [
        name,
        pointed(modules[name] ?? "", found, addresses),
      ])
    ),
    addresses: Object.fromEntries(addresses),
  };
};
