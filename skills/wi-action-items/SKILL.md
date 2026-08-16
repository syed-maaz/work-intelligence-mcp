---
name: wi-action-items
description: "List your open action items across all sources (Jira, Teams, Email). Filter by assignee, status, or topic."
trigger_phrases:
  - "show me my open action items"
  - "what do i owe people"
  - "open action items across jira teams email"
  - "what am i on the hook for"
  - "tasks assigned to me"
argument-hint: "[--assignee <name>] [--topic <name>] [--status open|all]"
allowed-tools:
  - Bash
  - mcp__work-intelligence__get_action_items
---

<objective>
Retrieve and display action items from Work Intelligence.

Arguments: "$ARGUMENTS"
Parse flags: --assignee (default: me), --topic, --status (default: open).
</objective>

<process>
1. Parse flags. Build query params.

2. Fetch action items:
   ```bash
   curl -s "http://localhost:3132/api/action-items?status=<STATUS>&assignee=<ASSIGNEE>&topic=<TOPIC>" | head -c 6000
   ```

3. Also check pending review queue (items awaiting confirmation):
   ```bash
   curl -s "http://localhost:3132/api/action-items/pending-review" | head -c 3000
   ```

4. Render:

   ### Open Action Items
   Grouped by source (Jira / Teams / Email).
   For each: description, assignee, source ticket/chat, due date, days open.
   Flag overdue items (past due date).

   ### Pending Review
   Items extracted by AI that haven't been confirmed yet.
   For each: show extract + source excerpt. Offer confirm / dismiss.

5. For each overdue item, offer: "Investigate why this is stuck? → /wi-investigate <KEY>"
</process>
