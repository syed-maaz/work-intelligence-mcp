---
name: wi-pre-meeting
description: "Get pre-meeting context: attendees with recent activity, past meetings with this group, open action items, and linked Jira tickets."
trigger_phrases:
  - "pre-meeting brief"
  - "context for my meeting"
  - "who's in this meeting"
  - "meeting prep"
argument-hint: "<meeting name or calendar event ID>"
allowed-tools:
  - Bash
---

<objective>
Prepare a context card for an upcoming meeting.

Arguments: "$ARGUMENTS" — meeting name, partial name, or calendar event ID.
</objective>

<process>
1. Find the meeting in the calendar:
   ```bash
   curl -s "http://localhost:3132/api/calendar/upcoming" | head -c 5000
   ```
   Match the argument against event titles (fuzzy match on name).

2. If match found, get full context by event ID:
   ```bash
   curl -s "http://localhost:3132/api/calendar/events/<EVENT_ID>/context" | head -c 8000
   ```

3. Render the context card:

   ### Meeting: <Title>
   **Time**: <start> – <end>
   **Attendees**: <list with resolved names>

   ### Recent Activity (last 7 days)
   - Jira tickets linked to attendees or topic keywords
   - Teams messages from/to attendees on related topics

   ### Past Meetings
   - Last 3 meetings with this group: date, summary, key decisions

   ### Open Action Items
   - Items assigned to any attendee that are not yet closed

   ### Suggested Agenda Points
   - AI-generated based on open items and recent activity

4. If no match found for argument, list today's upcoming meetings and ask which one.
</process>
