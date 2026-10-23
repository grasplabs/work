import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import worker from "../src/server.ts";
import { accessJwt, mockAccess } from "./access.ts";

mockAccess();

const adminHost = "admin.grasp.test";

/** A staff member's request to `url`, as Access would pass it on. */
const asStaff = async (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", await accessJwt("staff@grasp.test"));
  return new Request(url, { ...init, headers });
};

/** How the console answers `request`, its admin on `host` ("" for none). */
const answer = async (request: Request, host = adminHost) =>
  await worker.fetch(request, { ...env, ADMIN_HOST: host });

describe("the admin's own hostname", () => {
  it("lands on the admin from its front page, for good", async () => {
    const response = await answer(await asStaff(`https://${adminHost}/?x=1`));
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/admin?x=1");
  });

  it("moves the console's old pages to where they went in the admin, keeping what the address asked", async () => {
    const locations = await Promise.all(
      [
        `https://${adminHost}/clients/new?from=grid`,
        `https://${adminHost}/clients/acme?tab=settings`,
        `https://${adminHost}/clients/acme/`,
      ].map(async (url) => {
        const response = await answer(await asStaff(url));
        return [response.status, response.headers.get("location")];
      })
    );
    expect(locations).toStrictEqual([
      [301, "/admin/new-organization?from=grid"],
      [301, "/admin/organizations/acme/setup?tab=settings"],
      [301, "/admin/organizations/acme/setup"],
    ]);
  });

  it("moves every page load on the console's hostname to the admin's, an old page straight to where it went", async () => {
    const locations = await Promise.all(
      [
        "https://console.grasp.test/admin/sources?day=1",
        "https://console.grasp.test/",
        "https://console.grasp.test/clients/acme?tab=deploys",
        "https://console.grasp.test/releases",
        "https://console.grasp.test/no-such-page",
      ].map(async (url) => {
        const response = await answer(await asStaff(url));
        return [response.status, response.headers.get("location")];
      })
    );
    expect(locations).toStrictEqual([
      [302, `https://${adminHost}/admin/sources?day=1`],
      [302, `https://${adminHost}/admin`],
      [302, `https://${adminHost}/admin/organizations/acme/setup?tab=deploys`],
      [302, `https://${adminHost}/releases`],
      [302, `https://${adminHost}/no-such-page`],
    ]);
  });

  it("serves the admin's pages on its own hostname", async () => {
    const response = await answer(
      await asStaff(`https://${adminHost}/admin/sources`)
    );
    expect(response.status).toBe(200);
  });

  it("answers what isn't a page, and anything that changes something, where it's asked", async () => {
    const requests = [
      await asStaff("https://console.grasp.test/_serverFn/anything"),
      await asStaff("https://console.grasp.test/mcp"),
      await asStaff("https://console.grasp.test/mcp", { method: "POST" }),
      new Request("https://console.grasp.test/discord/interactions"),
      await asStaff("https://console.grasp.test/admin", { method: "POST" }),
      await asStaff(`https://${adminHost}/`, { method: "POST" }),
    ];
    const answers = await Promise.all(
      requests.map(async (request) => {
        const response = await answer(request);
        return response.headers.get("location");
      })
    );
    expect(answers).toStrictEqual(requests.map(() => null));
  });

  it("moves nothing without ADMIN_HOST", async () => {
    const response = await answer(
      await asStaff("https://console.grasp.test/admin/sources"),
      ""
    );
    expect(response.status).not.toBe(302);
  });

  it("tells nobody Access doesn't vouch for where the admin is", async () => {
    const response = await answer(
      new Request("https://console.grasp.test/admin")
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });
});
