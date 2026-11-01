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

/** How the admin answers `request`, on `host` of its own ("" for none). */
const answer = async (request: Request, host = adminHost) =>
  await worker.fetch(request, { ...env, ADMIN_HOST: host });

describe("the admin's own hostname", () => {
  it("serves the overview at its front page", async () => {
    const response = await answer(await asStaff(`https://${adminHost}/?x=1`));
    expect(response.status).toBe(200);
  });

  it("moves every page load on another hostname to the same page on the admin's", async () => {
    const locations = await Promise.all(
      [
        "https://ops.grasp.test/ask?day=1",
        "https://ops.grasp.test/organizations/acme/setup",
        "https://ops.grasp.test/no-such-page",
      ].map(async (url) => {
        const response = await answer(await asStaff(url));
        return [response.status, response.headers.get("location")];
      })
    );
    expect(locations).toStrictEqual([
      [302, `https://${adminHost}/ask?day=1`],
      [302, `https://${adminHost}/organizations/acme/setup`],
      [302, `https://${adminHost}/no-such-page`],
    ]);
  });

  it("serves the admin's pages on its own hostname", async () => {
    const response = await answer(await asStaff(`https://${adminHost}/ask`));
    expect(response.status).toBe(200);
  });

  it("answers what isn't a page, and anything that changes something, where it's asked", async () => {
    const requests = [
      await asStaff("https://ops.grasp.test/_serverFn/anything"),
      await asStaff("https://ops.grasp.test/mcp"),
      await asStaff("https://ops.grasp.test/mcp", { method: "POST" }),
      new Request("https://ops.grasp.test/discord/interactions"),
      await asStaff("https://ops.grasp.test/", { method: "POST" }),
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
      await asStaff("https://ops.grasp.test/ask"),
      ""
    );
    expect(response.status).not.toBe(302);
  });

  it("tells nobody Access doesn't vouch for where the admin is", async () => {
    const response = await answer(new Request("https://ops.grasp.test/"));
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });
});
