/**
 * A module whose load ends only once the test importing it lets it go
 * (open-sockets.test.ts): a module still loading, as one whose first
 * import never ends is.
 */
import { heldModule } from "./held-module-gate.ts";

await heldModule.promise;
