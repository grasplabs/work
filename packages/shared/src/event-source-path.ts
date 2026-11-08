// Where an event source takes deliveries (core's workflows/source-events.ts),
// apart and with nothing imported: the router limits requests to it
// (apps/router) without loading the sources' schemas.

/**
 * Where event sources take deliveries: `<path>/<token>`, each token 128
 * random bits of its source's own.
 */
export const eventSourcePath = "/api/hooks";
