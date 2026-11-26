import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { addConnection } from "./connect.ts";

/** The top-level properties an input schema's JSON text names. */
const namesOf = (input = "{}") =>
  Object.keys(
    z
      .object({ properties: z.record(z.string(), z.unknown()) })
      .parse(JSON.parse(input)).properties
  );

/** A connection's tools as a search reads them, or `actions` in full. */
const toolsOf = async (connectionId: string, actions?: string[]) =>
  await exports.default.connectionTools({
    connectionId,
    ...(actions === undefined ? {} : { actions }),
  });

describe("a connection's tools, as the chat's tool search reads them", () => {
  it("are a native connection's as its manifest says: their types alone for a search, in full where named", async () => {
    const native = await addConnection({
      provider: "microsoft",
      serverKind: "native",
      server: "microsoft-365",
    });
    const searched = await toolsOf(native);
    const send = searched.find(({ name }) => name === "mail.send");
    const [full] = await toolsOf(native, ["mail.send"]);

    expect({
      searched: {
        described: (send?.description ?? "") !== "",
        smaller: (send?.input.length ?? 0) < (full?.input.length ?? 0),
        output: send?.output,
      },
      full: {
        name: full?.name,
        description: full?.description === send?.description,
        output: full?.output === null ? null : "served",
      },
      sameNames:
        namesOf(send?.input).join(",") === namesOf(full?.input).join(","),
    }).toStrictEqual({
      searched: { described: true, smaller: true, output: null },
      full: { name: "mail.send", description: true, output: "served" },
      sameNames: true,
    });
  });

  it("are none of a connection no manifest describes, or of one that's gone", async () => {
    const http = await addConnection({
      provider: "http",
      serverKind: "http",
      server: "https://api.acme-billing.test",
    });
    const gone = await addConnection({
      provider: "microsoft",
      serverKind: "native",
      server: "microsoft-365",
      status: "disconnected",
    });

    expect({
      http: await toolsOf(http),
      gone: await toolsOf(gone),
    }).toStrictEqual({ http: [], gone: [] });
  });
});
