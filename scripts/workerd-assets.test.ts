/**
 * The on-prem assets service on plain workerd, as core's `ASSETS` reaches
 * it there (workerd-assets.ts): over a folder laid out as core's assets
 * are, the frontend and the compiler's files.
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  assetsServiceName,
  assetsServices,
  writeAssetsService,
} from "./workerd-assets.ts";
import { cleanUp, serveOnWorkerd, tempDir } from "./workerd-test-server.ts";

const indexPage = "<!doctype html><title>Grasp</title>";

/** The folder's files, by path, as core's assets have them. */
const folderFiles: Readonly<Record<string, string>> = {
  "index.html": indexPage,
  "about.html": "<p>about</p>",
  "docs/index.html": "<p>docs</p>",
  "assets/app-1a2b.js": "console.log(1);",
  "assets/app-1a2b.css": "body{}",
  "favicon.svg": "<svg/>",
  "_compiler/v1/compiler.js": "export const compile = 1;",
  "_compiler/v1/kit.json": "{}",
  "_compiler/v1/esbuild.wasm": "\0asm",
  "_compiler/v1/notes": "no extension",
  ".env": "SECRET=1",
};

/** Writes `files` into a new folder. */
const folderOf = (files: Readonly<Record<string, string>>): string => {
  const folder = tempDir();
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
    writeFileSync(path.join(folder, name), text);
  }
  return folder;
};

/** Serves the assets service over `folder`, as on-prem binds it. */
const serve = async (folder: string) => {
  const out = tempDir();
  writeAssetsService(out);
  const served = await serveOnWorkerd(
    out,
    (address) => `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [${assetsServices(folder).join(", ")}],
  sockets = [(name = "http", address = "${address}", http = (), service = "${assetsServiceName}")],
);
`
  );
  return {
    ...served,
    get: async (pathname: string, init?: RequestInit) =>
      await fetch(new URL(pathname, served.url), init),
  };
};

/** A response's status, type and body. */
const answered = async (response: Response) => ({
  status: response.status,
  type: response.headers.get("content-type"),
  body: await response.text(),
});

describe("the on-prem assets service", () => {
  afterEach(cleanUp);

  it.each([
    ["/index.html", "text/html; charset=utf-8", indexPage],
    [
      "/assets/app-1a2b.js",
      "text/javascript; charset=utf-8",
      "console.log(1);",
    ],
    ["/assets/app-1a2b.css", "text/css; charset=utf-8", "body{}"],
    ["/favicon.svg", "image/svg+xml", "<svg/>"],
    [
      "/_compiler/v1/compiler.js",
      "text/javascript; charset=utf-8",
      "export const compile = 1;",
    ],
    ["/_compiler/v1/kit.json", "application/json; charset=utf-8", "{}"],
    ["/_compiler/v1/esbuild.wasm", "application/wasm", "\0asm"],
    ["/_compiler/v1/notes", "application/octet-stream", "no extension"],
  ])(
    "answers %s with the type its extension says",
    async (pathname, type, body) => {
      const { get } = await serve(folderOf(folderFiles));
      await expect(answered(await get(pathname))).resolves.toStrictEqual({
        status: 200,
        type,
        body,
      });
    }
  );

  it.each([
    ["the index page at /", "/", indexPage],
    ["a page by its name without .html", "/about", "<p>about</p>"],
    ["a folder's index page at its path with a slash", "/docs/", "<p>docs</p>"],
    ["a folder's index page at its path", "/docs", "<p>docs</p>"],
    [
      "the frontend's own route with the index page",
      "/workflows/abc",
      indexPage,
    ],
    [
      "a folder without an index page with the index page, never its listing",
      "/assets",
      indexPage,
    ],
    ["a dotfile with the index page, never the file", "/.env", indexPage],
    [
      "a missing compiler file with the index page, so core takes it for missing",
      "/_compiler/v2/compiler.js",
      indexPage,
    ],
  ])("answers %s", async (_what, pathname, body) => {
    const { get } = await serve(folderOf(folderFiles));
    const response = await get(pathname);
    await expect(answered(response)).resolves.toStrictEqual({
      status: 200,
      type: "text/html; charset=utf-8",
      body,
    });
  });

  it("answers 404 when the folder has no index page to fall back on", async () => {
    const { get } = await serve(folderOf({ "a.js": "1" }));
    const missing = await get("/missing");
    expect(missing.status).toBe(404);
  });

  it("sends Workers' caching headers, answers 304 for a copy that is current, and a new tag once the file changes", async () => {
    const folder = folderOf(folderFiles);
    const { get } = await serve(folder);
    const first = await get("/assets/app-1a2b.js");
    await first.body?.cancel();
    const etag = first.headers.get("etag") ?? "";
    const current = await get("/assets/app-1a2b.js", {
      headers: { "if-none-match": `"other", W/${etag}` },
    });
    const otherFile = await get("/favicon.svg", {
      headers: { "if-none-match": etag },
    });
    await otherFile.body?.cancel();
    writeFileSync(path.join(folder, "assets/app-1a2b.js"), "console.log(22);");
    utimesSync(
      path.join(folder, "assets/app-1a2b.js"),
      new Date("2030-01-01"),
      new Date("2030-01-01")
    );
    const changed = await get("/assets/app-1a2b.js", {
      headers: { "if-none-match": etag },
    });
    expect({
      cacheControl: first.headers.get("cache-control"),
      etag: /^"[\da-f]{32}"$/u.test(etag),
      current: {
        status: current.status,
        etag: current.headers.get("etag"),
        body: await current.text(),
      },
      otherFile: otherFile.status,
      changed: {
        status: changed.status,
        newTag: changed.headers.get("etag") !== etag,
        body: await changed.text(),
      },
    }).toStrictEqual({
      cacheControl: "public, max-age=0, must-revalidate",
      etag: true,
      current: { status: 304, etag, body: "" },
      otherFile: 200,
      changed: { status: 200, newTag: true, body: "console.log(22);" },
    });
  });

  it("answers HEAD with the file's headers and no body, and refuses any other method", async () => {
    const { get } = await serve(folderOf(folderFiles));
    const head = await get("/_compiler/v1/kit.json", { method: "HEAD" });
    const post = await get("/index.html", { method: "POST", body: "x" });
    expect({
      head: await answered(head),
      length: head.headers.get("content-length"),
      post: { ...(await answered(post)), allow: post.headers.get("allow") },
    }).toStrictEqual({
      head: { status: 200, type: "application/json; charset=utf-8", body: "" },
      length: "2",
      post: {
        status: 405,
        type: "text/plain;charset=UTF-8",
        body: "Method Not Allowed",
        allow: "GET, HEAD",
      },
    });
  });
});
