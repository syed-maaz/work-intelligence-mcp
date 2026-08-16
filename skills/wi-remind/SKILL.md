---
name: wi-remind
description: "Smart reminder skill — create, list, or detect reminders from chat/email. Fires to Apple Reminders (phone/Mac) and/or the Atlas morning brief. Understands natural language: 'remind me to do X by Friday', 'what do I need to remember?', 'scan my messages for deadlines'."
trigger_phrases:
  - "remind me"
  - "set a reminder"
  - "reminder about"
  - "detect reminders from chat"
argument-hint: "[natural language reminder request | list | detect | snooze <id>]"
allowed-tools:
  - Bash
---

<objective>
Manage reminders intelligently across Apple Reminders and the Atlas morning brief.

Arguments: "$ARGUMENTS"

Three modes — detect from arguments which applies:
- **Detect/scan** — "scan my messages", "what should I be reminded of?", "what have I missed?", no args
- **List** — "list my reminders", "what reminders do I have?", "show reminders"
- **Create** — anything that sounds like "remind me to X", "don't let me forget X", "set a reminder for X"
</objective>

<process>

## Mode 1 — Detect (scan messages + email for missed deadlines)

Run detect + list in parallel:
```bash
curl -s -X POST http://localhost:3132/api/reminders/detect | head -c 6000
curl -s "http://localhost:3132/api/reminders?status=pending" | head -c 3000
```

Render:
### Already set
List existing pending reminders (due date, title, channel).

### Spotted in your recent messages
For each suggestion (score ≥ 2 first, then score 1):
- Show: source, author, snippet, and a **proposed reminder title + due date** (infer from snippet)
- Ask: "Want me to set this? [yes / skip / set for <date>]"

For each the user confirms, call:
```bash
curl -s -X POST http://localhost:3132/api/reminders \
  -H "Content-Type: application/json" \
  -d '{"title":"<title>","due_at":"<inferred_date>","channel":"both","priority":"medium"}'
```

Always also check for the two known recurring obligations:
- Time/activity recording → due every 25th. If today is between 20th–25th and no reminder exists for it, propose one.
- Training platform reminders (e.g., corporate learning systems) → check if any message from last 14 days mentions "training", "course", "learning". If yes, propose a reminder.

---

## Mode 2 — List

```bash
curl -s "http://localhost:3132/api/reminders?status=pending" | head -c 4000
```

Render as a clean table:
| # | Title | Due | Recurrence | Channel |
|---|-------|-----|------------|---------|

Flag anything due today or overdue in **bold**.

---

## Mode 3 — Create

Parse the natural language request. Extract:
- **title** — what to be reminded of (required)
- **due_at** — when (required; convert relative phrases to ISO datetime)
  - "tomorrow morning" → next day at 09:00
  - "every 25th" / "25th of the month" → next occurrence of the 25th at 09:00, recurrence=monthly
  - "end of day Friday" → this Friday at 17:30
  - "in 2 hours" → now + 2h
- **recurrence** — if repeating (daily/weekly/biweekly/monthly/yearly)
- **channel** — default `both` (Apple Reminders phone notification + Atlas brief)
- **priority** — default `medium`; use `high` if user says "urgent", "critical", "don't miss"

Then create:
```bash
curl -s -X POST http://localhost:3132/api/reminders \
  -H "Content-Type: application/json" \
  -d '{
    "title": "<title>",
    "due_at": "<ISO datetime>",
    "recurrence": "<recurrence or omit>",
    "channel": "both",
    "priority": "<priority>",
    "notes": "<any extra context from the user>"
  }'
```

Confirm back:
> ✓ Reminder set: **"<title>"** — <human-readable due> [repeats <recurrence>]
> Apple Reminders: <created or failed>

If `apple_reminder_created: false` in the response, warn: "Apple Reminder failed — check that remindctl has Reminders permission."

---

## Built-in recurring reminders (always propose on first use)

If the user has never asked about these before, proactively mention:

1. **Time/activity recording** — due every 25th. Propose:
   - Apple Reminder on 23rd at 09:00 (early warning, monthly)
   - Apple Reminder on 25th at 09:00 (day-of, monthly, high priority)

2. **Training platform (corporate learning)** — no fixed cadence. Propose:
   - Apple Reminder every Monday at 09:00 to check training inbox

Ask: "Want me to set these up now?"

---

## Smart patterns to recognise

| What user says | Action |
|---|---|
| "remind me to X by Y" | Create, due=Y |
| "don't let me forget X" | Create, due=tomorrow 09:00 unless specified |
| "every 25th I need to do time recording" | Create, recurrence=monthly, due=next 25th |
| "manager keeps reminding me about X" | Create + note "proactive — beat your manager to it" |
| "what should I remember?" / no args | Detect mode |
| "scan my messages for deadlines" | Detect mode |
| "list reminders" / "show reminders" | List mode |
| "delete reminder X" | `curl -s -X DELETE http://localhost:3132/api/reminders/<id>` |

</process>
