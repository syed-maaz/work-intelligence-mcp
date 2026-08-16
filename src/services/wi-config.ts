import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface JiraMcpConfig {
  clientName: string;
  url: string;
  tokenEnvVar: string;
}

export interface JiraBrowserConfig {
  baseUrl: string;
  profilePathEnvVar: string;
  headlessEnvVar: string;
}

export interface JiraConfig {
  enabled: boolean;
  mode: 'mcp' | 'browser' | 'both';
  mcp: JiraMcpConfig;
  browser: JiraBrowserConfig;
  defaultList: string;
  boardUrl: string;
}

export interface GitHubMcpConfig {
  url: string;
  tokenEnvVar: string;
}

export interface GitHubApiConfig {
  baseUrl: string;
  tokenEnvVar: string;
}

export interface GitHubConfig {
  enabled: boolean;
  mode: 'mcp' | 'api' | 'both';
  mcp: GitHubMcpConfig;
  api: GitHubApiConfig;
  /** Enterprise GitHub host (e.g. github.tools.corp.example.com). Empty = public github.com only. */
  enterpriseHost: string;
}

export interface SlackApiConfig {
  tokenEnvVar: string;
  teamIdEnvVar: string;
}

export interface SlackConfig {
  enabled: boolean;
  mode: 'mcp' | 'api';
  api: SlackApiConfig;
}

export interface LinearApiConfig {
  apiKeyEnvVar: string;
}

export interface LinearConfig {
  enabled: boolean;
  mode: 'api';
  api: LinearApiConfig;
}

export interface TeamsBrowserConfig {
  profilePathEnvVar: string;
  headlessEnvVar: string;
}

export interface TeamsGraphConfig {
  tenantIdEnvVar: string;
  clientIdEnvVar: string;
  clientSecretEnvVar: string;
}

export interface TeamsConfig {
  enabled: boolean;
  mode: 'browser' | 'graph';
  browser: TeamsBrowserConfig;
  graph: TeamsGraphConfig;
}

export interface OutlookBrowserConfig {
  profilePathEnvVar: string;
  headlessEnvVar: string;
}

export interface OutlookGraphConfig {
  tenantIdEnvVar: string;
  clientIdEnvVar: string;
  clientSecretEnvVar: string;
}

export interface OutlookConfig {
  enabled: boolean;
  mode: 'browser' | 'graph';
  browser: OutlookBrowserConfig;
  graph: OutlookGraphConfig;
}

export interface ConnectorsConfig {
  jira: JiraConfig;
  github: GitHubConfig;
  slack: SlackConfig;
  linear: LinearConfig;
  teams: TeamsConfig;
  outlook: OutlookConfig;
}

export interface RepoConfig {
  name: string;
  localPath: string;
  githubSlug?: string;
  defaultBranch?: string;
}

export interface MemPalaceConfig {
  pathEnvVar: string;
  embeddingsProvider: 'ollama' | 'openai' | 'huggingface';
  ollamaModel: string;
}

export interface DatabaseConfig {
  pathEnvVar: string;
}

export interface BridgeConfig {
  port: number;
  allowedOriginsEnvVar: string;
  tokenEnvVar: string;
}

export interface FeaturesConfig {
  cypherLoopEnabled: boolean;
  pmOrchestrationEnabled: boolean;
  pmAgentEnabled: boolean;
  stage1Enabled: boolean;
  syncIntervalMs: number;
}

export interface WiConfig {
  version: string;
  connectors: ConnectorsConfig;
  repos: RepoConfig[];
  mempalace: MemPalaceConfig;
  database: DatabaseConfig;
  bridge: BridgeConfig;
  features: FeaturesConfig;
}

let cachedConfig: WiConfig | null = null;

/** Drop the cached config so the next getWiConfig() re-reads wi.config.json
 *  from disk. Used by config-adjacent surfaces (setup wizard) where a user
 *  edits wi.config.json and expects the change without a bridge restart. */
export function clearWiConfigCache(): void {
  cachedConfig = null;
}

export function loadWiConfig(configPath?: string): WiConfig {
  if (cachedConfig) return cachedConfig;

  const resolvedPath = configPath ?? path.resolve(__dirname, '..', '..', 'wi.config.json');
  
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`wi.config.json not found at ${resolvedPath}. Copy wi.config.json.example to wi.config.json and configure.`);
  }

  const content = fs.readFileSync(resolvedPath, 'utf-8');
  cachedConfig = JSON.parse(content) as WiConfig;
  
  if (cachedConfig.version !== '1.0') {
    throw new Error(`Unsupported config version: ${cachedConfig.version}. Expected 1.0`);
  }

  return cachedConfig;
}

export function getWiConfig(): WiConfig {
  if (!cachedConfig) {
    return loadWiConfig();
  }
  return cachedConfig;
}

export function getJiraConfig(): JiraConfig {
  return getWiConfig().connectors.jira;
}

export function getGitHubConfig(): GitHubConfig {
  return getWiConfig().connectors.github;
}

