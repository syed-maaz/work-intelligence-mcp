/**
 * EP-16-1/2: macOS Event-Driven Trigger System
 *
 * OutlookWatcher  — watches HxStore.hxd via fs.watch (FSEvents) for instant mail detection
 * getTeamsBadgeCount — AppleScript badge poll for Teams (no local file equivalent)
 */

import { watch, type FSWatcher } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface OutlookWatchEvent {
  type: 'jira' | 'email' | 'unknown';
  subjects: string[];
  jiraProjectKeys: string[];  // e.g. ['JIRA', 'PROJ'] from subjects like "[JIRA-234] ..."
  unreadCount: number;
}

export type OutlookWatchCallback = (event: OutlookWatchEvent) => void;

// Path to Outlook's live mail store — verified on macOS Outlook 16.x
const HXSTORE_PATH = join(
  homedir(),
  'Library/Group Containers/UBF8T346G9.Office/Outlook/Outlook 15 Profiles/Main Profile/HxStore.hxd'
);

// Debounce: HxStore gets multiple writes per mail arrival — wait 2s for them to settle
const DEBOUNCE_MS = 2000;

const JIRA_DOMAIN = process.env.JIRA_DOMAIN ?? 'jira.example.com';

const JIRA_PATTERNS = [
  new RegExp(JIRA_DOMAIN.replace(/\./g, '\\.'), 'i'),
  /\[jira\]/i,
  /jira notification/i,
  /atlassian/i,
];

function runAppleScript(script: string): string {
  try {
    return execFileSync('osascript', ['-e', script], {
      timeout: 10_000,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function getUnreadSubjects(): string[] {
  const raw = runAppleScript(`
    tell application "Microsoft Outlook"
      try
        set msgs to (messages of inbox whose is read is false)
        set msgCount to count of msgs
        if msgCount = 0 then return ""
        set subjects to {}
        repeat with i from 1 to msgCount
          set end of subjects to subject of (item i of msgs)
        end repeat
        return subjects
      on error
        return ""
      end try
    end tell
  `);
  if (!raw) return [];
  return raw.split(', ').map(s => s.trim()).filter(Boolean);
}

function getUnreadCount(): number {
  const raw = runAppleScript(
    'tell application "Microsoft Outlook" to count (messages of inbox whose is read is false)'
  );
  const n = parseInt(raw, 10);
  return isNaN(n) ? -1 : n;
}

function extractProjectKeys(subjects: string[]): string[] {
  const keys = new Set<string>();
  for (const s of subjects) {
    for (const m of s.matchAll(/\b([A-Z]{2,8})-\d+\b/g)) {
      keys.add(m[1]);
    }
  }
  return [...keys];
}

export class OutlookWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUnreadCount = -1;
  private callback: OutlookWatchCallback;

  constructor(callback: OutlookWatchCallback) {
    this.callback = callback;
  }

  start(): boolean {
    try {
      // Seed initial unread count so first fire only triggers on actual new mail
      this.lastUnreadCount = getUnreadCount();

      this.watcher = watch(HXSTORE_PATH, () => {
        // Debounce: multiple rapid writes happen per mail — wait for them to settle
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.handleChange(), DEBOUNCE_MS);
      });

      this.watcher.on('error', (err: Error) => {
        process.stderr.write(`[OutlookWatcher] fs.watch error: ${err.message}\n`);
      });

      process.stderr.write(
        `[OutlookWatcher] Watching HxStore.hxd — initial unread: ${this.lastUnreadCount}\n`
      );
      return true;
    } catch (err) {
      process.stderr.write(
        `[OutlookWatcher] Could not start — HxStore.hxd not found or not readable: ${(err as Error).message}\n`
      );
      return false;
    }
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
    this.watcher = null;
  }

  private handleChange(): void {
    const currentCount = getUnreadCount();

    // File changed but unread count didn't increase — read/delete/move event, not new mail
    if (currentCount !== -1 && currentCount <= this.lastUnreadCount) {
      this.lastUnreadCount = currentCount;
      return;
    }

    // New mail arrived
    const subjects = getUnreadSubjects();
    this.lastUnreadCount = currentCount;

    const hasJira = subjects.some(s => JIRA_PATTERNS.some(p => p.test(s)));
    const jiraKeys = extractProjectKeys(subjects);

    process.stderr.write(
      `[OutlookWatcher] New mail: ${subjects.length} unread | Jira: ${hasJira} | Keys: ${jiraKeys.join(', ') || 'none'}\n`
    );

    this.callback({
      type: hasJira ? 'jira' : subjects.length > 0 ? 'email' : 'unknown',
      subjects,
      jiraProjectKeys: jiraKeys,
      unreadCount: currentCount,
    });
  }
}

// ── EP-16-2: Teams badge poll via AppleScript ──────────────────────────────

/**
 * Read Teams dock badge (unread message count) via AppleScript.
 * Returns -1 if Teams is not running or Accessibility permissions are not granted.
 * Requires: System Preferences → Privacy & Security → Accessibility → node/terminal
 */
export function getTeamsBadgeCount(): number {
  const raw = runAppleScript(`
    tell application "System Events"
      try
        if not (exists process "MSTeams") then return -1
        set badgeList to value of attribute "AXStatusLabel" of ¬
          (first button of (first tab group of (first window of process "MSTeams")))
        if badgeList is missing value then return 0
        return badgeList
      on error
        return -1
      end try
    end tell
  `);
  if (raw === '-1' || raw === '') return -1;
  if (raw === '0') return 0;
  // Badge shows "3" or "3+" — extract the number
  const n = parseInt(raw.replace(/\D/g, ''), 10);
  return isNaN(n) ? 0 : n;
}
