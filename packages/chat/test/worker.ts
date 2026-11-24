// The Worker the tests run against: the state object, and nothing of Grasp.
export { ChatState } from "../src/state.ts";

export default {
  fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler;
