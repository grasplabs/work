import { packageKey } from "@grasp-os/shared/dependencies";
import type { DependencyGraph } from "@grasp-os/shared/dependencies";
import satisfies from "semver/functions/satisfies";
import validRange from "semver/ranges/valid";

// A peer names the range its package asks for and the exact version said
// to meet it. Both are in the graph a person approves, so they must agree:
// a package asking for `^18.0.0` "met" by 19.2.0 would be approved as
// compatible when it says itself it isn't. Checked here, with npm's own
// range rules, and in core only: the frontend shows a graph and never
// judges one.

/**
 * What is wrong with the peers of `graph`, one issue each: a range npm
 * can't read, or a version that doesn't meet the range stated for it. A
 * peer left unmet (no version) states nothing to check.
 */
export const peerIssues = (graph: DependencyGraph): string[] =>
  graph.packages.flatMap((node) =>
    node.peers.flatMap(({ name, range, resolved }) => {
      const of = `packages: ${packageKey(node)}'s peer ${name}`;
      if (validRange(range) === null) {
        return [`${of} states a range that can't be read`];
      }
      // A prerelease meets a range only as npm installs it: on its own
      // version's line.
      return resolved === null || satisfies(resolved, range)
        ? []
        : [`${of} isn't met by ${resolved}`];
    })
  );