export function getGitHubEnterpriseHost(): string {
  return getGitHubConfig().enterpriseHost ?? '';
}

export function getSlackConfig(): SlackConfig {
  return getWiConfig().connectors.slack;
}

export function getLinearConfig(): LinearConfig {
  return getWiConfig().connectors.linear;
}

export function getTeamsConfig(): TeamsConfig {
  return getWiConfig().connectors.teams;
}

export function getOutlookConfig(): OutlookConfig {
  return getWiConfig().connectors.outlook;
}

export function getRepos(): RepoConfig[] {
  return getWiConfig().repos;
}

export function getRepoByName(name: string): RepoConfig | undefined {
  return getRepos().find(r => r.name === name);
}

export function getMemPalaceConfig(): MemPalaceConfig {
  return getWiConfig().mempalace;
}

export function getDatabaseConfig(): DatabaseConfig {
  return getWiConfig().database;
}

export function getBridgeConfig(): BridgeConfig {
  return getWiConfig().bridge;
}

export function getFeaturesConfig(): FeaturesConfig {
  return getWiConfig().features;
}

export function resolveEnvVar(envVar: string, fallback?: string): string {
  const value = process.env[envVar];
  if (value !== undefined) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Required environment variable ${envVar} is not set`);
}

export function getJiraMcpUrl(): string {
  const config = getJiraConfig();
  if (!config.enabled) throw new Error('Jira connector is not enabled');
  if (config.mode === 'browser') throw new Error('Jira is configured for browser mode, not MCP');
  return resolveEnvVar(config.mcp.tokenEnvVar, config.mcp.url);
}

export function getJiraMcpClientName(): string {
  const config = getJiraConfig();
  if (!config.enabled) throw new Error('Jira connector is not enabled');
  return config.mcp.clientName;
}

export function getJiraBrowserBaseUrl(): string {
  const config = getJiraConfig();
  if (!config.enabled) throw new Error('Jira connector is not enabled');
  if (config.mode === 'mcp') throw new Error('Jira is configured for MCP mode, not browser');
  return config.browser.baseUrl;
}

export function getJiraBrowseUrl(key: string): string {
  const base = getJiraBrowserBaseUrl();
  if (base) return `${base}/browse/${key}`;
  // Fallback for backward compatibility
  return `https://jira.example.com/browse/${key}`;
}

export function getJiraBoardUrl(): string {
  const config = getJiraConfig();
  const envVal = process.env['JIRA_BOARD_URL'];
  if (envVal) return envVal;
  if (config.boardUrl) return config.boardUrl;
  return '';
}

export function getGitHubCompareUrl(org: string, repo: string, base: string, head: string): string {
  const config = getGitHubConfig();
  const apiBase = config.api.baseUrl;
  const webBase = apiBase.replace(/api\.github\.com$/, 'github.com').replace(/\/api\/?$/, '');
  return `${webBase}/${org}/${repo}/compare/${base}...${head}`;
}

export function getGitHubApiBaseUrl(): string {
  const config = getGitHubConfig();
  if (!config.enabled) throw new Error('GitHub connector is not enabled');
  return config.api.baseUrl;
}

export function getGitHubApiToken(): string {
  const config = getGitHubConfig();
  if (!config.enabled) throw new Error('GitHub connector is not enabled');
  return resolveEnvVar(config.api.tokenEnvVar);
}

export function getGitHubMcpUrl(): string {
  const config = getGitHubConfig();
  if (!config.enabled) throw new Error('GitHub connector is not enabled');
  if (config.mode === 'api') throw new Error('GitHub is configured for API mode, not MCP');
  return resolveEnvVar(config.mcp.tokenEnvVar, config.mcp.url);
}

export function getDatabasePath(): string {
  const config = getDatabaseConfig();
  return resolveEnvVar(config.pathEnvVar, './data/intelligence.db');
}

export function getMemPalacePath(): string {
  const config = getMemPalaceConfig();
  return resolveEnvVar(config.pathEnvVar, path.join(process.env.HOME ?? '', '.work-intelligence-mcp', 'palace'));
}

export function getBridgePort(): number {
  const envVal = Number(process.env.PORT);
  if (!Number.isNaN(envVal) && envVal > 0) return envVal;
  return getBridgeConfig().port;
}

export function getSyncIntervalMs(): number {
  const envVal = Number(process.env.SYNC_INTERVAL_MS);
  if (!Number.isNaN(envVal) && envVal > 0) return envVal;
  return getFeaturesConfig().syncIntervalMs ?? 900_000;
}

export function getBridgeAllowedOrigins(): string[] {
  const envVar = getBridgeConfig().allowedOriginsEnvVar;
  const value = process.env[envVar];
  if (!value) return ['http://localhost:5175', 'http://127.0.0.1:5175'];
  return value.split(',').map(s => s.trim());
}

export function getBridgeToken(): string | undefined {
  const envVar = getBridgeConfig().tokenEnvVar;
  return process.env[envVar];
}

export function isFeatureEnabled(feature: keyof FeaturesConfig): boolean {
  return Boolean(getFeaturesConfig()[feature]);
}