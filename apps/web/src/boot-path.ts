// Which code a page loads first, from its address alone, before anything
// else is fetched (main.tsx). Someone opening their interview link
// (`/interview#<secret>`) gets the interview and what it needs; every
// other address gets the whole app. Plain, with no imports: it is in the
// one file every page loads. The router matches addresses whatever their
// case and with a trailing slash, so this does too.

/**
 * What a page at `pathname` loads: the interview alone, or the app. On its
 * own, using nothing around it: index.html's preload runs it as its text
 * (boot-preload.ts). `/interview` is where an interview link leads
 * (shared's `interviewPagePath`).
 */
export const bootOf = (pathname: string): "interview" | "app" =>
  pathname.toLowerCase().replace(/\/+$/u, "") === "/interview"
    ? "interview"
    : "app";
