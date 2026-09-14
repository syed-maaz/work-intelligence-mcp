# Changelog

All notable changes to this project. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] — first public release

Extracted and sanitized from a private development repository (~1,300 commits over ~4 months).

### Included
- Agentic tool-use loop (SCOPE → EXECUTE → verdict) with mechanical, no-LLM-as-judge grading
- 9-lane memory recall with reciprocal-rank fusion
- Connector adapter interface (Jira, GitHub, Outlook/Teams, Slack, Linear)
- One-command setup + fictional demo corpus (`npm run setup && npm run demo`)
- Held-out evaluation harness with human-authored gold labels
- Bridge HTTP API + local web UI
- Configuration front door (`wi.config.json`, validated by schema)

### Security
- Automated leak scanning (pattern + name deny-lists) in local hooks and CI
- gitleaks in CI
- Public repo contains no employer data, secrets, or PII (verified by scans)

### Notes
- Local-first: data stays in a local SQLite database; model calls use your own API key
