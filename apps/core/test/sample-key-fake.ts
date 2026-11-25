/**
 * Where tests set what connect's sample API-key app answers
 * (apps/connect/test/fixtures/sample-key-connector.ts), and read what it
 * was sent: POST `{ key, account }` to have the app take `key` for
 * `account` (`{ id, name, email }`), and `{ board, answer }` to have
 * listing the board's items answer `answer`; GET `?board=<board>` for the
 * headers of every request that listed the board.
 */
export const sampleKeyControlUrl = "https://sample-key-control.test/world";

/**
 * The sample key app's API, as its connector calls it: `GET /v1/whoami`
 * answers the account of the key in `x-api-key`, and
 * `GET /v1/boards/{board}/items` the board's answer (no items unless a
 * test set one), each only for a key a test set, 401 otherwise.
 *
 * Self-contained, with nothing from outside the function: core's tests
 * run it inside the Worker that stands in for the internet behind connect
 * (test/connect-providers.ts embeds its source).
 */
export const sampleKeyFake = () => {
  const accounts = new Map<string, unknown>();
  const answers = new Map<string, unknown>();
  const received = new Map<string, Record<string, string>[]>();
  const itemsPattern = /^\/v1\/boards\/(?<board>[^/]+)\/items$/u;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const field = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null
      ? Reflect.get(value, key)
      : undefined;
  return {
    control: async (request: Request): Promise<Response> => {
      if (request.method !== "POST") {
        const board = new URL(request.url).searchParams.get("board") ?? "";
        return Response.json(received.get(board) ?? []);
      }
      const world: unknown = await request.json();
      const key: unknown = field(world, "key");
      const board: unknown = field(world, "board");
      if (typeof key === "string") {
        accounts.set(key, field(world, "account"));
      }
      if (typeof board === "string") {
        answers.set(board, field(world, "answer"));
      }
      return new Response(null, { status: 204 });
    },
    answer: (request: Request, url: URL): Response | undefined => {
      if (url.hostname !== "api.sample-key.test") {
        return undefined;
      }
      const account = accounts.get(request.headers.get("x-api-key") ?? "");
      const board = itemsPattern.exec(url.pathname)?.groups?.board;
      if (request.method !== "GET") {
        return new Response(null, { status: 405 });
      }
      if (board !== undefined) {
        const named = decodeURIComponent(board);
        received.set(named, [
          ...(received.get(named) ?? []),
          Object.fromEntries(request.headers),
        ]);
      }
      if (account === undefined) {
        return Response.json({ message: "Unauthorized" }, { status: 401 });
      }
      if (url.pathname === "/v1/whoami") {
        return Response.json({ account });
      }
      if (board === undefined) {
        return new Response(null, { status: 404 });
      }
      return Response.json(
        answers.get(decodeURIComponent(board)) ?? { items: [] }
      );
    },
  };
};
