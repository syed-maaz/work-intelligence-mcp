export interface ExtractedLink {
  url: string;
  type: 'jira' | 'confluence' | 'github' | 'docs' | 'generic';
  title?: string;
  context?: string;
}

const JIRA_DOMAIN = process.env.JIRA_DOMAIN ?? 'jira.example.com';
const JIRA_PATTERN = new RegExp(`https?:\\/\\/${JIRA_DOMAIN.replace(/\./g, '\\.')}\\/browse\\/([A-Z][A-Z0-9]+-\\d+)`, 'g');
const CONFLUENCE_PATTERN = /https?:\/\/(?:wiki|confluence)\.[\w.]+\/(?:display|pages|x)\/[^\s)>\]"]+/g;
const GITHUB_PATTERN = /https?:\/\/github\.(?:[\w.]+|com)\/[^\s)>\]"]+/g;
const DOCS_PATTERN = /https?:\/\/(?:help|docs|sapui5|ui5)\.(?:[\w-]+\.)+\w{2,}\/[^\s)>\]"]+/g;
const GENERIC_URL_PATTERN = /https?:\/\/[^\s)>\]"]{10,}/g;

const SELF_LINK_PATTERNS = [
  /^mailto:/i,
  /\.(png|jpg|jpeg|gif|svg|ico|pdf|zip|gz|tar)(\?|$)/i,
  /^#/,
];

function shouldSkip(url: string, selfKey: string): boolean {
  if (SELF_LINK_PATTERNS.some(p => p.test(url))) return true;
  if (url.includes(`/browse/${selfKey}`)) return true;
  if (url.includes(`/${selfKey}`)) return true;
  return false;
}

export function extractLinks(texts: string[], selfKey: string, maxLinks = 5): ExtractedLink[] {
  const seen = new Set<string>();
  const results: ExtractedLink[] = [];
  const combined = texts.join('\n');

  const patterns: [RegExp, ExtractedLink['type']][] = [
    [new RegExp(JIRA_PATTERN.source, 'g'), 'jira'],
    [new RegExp(CONFLUENCE_PATTERN.source, 'g'), 'confluence'],
    [new RegExp(GITHUB_PATTERN.source, 'g'), 'github'],
    [new RegExp(DOCS_PATTERN.source, 'g'), 'docs'],
    [new RegExp(GENERIC_URL_PATTERN.source, 'g'), 'generic'],
  ];

  for (const [pattern, type] of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(combined)) !== null) {
      const url = match[0].replace(/[.,;:!?)]+$/, '');
      if (shouldSkip(url, selfKey)) continue;
      if (seen.has(url)) continue;
      seen.add(url);

      const idx = match.index;
      const context = combined.slice(Math.max(0, idx - 60), Math.min(combined.length, idx + url.length + 60)).trim();

      results.push({ url, type, context });
      if (results.length >= maxLinks) return results;
    }
  }

  return results;
}
