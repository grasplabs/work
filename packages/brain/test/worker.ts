// The Worker the tests run in: it serves nothing. The tests call the
// Brain's modules directly, with the bindings the config gives it.
export default {
  fetch: (): Response => new Response(null, { status: 404 }),
};
