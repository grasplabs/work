/**
 * Loaded first (`node --import`) by the release scripts' tests, which run
 * each script in a Node of its own: the scripts trust the tests' signing
 * key (packages/shared/test/release-signing-keys.ts) in place of
 * production's, as the admin's tests do through an alias. Never loaded
 * outside the tests.
 */
import { registerHooks } from "node:module";

const testKeys = new URL(
  "../../packages/shared/test/release-signing-keys.ts",
  import.meta.url
).href;

registerHooks({
  resolve: (specifier, context, nextResolve) =>
    nextResolve(
      specifier === "@grasp-os/shared/release-signing-keys"
        ? testKeys
        : specifier,
      context
    ),
});
