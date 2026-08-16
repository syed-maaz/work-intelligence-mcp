import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
// @ts-expect-error no type declarations available
import { gfm } from 'turndown-plugin-gfm';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
turndown.use(gfm);
turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'aside']);

export function extractMarkdownFromHtml(html: string, _url: string, maxChars = 3000): string {
  const { document } = parseHTML(html);

  // linkedom Document is compatible with Readability's expected interface
  const reader = new Readability(document as any, { charThreshold: 100 });
  const article = reader.parse();

  let markdown: string;
  if (article?.content) {
    markdown = turndown.turndown(article.content);
  } else {
    const body = document.querySelector('body');
    markdown = body ? turndown.turndown(body.innerHTML) : '';
  }

  return sanitizeContent(markdown, maxChars);
}

export function sanitizeContent(text: string, maxChars = 3000): string {
  let result = text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();

  if (result.length > maxChars) {
    result = result.slice(0, maxChars);
    const lastNewline = result.lastIndexOf('\n');
    if (lastNewline > maxChars * 0.8) {
      result = result.slice(0, lastNewline);
    }
    result += '\n\n[...truncated]';
  }

  return result;
}
