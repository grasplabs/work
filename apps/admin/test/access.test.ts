import { env, exports } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vite-plus/test";

import worker from "../src/server.ts";
import { accessTeam } from "./access-config.ts";
import { accessJwt, mockAccess } from "./access.ts";

mockAccess();

const origin = "https://ops.grasp.test";
const staffEmail = "staff@grasp.test";

/** A request to the admin carrying `jwt` as Access would, and `init`. */
const asStaff = (path: string, jwt: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", jwt);
  return new Request(`${origin}${path}`, { ...init, headers });
};

/** The status the admin answers `request` with, on an env with `changes`. */
const statusOf = async (request: Request, changes: Partial<Env> = {}) => {
  const response = await worker.fetch(request, { ...env, ...changes });
  return response.status;
};

describe("the Access JWT", () => {
  it("lets a staff member with a valid JWT in", async () => {
    const response = await exports.default.fetch(
      asStaff("/", await accessJwt(staffEmail))
    );
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain("Organizations");
  });

  it("refuses every path without one, server functions and unknown pages included", async () => {
    const paths = ["/", "/_serverFn/anything", "/clients/unknown"];
    const statuses = await Promise.all(
      paths.map(async (path) => {
        const response = await exports.default.fetch(`${origin}${path}`);
        return response.status;
      })
    );
    expect(statuses).toStrictEqual(paths.map(() => 403));
  });

  it("refuses a JWT Access didn't issue for the admin", async () => {
    const forged = await Promise.all([
      accessJwt(staffEmail, { stranger: true }),
      accessJwt(staffEmail, { claims: { aud: ["another-access-app"] } }),
      accessJwt(staffEmail, {
        claims: { iss: "https://attacker.cloudflareaccess.com" },
      }),
      accessJwt(staffEmail, { expiresIn: -60 }),
    ]);
    const statuses = await Promise.all(
      forged.map(async (jwt) => await statusOf(asStaff("/", jwt)))
    );
    expect(statuses).toStrictEqual([403, 403, 403, 403]);
  });

  it("refuses a JWT whose claims were changed after signing", async () => {
    const jwt = await accessJwt(staffEmail);
    const [header, , signature] = jwt.split(".");
    const payload = btoa(
      JSON.stringify({
        email: "admin@grasp.test",
        iss: accessTeam.issuer,
        aud: [accessTeam.audience],
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).replaceAll("=", "");
    const unsigned = `${btoa(JSON.stringify({ alg: "none" })).replaceAll("=", "")}.${payload}.`;
    const statuses = await Promise.all([
      statusOf(asStaff("/", `${header}.${payload}.${signature}`)),
      statusOf(asStaff("/", unsigned)),
    ]);
    expect(statuses).toStrictEqual([403, 403]);
  });

  it("refuses a JWT that names no person, such as a service token's", async () => {
    const jwt = await accessJwt(staffEmail, {
      claims: { email: undefined, common_name: "ci.access" },
    });
    await expect(statusOf(asStaff("/", jwt))).resolves.toBe(403);
  });

  it("refuses everything while Access isn't configured", async () => {
    const jwt = await accessJwt(staffEmail);
    const statuses = await Promise.all([
      statusOf(asStaff("/", jwt), { CF_ACCESS_AUD: undefined }),
      statusOf(asStaff("/", jwt), { CF_ACCESS_ISS: "" }),
    ]);
    expect(statuses).toStrictEqual([403, 403]);
  });
});

describe("the local dev bypass", () => {
  const dev = { DEV_ACCESS_EMAIL: "dev@grasp.test" };

  it("lets requests to this machine in without a JWT", async () => {
    const statuses = await Promise.all(
      [
        "http://localhost:3000/",
        "http://127.0.0.1:3000/",
        "http://[::1]:3000/",
      ].map(async (url) => await statusOf(new Request(url), dev))
    );
    expect(statuses).toStrictEqual([200, 200, 200]);
  });

  it("refuses everything anywhere else, even with a valid JWT", async () => {
    const jwt = await accessJwt(staffEmail);
    const statuses = await Promise.all([
      statusOf(new Request(`${origin}/`), dev),
      statusOf(asStaff("/", jwt), dev),
      statusOf(new Request("http://localhost.attacker.test/"), dev),
    ]);
    expect(statuses).toStrictEqual([403, 403, 403]);
  });
});

describe("cross-site requests", () => {
  it("refuses a server function called without TanStack's header, even a GET", async () => {
    const jwt = await accessJwt(staffEmail);
    const statuses = await Promise.all([
      statusOf(asStaff("/_serverFn/anything?payload=x", jwt)),
      statusOf(
        asStaff("/_serverFn/anything", jwt, {
          method: "POST",
          headers: { origin },
        })
      ),
      statusOf(
        asStaff("/_serverFn/anything", jwt, {
          headers: { "x-tsr-serverFn": "false" },
        })
      ),
    ]);
    expect(statuses).toStrictEqual([403, 403, 403]);
  });

  it("lets the admin's own client call a server function", async () => {
    const jwt = await accessJwt(staffEmail);
    const status = await statusOf(
      asStaff("/_serverFn/anything", jwt, {
        method: "POST",
        headers: { origin, "x-tsr-serverFn": "true" },
      })
    );
    // Past the check, TanStack Start answers: no such server function.
    expect(status).toBe(500);
  });

  it("refuses a state change from another origin, or none", async () => {
    const jwt = await accessJwt(staffEmail);
    const statuses = await Promise.all([
      statusOf(
        asStaff("/_serverFn/anything", jwt, {
          method: "POST",
          headers: { origin: "https://attacker.test" },
        })
      ),
      statusOf(asStaff("/_serverFn/anything", jwt, { method: "POST" })),
      statusOf(
        asStaff("/_serverFn/anything", jwt, {
          method: "DELETE",
          headers: { origin: "http://ops.grasp.test" },
        })
      ),
    ]);
    expect(statuses).toStrictEqual([403, 403, 403]);
  });

  it("lets the admin's own pages change state", async () => {
    const jwt = await accessJwt(staffEmail);
    const response = await worker.fetch(
      asStaff("/ask", jwt, { method: "POST", headers: { origin } }),
      env
    );
    expect(response.status).toBe(200);
  });

  it("lets a link from another site open a page", async () => {
    const jwt = await accessJwt(staffEmail);
    const response = await worker.fetch(
      asStaff("/ask", jwt, {
        headers: { origin: "https://elsewhere.test" },
      }),
      env
    );
    expect(response.status).toBe(200);
  });
});

/** A signing key Access could publish, under key id `kid`. */
const signingKey = async (kid: string) => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  return {
    kid,
    privateKey: keys.privateKey,
    jwk: {
      ...(await exportJWK(keys.publicKey)),
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
};
type SigningKey = Awaited<ReturnType<typeof signingKey>>;

/** A JWT as `issuer`'s Access team would sign it with `key`. */
const signedBy = async (issuer: string, key: SigningKey): Promise<string> =>
  await new SignJWT({
    email: staffEmail,
    sub: `sub-${staffEmail}`,
    iss: issuer,
    aud: [accessTeam.audience],
  })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key.privateKey);

/**
 * A team of its own, so its keys are in no cache yet, serving `published`
 * at its keys URL as they stand when asked; each fetch counted.
 */
const freshTeam = (published: { current: SigningKey[]; failing?: boolean }) => {
  const issuer = `https://team-${crypto.randomUUID().slice(0, 8)}.cloudflareaccess.com`;
  const fetches = { count: 0 };
  const earlier = vi.mocked(globalThis.fetch).getMockImplementation();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const { url } = new Request(input, init);
    if (url === `${issuer}/cdn-cgi/access/certs`) {
      fetches.count += 1;
      if (published.failing === true) {
        return new Response("unavailable", { status: 503 });
      }
      return Response.json({ keys: published.current.map(({ jwk }) => jwk) });
    }
    if (earlier === undefined) {
      throw new Error(`Unexpected outbound request to ${url}`);
    }
    return await earlier(input, init);
  });
  return { issuer, fetches };
};

