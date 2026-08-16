import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'Work Intelligence MCP',
  tagline: 'AI-powered work communications intelligence — Teams, Outlook, Jira',
  favicon: 'img/favicon.svg',
  url: 'http://localhost:3000',
  baseUrl: '/',
  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',

  markdown: {
    mermaid: true,
  },

  themes: [
    '@docusaurus/theme-mermaid',
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        language: ['en'],
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
        indexDocs: true,
        indexBlog: false,
        indexPages: false,
      },
    ],
  ],

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: '/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'Work Intelligence MCP',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'mainSidebar',
          position: 'left',
          label: 'Documentation',
        },
        {
          to: '/backlog-dashboard',
          position: 'left',
          label: 'Backlog',
        },
        {
          type: 'search',
          position: 'right',
        },
        {
          href: 'https://github.com/your-org/work-intelligence-mcp',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Quick Start', to: '/getting-started/quick-start' },
            { label: 'Architecture', to: '/architecture' },
            { label: 'API Reference', to: '/api-reference' },
          ],
        },
        {
          title: 'Backlog',
          items: [
            { label: 'All Epics', to: '/backlog-dashboard' },
            { label: 'EP-1: Browser Session', to: '/epics/ep1-browser-session' },
            { label: 'EP-2: Teams Scraper', to: '/epics/ep2-teams-scraper' },
          ],
        },
        {
          title: 'Architecture',
          items: [
            { label: 'ADR-001: Browser Extraction', to: '/adr/adr-001-browser-extraction' },
            { label: 'ADR-002: Single Server', to: '/adr/adr-002-single-server' },
            { label: 'Multi-MCP Vision', to: '/architecture#multi-mcp-vision' },
          ],
        },
      ],
      copyright: `Work Intelligence MCP — Built with Docusaurus.`,
    },
    mermaid: {
      theme: { light: 'default', dark: 'dark' },
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'typescript', 'json', 'sql'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
