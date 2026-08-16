import type Database from 'better-sqlite3';
import { addMemberAlias, getTeamMember } from '../db/queries.js';

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function normalise(s: string): string {
  return s.toLowerCase().trim();
}

// Resolve a raw display name from messages against known canonical names.
// Returns the matched canonical display_name or null.
export function resolveTeamsName(input: string, candidates: string[]): string | null {
  const norm = normalise(input);

  // 1. Exact match
  for (const c of candidates) {
    if (normalise(c) === norm) return c;
  }

  // 2. "Firstname L." → match "Firstname Lastname"
  const abbreviated = /^(\w+)\s+(\w)\.$/.exec(input.trim());
  if (abbreviated) {
    const [, first, lastInitial] = abbreviated;
    for (const c of candidates) {
      const parts = c.trim().split(/\s+/);
      if (
        parts.length >= 2 &&
        normalise(parts[0]) === normalise(first) &&
        normalise(parts[parts.length - 1][0]) === normalise(lastInitial)
      ) {
        return c;
      }
    }
  }

  // 3. Email prefix match ("alice.chen" → "Alice Chen")
  if (!input.includes(' ') && input.includes('.')) {
    const parts = input.split('.');
    for (const c of candidates) {
      const cParts = c.toLowerCase().split(/\s+/);
      if (parts.length >= 2 && cParts.length >= 2) {
        if (parts[0] === cParts[0] && parts[1].startsWith(cParts[1].slice(0, 3))) {
          return c;
        }
      }
    }
  }

  // 4. Levenshtein distance ≤ 2 (encoding diffs, typos)
  for (const c of candidates) {
    if (levenshtein(norm, normalise(c)) <= 2) return c;
  }

  return null;
}

// Scan all distinct message senders and add aliases for the given member.
// Returns the count of new aliases inserted.
export async function buildAliasesForMember(
  db: Database.Database,
  memberId: number,
): Promise<number> {
  const member = getTeamMember(db, memberId);
  if (!member) return 0;

  const candidates = [member.teams_display_name].filter(Boolean) as string[];

  const senders = db
    .prepare<[], { author: string }>('SELECT DISTINCT author FROM messages WHERE author IS NOT NULL')
    .all() as Array<{ author: string }>;

  let added = 0;
  for (const { author: sender } of senders) {
    if (!sender) continue;
    const match = resolveTeamsName(sender, candidates);
    if (match) {
      if (sender !== member.teams_display_name) {
        try {
          addMemberAlias(db, memberId, sender, 'teams');
          added++;
        } catch {
          // UNIQUE conflict — already exists, skip
        }
      }
    }
  }

  // Also add canonical display name as an alias for consistent query logic
  if (member.teams_display_name) {
    try {
      addMemberAlias(db, memberId, member.teams_display_name, 'teams');
    } catch {
      // already exists
    }
  }

  return added;
}
