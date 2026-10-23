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
  it("lands on the admin from its front page", async () => {
    const response = await answer(await asStaff(`https://${adminHost}/?x=1`));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin?x=1");
  });

  it("moves the admin's pages from the console's hostname to its own", async () => {
    const response = await answer(
      await asStaff("https://console.grasp.test/admin/sources?day=1")
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `https://${adminHost}/admin/sources?day=1`
    );
  });

  it("serves the admin on its own hostname and the console's pages where asked", async () => {
    const statuses = await Promise.all(
      [
        `https://${adminHost}/admin/sources`,
        "https://console.grasp.test/",
        "https://console.grasp.test/administrators",
      ].map(async (url) => {
        const response = await answer(await asStaff(url));
        return response.status;
      })
    );
    expect(statuses).not.toContain(302);
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
