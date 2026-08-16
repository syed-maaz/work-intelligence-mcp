/**
 * U-19 — Shared vocabulary for the web UI.
 */

export interface GlossaryEntry {
  term: string;
  meaning: string;
  notTheSameAs?: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  {
    term: 'Topic',
    meaning: 'A monitored work theme in SQLite (Teams channels, email folders, Jira filters). Configured on the Topics page.',
    notTheSameAs: 'Jira project key (e.g. PROJ) or a Teams channel name alone.',
  },
  {
    term: 'Jira project',
    meaning: 'Jira project key (e.g. DEMO). Issues belong to a project; the Saturn board is one rapid view over a project.',
  },
  {
    term: 'Saturn board',
    meaning: 'Default rapid board URL for the configured project. Used by Jira Report and sync.',
  },
  {
    term: 'Brain decision',
    meaning: 'Structured answer from POST /api/brain/decide — decision, rationale, evidence, confidence. Stored in brain_decisions.',
  },
  {
    term: 'Proactive message',
    meaning: 'Agent-written alert in the chat feed (meeting prep, pattern match, scored alert). Not the same as a Sonner toast.',
  },
  {
    term: 'Investigation',
    meaning: 'ReAct bug trace for one Jira ticket (git, flags, code). Conclusion is separate from the raw trace.',
  },
  {
    term: 'Digest',
    meaning: 'AI daily summary for a topic + date. Cached in the digests table.',
  },
  {
    term: 'Palace / MemPalace',
    meaning: 'Optional knowledge graph + semantic recall (Python sidecar). When offline, recall is SQLite-only.',
  },
];
