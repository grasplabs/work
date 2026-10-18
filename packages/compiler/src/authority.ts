/**
 * The platform's code that reads App source (the App compiler) and package
 * bytes (the package builder) runs in an isolate with no bindings, no
 * importable env and no network (index.ts, `isolateSettings` and
 * `packageBuilderSettings`): it parses, checks and bundles, and needs
 * nothing else. Each entrypoint asserts that as it is called: an isolate
 * handed a binding (a credential, a store, a service) is a wiring mistake,
 * and the code refuses to work in it rather than hold that authority
 * beside input an App controls.
 */
export const assertNoBindings = (env: unknown, who: string): void => {
  const bound = typeof env === "object" && env !== null ? Object.keys(env) : [];
  if (bound.length > 0) {
    throw new Error(
      `${who} runs with no bindings, yet its isolate was handed ${bound.toSorted().join(", ")}: it refuses to work there.`
    );
  }
};
