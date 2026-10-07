// The rendered side of a Markdown document: GitHub-flavored Markdown (tables, task lists, strikethrough,
// autolinks) in GitHub's styles. Raw HTML in the text is not rendered, and unsafe link targets are dropped.
// Front matter at the top is shown as-is instead of being mistaken for a heading.
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import 'github-markdown-css/github-markdown-light.css';
import { frontMatterAsCode } from './frontMatter.ts';

const PLUGINS = [remarkFrontmatter, remarkGfm, frontMatterAsCode];

export const MarkdownPreview = memo(function MarkdownPreview({ text }: { text: string }) {
  return (
    <article className="markdown-body md-preview-body">
      {text.trim() === '' ? (
        <p className="md-preview-empty">Nothing to preview yet. Start typing Markdown on the left.</p>
      ) : (
        <ReactMarkdown remarkPlugins={PLUGINS}>{text}</ReactMarkdown>
      )}
    </article>
  );
});
