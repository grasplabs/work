/**
 * An outside API an admin approves as an HTTP connection (connect's
 * src/http-connections.ts), and the DNS answers that let them: a small
 * billing API at `outsideApiOrigin`, whose name resolves to a public
 * address, beside `outsideApiInsideOrigin`, whose name resolves to a
 * private one, so approving it is refused.
 *
 * - `GET /v1/invoices` lists invoices.
 * - `POST /v1/invoices` answers 201 with what it was sent.
 * - `/v1/moved` redirects off the origin.
 * - `/v1/slow` answers as `/v1/invoices` does, `slowMs` later: a call
 *   that is under way for a while.
 * - `/v1/dropped` takes the request and never answers it: `answer`
 *   throws, as a fetch whose connection was lost does. A write there may
 *   have been done, and nobody was told.
 * - Anything else is a 404.
 *
 * Self-contained, with nothing from outside the function: core's tests
 * run it inside the Worker that stands in for the internet behind connect
 * (core's test/connect-providers.ts embeds its source), and `vp run dev`
 * runs it in connect itself (dev-entry.ts).
 */
export const outsideApiOrigin = "https://api.acme-billing.test";
export const outsideApiInsideOrigin = "https://inside.acme-billing.test";

/**
 * How long `/v1/slow` takes: long enough to watch, and under the time one
 * call gets (`httpLimits.timeoutMs`), so its answer still arrives.
 */
export const outsideApiSlowMs = 10_000;

/* oxlint-disable unicorn/consistent-function-scoping -- self-contained, see the header */
export const outsideApiFake = ({
  origin,
  insideOrigin,
  slowMs,
}: {
  origin: string;
  insideOrigin: string;
  slowMs: number;
}) => {
  /** What reached the API, in order. */
  const calls: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }[] = [];
  /** The addresses the resolver answers each name with. */
  const addresses = new Map([
    [new URL(origin).hostname, "93.184.216.34"],
    [new URL(insideOrigin).hostname, "10.0.0.7"],
  ]);

  const invoices = (method: string, body: string): Response => {
    if (method !== "POST") {
      return Response.json({ invoices: [{ id: "inv-1", amount: 10 }] });
    }
    const created: unknown = JSON.parse(body);
    return Response.json({ created }, { status: 201 });
  };

  return {
    calls,
    /** The API's answer to `request`, which it keeps in `calls`. */
    answer: async (request: Request, url: URL): Promise<Response> => {
      const body = await request.text();
      calls.push({
        url: url.href,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body,
      });
      if (url.pathname === "/v1/moved") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://collector.test/steal" },
        });
      }
      if (url.pathname === "/v1/invoices") {
        return invoices(request.method, body);
      }
      if (url.pathname === "/v1/slow") {
        await scheduler.wait(slowMs);
        return invoices(request.method, body);
      }
      if (url.pathname === "/v1/dropped") {
        throw new TypeError("Network connection lost.");
      }
      return new Response("not found", { status: 404 });
    },
    /**
     * DNS over HTTPS, as connect asks Cloudflare's resolver (`url`), for
     * one of the two names; undefined for any other name.
     */
    dns: (url: URL): Response | undefined => {
      const name = url.searchParams.get("name") ?? "";
      const address = addresses.get(name);
      if (address === undefined) {
        return undefined;
      }
      return Response.json({
        Status: 0,
        Answer:
          url.searchParams.get("type") === "A"
            ? [{ name, type: 1, TTL: 60, data: address }]
            : [],
      });
    },
  };
};
