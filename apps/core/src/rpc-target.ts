import type { RpcAccountingLimits } from "@grasp-os/shared/rpc-accounting";
import { heldPool, rpcCopyNodeBounds } from "@grasp-os/shared/rpc-accounting";
import { boundedRpcTarget } from "@grasp-os/shared/rpc-target";
import { rpcArgumentDepth } from "@grasp-os/shared/screens";

/**
 * The longest message a browser's connection to core takes, in UTF-16 code
 * units. The product's own calls share the connection, and a document, an
 * App's files or an upload are long: this fits the largest a browser sends
 * (a 10 MB upload travels as about 13.3 MiB of base64) with headroom. Lower
 * than Cap'n Web's 32 MiB default on purpose: a core isolate has 128 MB, so
 * even one message of nothing but tiny nodes must survive a single
 * JSON.parse (about 59 MB at this size, measured). The references a message
 * pulls in from earlier ones, and its node count, are bounded on top of
 * this (@grasp-os/shared/rpc-accounting, rpc.ts).
 */
export const browserMessageSize = 14 * 1024 * 1024;

/**
 * What a browser's connection to core may spend: the shared node bounds,
 * with core's message size and what its live exports may hold (rpc.ts).
 *
 * `maxSessionBytes` is what the browser's unreleased pushes and unanswered
 * calls may hold at once, as the accountant estimates their heap: room for
 * two or three 10 MB uploads in flight (each about 10.5 MB held, its bytes
 * decoded), and no more. With one message of the largest kind still being
 * parsed on top (its text plus what it parses into, about 50 MB at worst),
 * one connection stays near 90 MB of a 128 MB isolate at the very most.
 */
export const coreRpcAccounting: RpcAccountingLimits = {
  ...rpcCopyNodeBounds,
  maxMessageBytes: browserMessageSize,
  maxSessionBytes: 32 * 1024 * 1024,
};

/**
 * What a connection that isn't signed in may hold: its API is `ping`,
 * `signInOptions` and `authenticate` (which refuses it), so nothing it may
 * legitimately send holds more than a few bytes. Kept small so many such
 * connections, which anyone can open, hold little between them.
 */
export const signedOutRpcAccounting: RpcAccountingLimits = {
  ...coreRpcAccounting,
  maxSessionBytes: 1024 * 1024,
};

/**
 * What every browser connection served by this isolate may hold together.
 * A Worker isolate has 128 MB and may serve many connections at once, which
 * anyone can open, so each connection's own budget isn't enough: four
 * signed-in connections at 32 MiB each would already be past it. The
 * connection whose message takes the total past this one ends; the others
 * go on. 56 MiB leaves room for one message of the largest kind being
 * parsed (about 50 MB at worst) and the isolate's own work.
 */
export const isolateRpcHeld = heldPool(56 * 1024 * 1024);

/**
 * What every target a browser reaches over core's connection (rpc.ts)
 * extends: each call's arguments arrive as deep and as big as one message
 * of the connection may make them, or are refused (`request.too_deep`,
 * `request.too_large`), however many messages built them.
 */
export const CoreRpcTarget = boundedRpcTarget({
  depth: rpcArgumentDepth,
  size: browserMessageSize,
});
