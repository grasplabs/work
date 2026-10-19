/** The names an env or a props object holds; none for anything else. */
const named = (value: unknown): string[] =>
  typeof value === "object" && value !== null ? Object.keys(value) : [];

/**
 * The platform's code that reads App source (the App compiler) and package
 * bytes (the package builder) runs in an isolate with no bindings, no
 * importable env and no network (index.ts, `isolateSettings` and
 * `packageBuilderSettings`): it parses, checks and bundles, and needs
 * nothing else. Each entrypoint asserts that as it is called: an isolate
 * handed a binding (a credential, a store, a service), or props on its
 * entrypoint, is a wiring mistake, and the code refuses to work in it
 * rather than hold that authority beside input an App controls.
 */
export const assertNoBindings = (
  env: unknown,
  props: unknown,
  who: string
): void => {
  const bound = [...named(env), ...named(props).map((name) => `props.${name}`)];
  if (bound.length > 0) {
    throw new Error(
      `${who} runs with no bindings, yet its isolate was handed ${bound.toSorted().join(", ")}: it refuses to work there.`
    );
  }
};
