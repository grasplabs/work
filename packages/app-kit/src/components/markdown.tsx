"use client";

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@grasp-os/app-kit/components/code-block";
import { useHighlightedCode } from "@grasp-os/app-kit/hooks/use-highlighted-code";
import { cn } from "cn";
import type { ComponentProps } from "react";
import {
  defaultRehypePlugins,
  Streamdown,
  useIsCodeFenceIncomplete,
} from "streamdown";
import type { ExtraProps } from "streamdown";

// The registry's Markdown (apps/v4/components/markdown.tsx in
// github.com/shadcn-ui/ui, MIT), as its chat examples render a model's
// answer: Streamdown, which completes half-written Markdown while it
// streams, with fenced code drawn by the kit's code block. Upstream's code
// but for two changes, listed with their reason and test in
// packages/app-kit/local-changes.json:
// - Raw HTML in the text shows as the text it is: Streamdown's own rehype
//   plugins less rehype-raw, which would parse it into elements.
// - A link is its words with its address beside them, to read: an App
//   page's frame opens no window and goes nowhere (sandboxed without
//   popups or navigation, it opens a URL only through a links permission
//   of its App), so Streamdown's link, a button whose dialog opens or
//   copies the address, would do nothing.
// Upstream's `cn-markdown` class is left out: no style of the registry
// gives it any CSS, and the lint refuses a class without any.

const languageClass = /language-(?<language>\S+)/u;

/** The address Streamdown gives a link whose address is still being written. */
const incompleteLink = "streamdown:incomplete-link";

function MarkdownCodeBlock({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  // True while the closing fence has not arrived yet.
  const incomplete = useIsCodeFenceIncomplete();
  const lines = useHighlightedCode(code, language);

  return (
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>{language || "text"}</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton disabled={incomplete} value={code} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

function MarkdownCode({
  node: _node,
  className,
  children,
  ...props
}: ComponentProps<"code"> & ExtraProps) {
  // Streamdown marks fenced code with data-block. Inline code stays inline.
  if (!("data-block" in props)) {
    return (
      <code
        className={cn(
          "bg-muted rounded-sm px-1 py-0.5 font-mono text-[0.9em]",
          className
        )}
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <MarkdownCodeBlock
      code={typeof children === "string" ? children : ""}
      language={languageClass.exec(className ?? "")?.groups?.language ?? ""}
    />
  );
}

function MarkdownLink({ href, children }: ComponentProps<"a"> & ExtraProps) {
  // A link still being written, or one whose address the sanitizer
  // dropped (`javascript:`): its words alone.
  if (href === undefined || href === "" || href === incompleteLink) {
    return <span>{children}</span>;
  }
  return (
    <span className="wrap-anywhere">
      {children === href ? (
        href
      ) : (
        <>
          {children} ({href})
        </>
      )}
    </span>
  );
}

// Streamdown memoizes on components, so keep the default stable.
const DEFAULT_COMPONENTS = { a: MarkdownLink, code: MarkdownCode };

const REHYPE_PLUGINS = Object.entries(defaultRehypePlugins)
  .filter(([name]) => name !== "raw")
  .map(([, plugin]) => plugin);

function Markdown({
  className,
  components = DEFAULT_COMPONENTS,
  controls = false,
  rehypePlugins = REHYPE_PLUGINS,
  ...props
}: ComponentProps<typeof Streamdown>) {
  return (
    <Streamdown
      className={cn("w-full min-w-0 overflow-hidden", className)}
      components={components}
      controls={controls}
      data-slot="markdown"
      rehypePlugins={rehypePlugins}
      {...props}
    />
  );
}

export { Markdown };
