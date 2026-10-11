import { boundedRpcTarget } from "@grasp-os/shared/rpc-target";
import { rpcArgumentDepth } from "@grasp-os/shared/screens";

/**
 * The longest message a browser's connection to core takes, in UTF-16 code
 * units: Cap'n Web's own default, named so what a call may hold can't
 * drift from it. The product's own calls share the connection, and a
 * document or an App's files are long.
 */
export const browserMessageSize = 32 * 1024 * 1024;

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
