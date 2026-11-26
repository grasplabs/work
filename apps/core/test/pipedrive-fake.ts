/**
 * Where tests set what the Pipedrive fake answers
 * (apps/connect/test/fixtures/pipedrive), and read what it was sent: POST
 * `{ token, account, deals }` to have it take `token` for `account`
 * (`{ id, name, email }`) and list `deals` for it; GET `?token=<token>`
 * for the query and the headers of every request that listed its deals.
 */
export const pipedriveControlUrl = "https://pipedrive-control.test/world";

/**
 * Pipedrive's API, as its generated connector calls it, as far as core's
 * tests use it: `GET /api/v1/users/me` answers the account of the token
 * in `x-api-token`, and `GET /api/v2/deals` the deals a test set for
 * it, in Pipedrive's envelope, each only for a token a test set, 401
 * otherwise.
 *
 * Self-contained, with nothing from outside the function: core's tests
 * run it inside the Worker that stands in for the internet behind connect
 * (test/connect-providers.ts embeds its source).
 */
export const pipedriveFake = () => {
  const accounts = new Map<string, unknown>();
  const deals = new Map<string, unknown>();
  const received = new Map<
    string,
    { query: string; headers: Record<string, string> }[]
  >();
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- self-contained: core's tests embed this function's source
  const field = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null
      ? Reflect.get(value, key)
      : undefined;
  return {
    control: async (request: Request): Promise<Response> => {
      if (request.method !== "POST") {
        const token = new URL(request.url).searchParams.get("token") ?? "";
        return Response.json(received.get(token) ?? []);
      }
      const world: unknown = await request.json();
      const token = field(world, "token");
      if (typeof token === "string") {
        accounts.set(token, field(world, "account"));
        deals.set(token, field(world, "deals"));
      }
      return new Response(null, { status: 204 });
    },
    answer: (request: Request, url: URL): Response | undefined => {
      if (url.hostname !== "api.pipedrive.com") {
        return undefined;
      }
      const token = request.headers.get("x-api-token") ?? "";
      const account = accounts.get(token);
      if (request.method !== "GET") {
        return new Response(null, { status: 405 });
      }
      if (url.pathname === "/api/v2/deals") {
        received.set(token, [
          ...(received.get(token) ?? []),
          { query: url.search, headers: Object.fromEntries(request.headers) },
        ]);
      }
      if (account === undefined) {
        return Response.json(
          { success: false, error: "unauthorized access" },
          { status: 401 }
        );
      }
      if (url.pathname === "/api/v1/users/me") {
        return Response.json({ success: true, data: account });
      }
      if (url.pathname === "/api/v2/deals") {
        return Response.json({
          success: true,
          data: deals.get(token) ?? [],
          additional_data: { next_cursor: null },
        });
      }
      return new Response(null, { status: 404 });
    },
  };
};