describe("the Access signing keys", () => {
  it("verifies with keys no request fetched yet, every request at once doing so in its own right", async () => {
    const key = await signingKey("first");
    const { issuer } = freshTeam({ current: [key] });
    const jwt = await signedBy(issuer, key);

    const statuses = await Promise.all(
      Array.from(
        { length: 5 },
        async () => await statusOf(asStaff("/", jwt), { CF_ACCESS_ISS: issuer })
      )
    );

    expect(statuses).toStrictEqual([200, 200, 200, 200, 200]);
  });

  it("fetches the keys again once when a JWT names a key it hasn't kept, as after Access rotates them, and keeps them", async () => {
    const before = await signingKey("before");
    const after = await signingKey("after");
    const published = { current: [before] };
    const { issuer, fetches } = freshTeam(published);
    const on = { CF_ACCESS_ISS: issuer };

    const first = await statusOf(
      asStaff("/", await signedBy(issuer, before)),
      on
    );
    const fetchedFirst = fetches.count;
    const kept = await statusOf(
      asStaff("/", await signedBy(issuer, before)),
      on
    );
    const fetchedKept = fetches.count;
    // Access rotates: a JWT under the new key.
    published.current = [after];
    const rotated = await statusOf(
      asStaff("/", await signedBy(issuer, after)),
      on
    );
    const fetchedRotated = fetches.count;
    const again = await statusOf(
      asStaff("/", await signedBy(issuer, after)),
      on
    );

    expect({
      statuses: [first, kept, rotated, again],
      fetches: [fetchedFirst, fetchedKept, fetchedRotated, fetches.count],
    }).toStrictEqual({
      statuses: [200, 200, 200, 200],
      fetches: [1, 1, 2, 2],
    });
  });

  it("refuses JWTs under a key Access doesn't publish, fetching the keys again at most once in its cooldown", async () => {
    const published = await signingKey("published");
    const unknown = await signingKey("unknown");
    const { issuer, fetches } = freshTeam({ current: [published] });
    const on = { CF_ACCESS_ISS: issuer };
    await statusOf(asStaff("/", await signedBy(issuer, published)), on);

    const forged = await signedBy(issuer, unknown);

    const refused = await statusOf(asStaff("/", forged), on);
    const fetchedFirst = fetches.count;
    // Another forged JWT within the cooldown: refused, fetching nothing.
    const refusedAgain = await statusOf(asStaff("/", forged), on);

    expect({
      refused: [refused, refusedAgain],
      fetches: [fetchedFirst, fetches.count],
    }).toStrictEqual({
      refused: [403, 403],
      fetches: [2, 2],
    });
  });

  it("fetches the keys once for forged JWTs sent at once, the first starting the cooldown before its fetch", async () => {
    const published = await signingKey("published");
    const unknown = await signingKey("unknown");
    const { issuer, fetches } = freshTeam({ current: [published] });
    const on = { CF_ACCESS_ISS: issuer };
    await statusOf(asStaff("/", await signedBy(issuer, published)), on);
    const forged = await signedBy(issuer, unknown);

    const statuses = await Promise.all(
      Array.from(
        { length: 5 },
        async () => await statusOf(asStaff("/", forged), on)
      )
    );

    expect({ statuses, fetches: fetches.count }).toStrictEqual({
      statuses: [403, 403, 403, 403, 403],
      fetches: 2,
    });
  });

  it("starts the cooldown with a refetch that fails, so the next forged JWT fetches nothing", async () => {
    const published = await signingKey("published");
    const unknown = await signingKey("unknown");
    const team: { current: SigningKey[]; failing?: boolean } = {
      current: [published],
    };
    const { issuer, fetches } = freshTeam(team);
    const on = { CF_ACCESS_ISS: issuer };
    await statusOf(asStaff("/", await signedBy(issuer, published)), on);
    const forged = await signedBy(issuer, unknown);
    team.failing = true;

    const first = await statusOf(asStaff("/", forged), on);
    const fetchedFirst = fetches.count;
    const second = await statusOf(asStaff("/", forged), on);

    expect({
      statuses: [first, second],
      fetches: [fetchedFirst, fetches.count],
    }).toStrictEqual({ statuses: [403, 403], fetches: [2, 2] });
  });
});
