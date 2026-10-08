import { strictTransportSecurity } from "@grasp-os/shared/http";
import { isPackageArtifactPath } from "@grasp-os/shared/packages";
import { screenFramePath, screenModulePath } from "@grasp-os/shared/screens";

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
 * The Content Security Policy of everything core serves but the screen
 * frame, on a deployment people reach at `origin`. It matters for the
 * frontend's HTML, where it keeps an injected script from running or
 * sending the person's data elsewhere; on API responses it does nothing.
 *
 * - Scripts and styles only from the frontend's own files: no inline
 *   script, no eval, and none of the code this origin serves that we
 *   didn't write. Screens' modules and Apps' npm packages are served here
 *   for screens' frames, which have an opaque origin; run in this page,
 *   with its origin and the person's session, they would turn any HTML
 *   injection into script, through a `<script src>` or a `srcdoc` frame
 *   (which inherits this policy). A source ending in `/` matches its path
 *   as a prefix, any other exactly; browsers stop matching paths after a
 *   redirect, and nothing on the frontend's paths redirects elsewhere.
 *   Browsers match the path as written, escapes and all, so core answers
 *   no path that decodes to another (`/assets/..%2Fscreen-modules/…`,
 *   entry.ts). Core also refuses those paths to this page's own requests
 *   (`isRefusedToProductPage`), in case a browser lets one through.
 * - No workers: the frontend starts none.
 * - Connections only to this origin. `'self'` covers the same-origin
 *   WebSocket to `/rpc`.
 * - Sign-in leaves for the IdP by top-level navigation, which the policy
 *   doesn't govern, so form-action needs no IdP hosts.
 * - Screens (App UIs) run in sandboxed frames of a document from this
 *   origin (screen-frame.ts), which has a policy of its own. A `srcdoc` or
 *   `data:` frame would inherit this one and couldn't run its screen.
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
    "script-src": `${origin}${frontendAssets} ${origin}${frontendTheme}`,
    "style-src": `${origin}${frontendAssets}`,
    "worker-src": "'none'",
    "img-src": "'self' data:",
    "connect-src": "'self'",
    "object-src": "'none'",
    "base-uri": "'none'",
    "form-action": "'self'",
    "frame-src": "'self'",
    "frame-ancestors": "'none'",
  });

/**
 * Whether `pathname` is where core serves code we didn't write: a
 * screen's modules or the files of an App's npm packages.
 */
const isThirdPartyCodePath = (pathname: string): boolean =>
  pathname === screenModulePath ||
  pathname.startsWith(`${screenModulePath}/`) ||
  isPackageArtifactPath(pathname);

/**
 * Whether core refuses `request`: one the product page itself makes for
 * code we didn't write. Only screens' frames load it, and a frame's
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
 * The policy of the document screens run in (screen-frame.ts), for one
 * build: App code nobody reviewed line by line, so no network at all, and
 * no script but `scripts`, the hash sources of the document's own inline
 * scripts and the exact addresses of the build's modules.
 *
 * - `sandbox allow-scripts` gives it an opaque origin even when it is
 *   opened on its own, not framed: no cookies, storage or DOM of this
 *   origin, no popups, no top-level navigation, no forms.
 * - Scripts only from `scripts`: no `'unsafe-inline'` (so no inline
 *   script or event handler the screen writes into its page), no `data:`
 *   or `blob:` module, no eval, no WebAssembly. A screen that renders HTML
 *   it was sent, or imports from a string, runs none of it.
 * - Styles inline and from `data:` URLs, images and fonts from `data:`:
 *   how a screen's CSS and assets come. Nothing to connect to (fetch,
 *   WebSocket, beacons, EventSource), no workers, no frames, no form
 *   targets and no `<base>`.
 * - Only the product page may frame it.
 *
 * A sandboxed frame may still load another address in its own place. This
 * policy says nothing about that; the page's does (`frame-src 'self'`
 * above), so the frame gets no further than this origin, where the page
 * notices and stops the screen (the frontend's screen-host.ts).
 *
 * This is not a promise that nothing leaves the frame. WebRTC stays open,
 * and no header here closes it: a screen can make an `RTCPeerConnection`
 * with a TURN or STUN server of its choosing, and the browser sends that
 * server packets, with a username the screen wrote. `connect-src` doesn't
 * govern ICE, and the `webrtc 'block'` directive changed nothing in any
 * browser we test. Chromium and WebKit send the packets; Firefox, run
 * headless against a server on the same machine, sent none in the time
 * the test waits, which says nothing about a server elsewhere. Deleting
 * or wrapping `RTCPeerConnection` in the frame would be no boundary
 * either: the screen's code runs in the same realm and can get the
 * original back from a frame of its own, so we don't pretend to.
 *
 * So what keeps data in is not this policy but what a screen is handed in
 * the first place: only what its person may already see in that App, and,
 * for data that must not leave, only code a person has reviewed (artifact
 * approval: core's to enforce, never the browser's). What this policy
 * adds is that the code which runs is that code. The browser tests write
 * down what each browser did with WebRTC and never count it as blocked
 * (e2e/screen-attacks.e2e.ts).
 */
