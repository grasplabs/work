import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import worker from "../src/server.ts";
import { accessJwt, mockAccess } from "./access.ts";
import { page } from "./pages.ts";

mockAccess();

const origin = "https://console.grasp.test";
const adminHost = "admin.grasp.test";

/** A staff member's request to `path`, as Access would pass it on. */
const asStaff = async (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", await accessJwt("staff@grasp.test"));
  return new Request(`${origin}${path}`, { ...init, headers });
};

/** How the console answers `request`, its admin on `host` ("" for none). */
const answer = async (request: Request, host = "") =>
  await worker.fetch(request, { ...env, ADMIN_HOST: host });

/** Where the console sends a staff member's page load of `path`, and how. */
const movedTo = async (path: string) => {
  const response = await answer(await asStaff(path));
  return {
    status: response.status,
    location: response.headers.get("location"),
  };
};

describe("the console's releases and rollouts, moved under the admin's Platform", () => {
  it("send their old addresses to the admin's for good, the path below and the query kept", async () => {
    const rolloutId = crypto.randomUUID();
    const moves = await Promise.all(
      [
        "/releases",
        "/releases/",
        "/releases/r260101-abcdef0",
        "/releases/diff?from=r260101-abcdef0&to=r260102-1234567",
        "/rollouts",
        `/rollouts/${rolloutId}`,
        "/rollouts?x=1",
      ].map(movedTo)
    );

    expect(moves).toStrictEqual(
      [
        "/admin/platform/releases",
        "/admin/platform/releases/",
        "/admin/platform/releases/r260101-abcdef0",
        "/admin/platform/releases/diff?from=r260101-abcdef0&to=r260102-1234567",
        "/admin/platform/rollouts",
        `/admin/platform/rollouts/${rolloutId}`,
        "/admin/platform/rollouts?x=1",
      ].map((location) => ({ status: 301, location }))
    );
  });

  it("serve the new addresses", async () => {
    const statuses = await Promise.all(
      ["/admin/platform/releases", "/admin/platform/rollouts"].map(
        async (path) => {
          const { status } = await page(path);
          return status;
        }
      )
    );

    expect(statuses).toStrictEqual([200, 200]);
  });

  it("move nothing else: a page whose name only starts the same, or a request that isn't a page load", async () => {
    const [similar, posted] = await Promise.all([
      movedTo("/releases-old"),
      (async () => {
        const response = await answer(
          await asStaff("/rollouts", { method: "POST" })
        );
        return response.status;
      })(),
    ]);

    expect({
      similar: similar.status === 301,
      posted: posted === 301,
    }).toStrictEqual({ similar: false, posted: false });
  });

  it("go on to the admin's own hostname from there, when it has one", async () => {
    const first = await answer(await asStaff("/rollouts?x=1"), adminHost);
    const second = await answer(
      await asStaff(first.headers.get("location") ?? ""),
      adminHost
    );

    expect({
      first: first.status,
      second: second.status,
      location: second.headers.get("location"),
    }).toStrictEqual({
      first: 301,
      second: 302,
      location: `https://${adminHost}/admin/platform/rollouts?x=1`,
    });
  });

  it("tell nobody Access doesn't vouch for where they went", async () => {
    const response = await answer(new Request(`${origin}/releases`));

    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });
});
