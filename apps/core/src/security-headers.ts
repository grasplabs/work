import { appFilesPath } from "@grasp-os/shared/app-file-limits";
import { catalogLogoPath } from "@grasp-os/shared/connect";
import { strictTransportSecurity } from "@grasp-os/shared/http";
import { pageFramePath, pageModulePath } from "@grasp-os/shared/pages";
import { runFilesPath } from "@grasp-os/shared/run-files";

const policy = (directives: Record<string, string>): string =>
  Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources}`)
    .join("; ");

/**
 * Where the frontend's build puts every script and stylesheet it loads,
 * lazy chunks and modulepreloads included (Vite's `assets` directory), and
 * its one script outside it (apps/web/public/theme.js). Nothing else this
 * origin serves is the frontend's own code.
 */
const frontendAssets = "/assets/";
const frontendTheme = "/theme.js";

/**
 * The Content Security Policy of everything core serves but the page
 * frame, on a deployment people reach at `origin`. It matters for the
 * frontend's HTML, where it keeps an injected script from running or
 * sending the person's data elsewhere; on API responses it does nothing.
 *
 * - Scripts only from the frontend's own files: no inline script, no
 *   eval, and none of the code this origin serves that we didn't write.
 *   WebAssembly may compile (`'wasm-unsafe-eval'`, which allows no JS
 *   eval): the Code view's highlighter (@pierre/diffs' Highlights) is
 *   lexers compiled to WebAssembly, shipped in those same files.
 * - Stylesheets only from the frontend's own files, and inline styles:
 *   the Code view's renderer (@pierre/diffs) writes its lines as HTML
 *   with `style` attributes, and its theme as a `<style>` in their shadow
 *   root; without them it shows nothing right. A style runs no code, and
 *   what injected CSS could fetch to leak the page's text (a `url()` in a
 *   background or a font) still reaches only this origin (img-src, and
 *   font-src through default-src).
 * - Pages' modules and Apps' npm packages are served here
 *   for pages' frames, which have an opaque origin; run in this page,
 *   with its origin and the person's session, they would turn any HTML
 *   injection into script, through a `<script src>` or a `srcdoc` frame
 *   (which inherits this policy). A source ending in `/` matches its path
 *   as a prefix, any other exactly; browsers stop matching paths after a
 *   redirect, and nothing on the frontend's paths redirects elsewhere.
 *   Browsers match the path as written, escapes and all, so core answers
 *   no path that decodes to another (`/assets/..%2Fpage-modules/…`,
 *   entry.ts). Core also refuses those paths to this page's own requests
 *   (`isRefusedToProductPage`), in case a browser lets one through.
 * - No workers: the frontend starts none.
 * - Connections only to this origin. `'self'` covers the same-origin
 *   WebSocket to `/rpc`.
 * - Sign-in leaves for the IdP by top-level navigation, which the policy
 *   doesn't govern, so form-action needs no IdP hosts.
 * - Pages (App UIs) run in sandboxed frames of a document from this
 *   origin (page-frame.ts), which has a policy of its own. A `srcdoc` or
 *   `data:` frame would inherit this one and couldn't run its page.
 *
 * Paths are named with `origin` as people reach it (`SIGN_IN.origin`,
 * behind the router): a policy can name a path only with its host. So a
 * deployment reached on a second hostname gets a blank page there, as
 * the policy names none of its scripts; sign-in and RPC already work only
 * on `SIGN_IN.origin`.
 */
const contentSecurityPolicy = (origin: string): string =>
  policy({
    "default-src": "'self'",
    "script-src": `${origin}${frontendAssets} ${origin}${frontendTheme} 'wasm-unsafe-eval'`,
    "style-src": `${origin}${frontendAssets} 'unsafe-inline'`,
    "worker-src": "'none'",
    "img-src": "'self' data:",
    "connect-src": "'self'",
    "object-src": "'none'",
    "base-uri": "'none'",
    "form-action": "'self'",
    "frame-src": "'self'",
    "frame-ancestors": "'none'",
  });

/** Where core serves the SDK docs (docs.ts), among the frontend's files. */
export const docsPath = "/docs";

/** Where the docs' build puts every script and stylesheet it loads. */
const docsAssets = `${docsPath}/_astro/`;

/** The hashes of the docs' inline code, as sources (docs.ts). */
export interface InlineHashes {
  readonly scripts: readonly string[];
  readonly styles: readonly string[];
  /** Of its elements' `style` attributes. */
  readonly styleAttributes: readonly string[];
}

/**
 * The policy of a docs page (docs.ts), on a deployment people reach at
 * `origin`: the frontend's, with the docs' own scripts and styles in
 * place of the frontend's, and their inline code by its hashes
 * (`inline`), as the release built it. Nothing injected into a page
 * later runs or applies. The docs post no forms and frame nothing.
 */
export const docsPolicy = (origin: string, inline: InlineHashes): string =>
  policy({
    "default-src": "'self'",
    "script-src": [`${origin}${docsAssets}`, ...inline.scripts].join(" "),
    // `'unsafe-hashes'` lets the hashes match `style` attributes too (the
    // highlighted code's colours): only those the docs have, so no other
    // attribute applies.
    "style-src": [
      `${origin}${docsAssets}`,
      ...inline.styles,
      ...(inline.styleAttributes.length === 0
        ? []
        : ["'unsafe-hashes'", ...inline.styleAttributes]),
    ].join(" "),
    "worker-src": "'none'",
    "img-src": `${origin}${docsPath}/ data:`,
    // The docs fetch only their own files (the next page, the search
    // index), the start page by its address without a `/` too.
    "connect-src": `${origin}${docsPath} ${origin}${docsPath}/`,
    "object-src": "'none'",
    "base-uri": "'none'",
    "form-action": "'none'",
    "frame-src": "'none'",
    "frame-ancestors": "'none'",
  });

/** Whether `pathname` is one of the docs' (docs.ts). */
export const isDocsPath = (pathname: string): boolean =>
  pathname === docsPath || pathname.startsWith(`${docsPath}/`);

/** Whether `pathname` is where core serves code we didn't write: a page's modules. */
const isThirdPartyCodePath = (pathname: string): boolean =>
  pathname === pageModulePath || pathname.startsWith(`${pageModulePath}/`);

/**
 * Whether core refuses `request`: one the product page itself makes for
 * code we didn't write. Only pages' frames load it, and a frame's
 * origin is opaque (`sandbox allow-scripts`), so a browser never calls
 * their requests same-origin; one that is comes from the product page or
 * a frame of its origin, which the page's policy should already have
 * stopped. A request without `Sec-Fetch-Site` (an older browser, a tool)
 * is let through: the policy and the address's token still hold. The
 * answers vary on the header (`setSecurityHeaders`), so a copy a frame's
 * load left in the browser's cache never answers the page.
 */
export const isRefusedToProductPage = (request: Request): boolean =>
  isThirdPartyCodePath(new URL(request.url).pathname) &&
  request.headers.get("sec-fetch-site") === "same-origin";

/**
 * The policy of the document pages run in (page-frame.ts), for one
 * build: App code nobody reviewed line by line, so no network at all, and
 * no script but `scripts`, the hash sources of the document's own inline
 * scripts and the directories of the build's modules: a source ending in
 * `/` matches every path under it, and each directory holds one build's
 * modules alone and never changes (page-frame.ts says how), so the policy
 * stays a few hundred bytes however many modules a page loads, and allows
 * no more than naming each would.
 *
 * - `sandbox allow-scripts` gives it an opaque origin even when it is
 *   opened on its own, not framed: no cookies, storage or DOM of this
 *   origin, no popups, no top-level navigation, no forms.
 * - Scripts only from `scripts`: no `'unsafe-inline'` (so no inline
 *   script or event handler the page writes into its page), no `data:`
 *   or `blob:` module, no eval, no WebAssembly. A page that renders HTML
 *   it was sent, or imports from a string, runs none of it.
 * - Styles inline and from `data:` URLs, images and fonts from `data:`:
 *   how a page's CSS and assets come. Images from `blob:` too: a
 *   file's preview (spec 10.7.5), which the page hands the frame as a
 *   `Blob` and the frame shows through a URL of its own opaque origin,
 *   that no other document can load. Nothing to connect to (fetch,
 *   WebSocket, beacons, EventSource), no workers, no frames, no form
 *   targets and no `<base>`.
 * - Only the product page may frame it.
 *
 * A sandboxed frame may still load another address in its own place. This
 * policy says nothing about that; the page's does (`frame-src 'self'`
 * above), so the frame gets no further than this origin, where the page
 * notices and stops the page (the frontend's page-host.ts).
 *
 * WebRTC is the one way out no directive closes in the browsers we test:
 * `connect-src` doesn't govern ICE, and `webrtc 'block'`, sent for the
 * browsers that come to enforce it, changes nothing yet. Chromium and
 * WebKit send a TURN server of the page's choosing packets. So the
 * frame closes it itself, before any of the page's code runs
 * (page-frame.ts): its WebRTC interfaces are taken away, and the page
 * can make no document of its own, the only place WebRTC (or a network
 * this policy doesn't govern) could come back from. That rests on this
 * policy: with Trusted Types and no policy allowed, every sink of the
 * HTML parser refuses a string, so no markup becomes a nested document,
 * and the bootstrap closes the ways that don't parse markup. A browser
 * that doesn't enforce Trusted Types is told so, and runs no page. The
 * pages' lint rules against WebRTC (@grasp-os/compiler's page-rules.ts)
 * only tell an author early; nothing relies on them. The
 * browser tests try every way, in every engine (e2e/page-attacks.e2e.ts).
 *
 * What a page is handed stays bounded besides: only what its person may
 * already read through that App's functions, which reach only the
 * connections and resources an admin granted the App
 * (page-delivery.ts). What this policy adds is that the code which runs
 * is the build core leased, and that nothing it writes leaves the frame
 * but through its App (a declared link opens as app-link-route.ts says).
 */
export const pageFramePolicy = (scripts: readonly string[]): string =>
  policy({
    sandbox: "allow-scripts",
    "default-src": "'none'",
    "script-src": scripts.length === 0 ? "'none'" : scripts.join(" "),
    "style-src": "data: 'unsafe-inline'",
    "img-src": "data: blob:",
    "font-src": "data:",
    "connect-src": "'none'",
    "worker-src": "'none'",
    "frame-src": "'none'",
    "form-action": "'none'",
    "base-uri": "'none'",
    "frame-ancestors": "'self'",
    // Every sink of the HTML parser refuses a string, and no policy may
    // make one it takes: a page can't write markup into a nested
    // document (page-frame.ts). `webrtc 'block'` is the standard's
    // word on WebRTC, which no browser we test enforces yet.
    "require-trusted-types-for": "'script'",
    "trusted-types": "'none'",
    webrtc: "'block'",
  });

/**
 * The policy of every answer on the path of catalog logos (connections.ts):
 * images from Composio, an SVG among them, which can carry script. Shown
 * in an `<img>`, an SVG runs none; opened on its own, as a document, this
 * policy runs none either: nothing loads, and `sandbox` gives it an opaque
 * origin, so nothing in it reaches this origin's cookies or storage. Inline
 * styles stay, as SVGs draw with them.
 */
export const catalogLogoPolicy = `${policy({
  "default-src": "'none'",
  "style-src": "'unsafe-inline'",
  "img-src": "data:",
  "frame-ancestors": "'none'",
})}; sandbox`;

/**
 * Sets the security headers on a response core sends for `url`, on a
 * deployment people reach at `origin`. HSTS goes only on https, since
 * browsers ignore it over http (local development). A route may send a
 * stricter referrer policy of its own, such as `no-referrer` where its
 * URL carries a secret; it is kept. So is the page frame's policy,
 * which names its build's scripts; a frame response without one runs no
 * script at all. Everything on the path of catalog logos gets its policy
 * (`catalogLogoPolicy`). Answers on the paths of code we didn't write
 * vary on `Sec-Fetch-Site`, as core refuses them to the product page
 * (`isRefusedToProductPage`).
 */
/** Whether `pathname` is where an App file's or a run file's bytes are sent. */
const isFileContentPath = (pathname: string): boolean =>
  (pathname.startsWith(`${appFilesPath}/`) ||
    pathname.startsWith(`${runFilesPath}/`)) &&
  pathname.endsWith("/content");

export const setSecurityHeaders = (
  headers: Headers,
  url: URL,
  origin: string
): void => {
  if (url.pathname.startsWith(`${catalogLogoPath}/`)) {
    headers.set("content-security-policy", catalogLogoPolicy);
  } else if (isFileContentPath(url.pathname)) {
    // An App file's or a run file's bytes (app-file-route.ts,
    // workflows/run-file-downloads.ts): always an attachment, and
    // should a browser open one anyway, a sandbox that runs nothing,
    // loads nothing and isn't read by another site.
    headers.set("content-security-policy", "default-src 'none'; sandbox");
    headers.set("cross-origin-resource-policy", "same-origin");
  } else if (url.pathname !== pageFramePath) {
    // The docs' answers carry their own, naming their inline code (docs.ts).
    if (!(isDocsPath(url.pathname) && headers.has("content-security-policy"))) {
      headers.set("content-security-policy", contentSecurityPolicy(origin));
    }
    // A page opened from another site keeps no handle on its opener, and
    // that site none on it: a page's frame could otherwise post what it
    // read to `top.opener`, which no policy of its own stops. Popups the
    // page opens itself (a provider's sign-in) keep theirs.
    headers.set("cross-origin-opener-policy", "same-origin-allow-popups");
  } else if (!headers.has("content-security-policy")) {
    headers.set("content-security-policy", pageFramePolicy([]));
  }
  headers.set("x-content-type-options", "nosniff");
  if (headers.get("referrer-policy") !== "no-referrer") {
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
  }
  if (isThirdPartyCodePath(url.pathname)) {
    headers.append("vary", "sec-fetch-site");
  }
  if (url.protocol === "https:") {
    headers.set("strict-transport-security", strictTransportSecurity);
  }
};