export const screenFramePolicy = (scripts: readonly string[]): string =>
  policy({
    sandbox: "allow-scripts",
    "default-src": "'none'",
    "script-src": scripts.length === 0 ? "'none'" : scripts.join(" "),
    "style-src": "data: 'unsafe-inline'",
    "img-src": "data:",
    "font-src": "data:",
    "connect-src": "'none'",
    "worker-src": "'none'",
    "frame-src": "'none'",
    "form-action": "'none'",
    "base-uri": "'none'",
    "frame-ancestors": "'self'",
  });

/**
 * The policy of every response on the path of an App's built packages
 * (packages/serve.ts), a file or an error: the one the package build
 * relies on for what it can't check (packages/build.ts). Code nobody
 * reviewed line by line, from npm, so wherever a browser opens a file of
 * it on its own, as a document or a worker:
 *
 * - Script only from `origin`, the deployment's own, as people reach it
 *   (the artifact's origin, where screens' modules are served too); no
 *   inline script, eval, `data:` or `blob:`. No workers at all.
 * - No connections at all. Nothing that legitimately runs under this
 *   policy needs one: documents are sandboxed and run no script, and
 *   browser code never runs as a worker; allowing `origin` would only let
 *   a worker started on this origin call its APIs with the person's
 *   cookies.
 * - Images and fonts only from this origin and `data:`; styles only from
 *   this origin, none inline.
 * - `sandbox` on every file, not only SVGs: whatever a browser opens as a
 *   document runs nothing and has an opaque origin, whichever type it was
 *   sent with.
 * - No Referer, as each address carries a token (packages/serve.ts).
 *
 * A policy sent with a script or a stylesheet says nothing about the page
 * that loads it: inside a screen's frame, the frame's policy (above)
 * governs what the code does, and it too allows no worker, no connection
 * and no image, font or stylesheet from anywhere.
 */
export const packageArtifactPolicy = (origin: string): string =>
  `${policy({
    "default-src": "'none'",
    "script-src": origin,
    "worker-src": "'none'",
    "connect-src": "'none'",
    "img-src": "'self' data:",
    "font-src": "'self' data:",
    "style-src": "'self'",
  })}; sandbox`;

/**
 * Sets the security headers on a response core sends for `url`, on a
 * deployment people reach at `origin`. HSTS goes only on https, since
 * browsers ignore it over http (local development). A route may send a
 * stricter referrer policy of its own, such as `no-referrer` where its
 * URL carries a secret; it is kept. So is the screen frame's policy,
 * which names its build's scripts; a frame response without one runs no
 * script at all. Everything on the path of packages' artifacts gets their
 * policy and `no-referrer`, whatever the route sent. Answers on the paths
 * of code we didn't write vary on `Sec-Fetch-Site`, as core refuses them
 * to the product page (`isRefusedToProductPage`).
 */
export const setSecurityHeaders = (
  headers: Headers,
  url: URL,
  origin: string
): void => {
  const artifact = isPackageArtifactPath(url.pathname);
  if (artifact) {
    headers.set("content-security-policy", packageArtifactPolicy(origin));
    headers.set("referrer-policy", "no-referrer");
  } else if (url.pathname !== screenFramePath) {
    headers.set("content-security-policy", contentSecurityPolicy(origin));
  } else if (!headers.has("content-security-policy")) {
    headers.set("content-security-policy", screenFramePolicy([]));
  }
  headers.set("x-content-type-options", "nosniff");
  if (!artifact && headers.get("referrer-policy") !== "no-referrer") {
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
  }
  if (isThirdPartyCodePath(url.pathname)) {
    headers.append("vary", "sec-fetch-site");
  }
  if (url.protocol === "https:") {
    headers.set("strict-transport-security", strictTransportSecurity);
  }
};
