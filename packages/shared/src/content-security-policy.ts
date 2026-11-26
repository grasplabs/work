// Content Security Policies core sends (apps/core/src/security-headers.ts),
// here so the frontend's dev server sends the frontend's too
// (apps/web/vite.config.ts), and a fault it refuses shows in development.

/** A policy of `directives`, each a name and its sources. */
export const policy = (directives: Record<string, string>): string =>
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
 * The directives of the Content Security Policy of everything core serves
 * but the page frame, on a deployment people reach at `origin`. It
 * matters for the frontend's HTML, where it keeps an injected script from
 * running or sending the person's data elsewhere; on API responses it
 * does nothing.
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
/**
 * Where the interview's live voice session is held (core's
 * onboarding/voice.ts hands the page a room at Mistral, which its SDK joins
 * over LiveKit, or a token for Grasp's ElevenLabs agent, whose SDK joins
 * its own LiveKit at livekit.rtc.elevenlabs.io and asks api.elevenlabs.io,
 * or their EU residency hosts): the room's socket, and the region lookup
 * LiveKit makes on the same host. Sound itself goes over WebRTC, which this
 * policy doesn't govern.
 */
export const voiceRoomSources =
  "wss://*.livekit.cloud https://*.livekit.cloud wss://*.mistral.ai https://*.mistral.ai wss://*.elevenlabs.io https://*.elevenlabs.io";

export const frontendDirectives = (origin: string): Record<string, string> => ({
  "default-src": "'self'",
  "script-src": `${origin}${frontendAssets} ${origin}${frontendTheme} 'wasm-unsafe-eval'`,
  "style-src": `${origin}${frontendAssets} 'unsafe-inline'`,
  "worker-src": "'none'",
  "img-src": "'self' data:",
  "connect-src": `'self' ${voiceRoomSources}`,
  "object-src": "'none'",
  "base-uri": "'none'",
  "form-action": "'self'",
  "frame-src": "'self'",
  "frame-ancestors": "'none'",
});
