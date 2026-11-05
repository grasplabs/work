import { defineConfig } from "blume";

/** A variable font of the workspace's own, so the build fetches nothing. */
const variableFont = (
  name: string,
  file: string,
  fallback: "sans" | "serif" | "mono"
) => ({
  name,
  fallback,
  variants: [
    { src: `./node_modules/@fontsource-variable/${file}`, weight: "100..900" },
  ],
});

export default defineConfig({
  title: "Grasp",
  description: "How to build Apps and workflows with Grasp.",
  content: { root: "content" },
  // Each deployment serves its own docs at /docs, from core's static files
  // (apps/core/src/docs.ts).
  deployment: { base: "/docs" },
  theme: {
    // The theme's tokens are the kit's (theme.css); the kit has a dark
    // theme of its own, under `.dark`, which Blume's toggle doesn't set.
    mode: "light",
    toggle: false,
    fonts: {
      display: variableFont(
        "Newsreader Variable",
        "newsreader/files/newsreader-latin-wght-normal.woff2",
        "serif"
      ),
      body: variableFont(
        "Geist Variable",
        "geist/files/geist-latin-wght-normal.woff2",
        "sans"
      ),
      mono: variableFont(
        "JetBrains Mono Variable",
        "jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
        "mono"
      ),
    },
  },
  // What the agent reads: llms.txt, llms-full.txt, each page's Markdown at
  // its `.md` URL and the search index (`blume-search.json`). Nothing that
  // needs a server, and nothing that tells crawlers about a deployment
  // nobody outside it reaches.
  agents: {
    llmsTxt: {
      details:
        "Grasp runs Apps and workflows inside a company's own deployment. An App is a TypeScript project on `@grasp-os/sdk`: a schema, server functions and Pages. These docs are the version this deployment runs.",
    },
    api: false,
    agentReadability: false,
    catalog: false,
    contentSignals: false,
    skillMd: false,
    webmcp: false,
  },
  ai: { openInChat: false },
  seo: {
    og: { enabled: false },
    robots: false,
    sitemap: false,
    structuredData: false,
  },
  feedback: false,
  poweredBy: false,
});
