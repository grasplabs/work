import type { RpcAccountingLimits } from "@grasp-os/shared/rpc-accounting";
import { rpcCopyNodeBounds } from "@grasp-os/shared/rpc-accounting";
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
 * What a browser's connection to core may spend expanding references: the
 * shared node bounds, with core's message size (rpc.ts). Parsed once at the
 * transport and handed to Cap'n Web, so one message is parsed a single time.
 */
export const coreRpcAccounting: RpcAccountingLimits = {
  ...rpcCopyNodeBounds,
  maxMessageBytes: browserMessageSize,
};

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
