/** Lets held-module.ts finish loading (open-sockets.test.ts). */
export const heldModule = Promise.withResolvers<"go">();
