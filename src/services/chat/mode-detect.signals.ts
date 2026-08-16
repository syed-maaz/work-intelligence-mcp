/**
 * Signal weights, vocabularies, and pure matcher helpers for the heuristic
 * mode detector (78a-02 / SPEC item 1).
 *
 * NO module-side effects. NO I/O. Every helper is a pure function over its
 * input string.
 *
 * Adversarial fix #1 lives here: `IMPERATIVE_VERBS` MUST contain the canary
 * verb `investigate`, and `findImperativeSignals()` must word-boundary-match
 * it so that `"I'm exhausted, investigate JIRA-15702"` produces an
 * `imperative:investigate` signal worth +8.
 */

export const WEIGHTS = {
  slash: 10,
  jira: 5,
  fileRef: 5,
  prRef: 5,
  imperative: 8,
  mood: 5,
  family: 5,
  /** Work-vocabulary words without a hard referent — "tomorrow", "tasks", "meeting", etc. Lighter than imperative since context-only. */
  workContext: 4,
  persistence: 2,
} as const;

/** Lowercase imperative verbs. Order is irrelevant — matching is set-like. */
export const IMPERATIVE_VERBS: readonly string[] = [
  'investigate',
  'fix',
  'debug',
  'ship',
  'review',
  'open',
  'draft',
  'deploy',
  'run',
  'refactor',
  'test',
  'verify',
  'build',
  'write',
  'edit',
  'update',
  'add',
  'remove',
  'delete',
  'search',
  'find',
  'show',
  'list',
  'check',
  'look at',
  'figure out',
];

export const MOOD_WORDS: readonly string[] = [
  'stressed',
  'exhausted',
  'tired',
  'anxious',
  'frustrated',
  'overwhelmed',
  'sad',
  'happy',
  'excited',
  'worried',
  'nervous',
  'fed up',
  'drained',
];

export const FAMILY_WORDS: readonly string[] = [
  'wife',
  'husband',
  'partner',
  'kid',
  'kids',
  'son',
  'daughter',
  'mum',
  'mom',
  'dad',
  'parents',
  'family',
  'weekend',
  'birthday',
  'anniversary',
  'dinner',
  'vacation',
  'sick',
  'doctor',
  'school',
  'holiday',
];

/**
 * Work-context vocabulary — phrases that imply WORK mode without naming a
 * specific Jira key, file, or PR. Catches the everyday "what do I need to
 * do tomorrow" / "show me my tasks" / "what's on my plate" cases that were
 * landing in the empty-signals AMBIGUOUS short-circuit (Phase 82c bugfix).
 *
 * Lower weight (4) than imperative (8) so a single workContext hit alone
 * yields a low-confidence WORK verdict — the LLM downstream still gets the
 * call but knows to interpret as work.
 */
export const WORK_CONTEXT_WORDS: readonly string[] = [
  'tomorrow',
  'today',
  'this week',
  'next week',
  'sprint',
  'standup',
  'stand-up',
  'meeting',
  'meetings',
  'task',
  'tasks',
  'todo',
  'to-do',
  'action item',
  'action items',
  'agenda',
  'deadline',
  'pr',
  'jira',
  'ticket',
  'tickets',
  'backlog',
  'roadmap',
  'release',
  'deployment',
  'on my plate',
  'my work',
  'my queue',
  'priorities',
  'priority',
  'blockers',
  'blocked',
];

export const JIRA_KEY_RE = /\b[A-Z][A-Z0-9_]+-\d+\b/g;
export const SLASH_RE = /\B\/[a-z][\w-]*/g;
export const FILE_REF_RE = /\b(?:src|tests|web|repos|scripts|docs)\/[\w./-]+/g;
export const PR_REF_RE = /\b(?:PR|pull request|#)\s*#?\d+\b/gi;

/** Escape a literal phrase for inclusion inside a RegExp source. */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a single case-insensitive regex that word-boundary matches any phrase
 * in the supplied vocabulary. Multi-word phrases (e.g. "look at", "fed up")
 * are handled by escaping each phrase, with `\b` anchoring on both sides.
 */
function buildPhraseRegex(vocab: readonly string[]): RegExp {
  const alternation = vocab
    .map(escapeForRegex)
    .sort((a, b) => b.length - a.length) // longest-first so "look at" wins over "look"
    .join('|');
  return new RegExp(`\\b(?:${alternation})\\b`, 'gi');
}

const IMPERATIVE_RE = buildPhraseRegex(IMPERATIVE_VERBS);
const MOOD_RE = buildPhraseRegex(MOOD_WORDS);
const FAMILY_RE = buildPhraseRegex(FAMILY_WORDS);
const WORK_CONTEXT_RE = buildPhraseRegex(WORK_CONTEXT_WORDS);

function uniq(items: string[]): string[] {
  return Array.from(new Set(items));
}

/** All matches of `re` against `message`, returned as a fresh array. */
function allMatches(message: string, re: RegExp): string[] {
  const out: string[] = [];
  // Reset lastIndex to support global regex reuse.
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    out.push(m[0]);
    if (m.index === re.lastIndex) {
      // Guard against zero-length matches in pathological inputs.
      re.lastIndex++;
    }
  }
  return out;
}

export function findSlashSignals(message: string): string[] {
  return uniq(allMatches(message, SLASH_RE).map((m) => `slash:${m}`));
}

export function findJiraSignals(message: string): string[] {
  return uniq(allMatches(message, JIRA_KEY_RE).map((m) => `jira:${m}`));
}

export function findFileRefSignals(message: string): string[] {
  return uniq(allMatches(message, FILE_REF_RE).map((m) => `fileRef:${m}`));
}

export function findPRRefSignals(message: string): string[] {
  return uniq(
    allMatches(message, PR_REF_RE).map((m) => `prRef:${m.trim()}`)
  );
}

export function findImperativeSignals(message: string): string[] {
  return uniq(
    allMatches(message, IMPERATIVE_RE).map((m) => `imperative:${m.toLowerCase()}`)
  );
}

export function findMoodSignals(message: string): string[] {
  return uniq(
    allMatches(message, MOOD_RE).map((m) => `mood:${m.toLowerCase()}`)
  );
}

export function findFamilySignals(message: string): string[] {
  return uniq(
    allMatches(message, FAMILY_RE).map((m) => `family:${m.toLowerCase()}`)
  );
}

export function findWorkContextSignals(message: string): string[] {
  return uniq(
    allMatches(message, WORK_CONTEXT_RE).map((m) => `workContext:${m.toLowerCase()}`)
  );
}

/**
 * True iff the message contains at least one explicit referent: a slash
 * command, a Jira key, a file path, or a PR ref. Used by the AMBIGUOUS gate
 * (CHAT-05 / adversarial fix #3) to ensure clarification only fires when no
 * concrete anchor is present.
 */
export function hasExplicitReferent(message: string): boolean {
  return (
    findSlashSignals(message).length > 0 ||
    findJiraSignals(message).length > 0 ||
    findFileRefSignals(message).length > 0 ||
    findPRRefSignals(message).length > 0
  );
}
