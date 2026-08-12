# Beacon UI Reference (extracted from the real Helix source)

Source: `C:\Users\ethan\OneDrive\Desktop\Eclick Software\Source Code\Helix\`
(HELIX-BEACON shell + HELIX-CORE components BE00001–BE00009). This app clones
Beacon's UI; use this file as the spec when building/reviewing pages.

## Theme
- Filament panel, brand "Beacon", primary color **Rose** (`Color::Rose`).
- Inter font, gray-50 canvas, white cards with `ring-1 ring-gray-950/5`.

## Sidebar (nav group "Beacon", in order)
| Label | Heroicon | Notes |
|---|---|---|
| Campaigns & Flows | envelope | sort 10 |
| Template Library | squares-2x2 | sort 20 |
| Contacts | identification | sort 30 · warning badge = pending reactivation count, tooltip "Opted-out contacts waiting for approval" |
| Schedule | calendar-days | sort 38 (singular!) |
| Send Progress | paper-airplane | sort 40 |
| Reporting | chart-bar | sort 50 |
| Users | users | sort 60 |

Hidden from nav (reached via buttons): Import Groups ("Groups & segments"),
Segments, Segmentation, Tags, Custom fields.

## Campaign flow board (campaign-manage.blade.php + ManageCampaign.php)
- Heading = campaign name; subheading "The journey: emails and the waits between them."
- Header actions: **Start campaign flow** (green, play icon) · **Add touchpoint** (plus) · **Use template** (gray, bookmark-square) · **Save as template** (gray, bookmark).
- Board: max-width 640px centered column. Tile: 1px gray-alpha border, radius ~.7rem;
  blue number chip (bg blue-600/10, text #1d4ed8, extrabold); "Touchpoint N" bold +
  subject line ("No subject yet — click to edit"); pills **Ready** (green) / **Empty** (gray);
  buttons **Edit** (solid blue #2563eb) · **Test** (outline) · **✕** (outline red).
- Tile second row (padding-left 2.7rem): pills "{received} of {audience} received" (blue),
  "{soft} soft · {hard} hard bounces" (gray→amber→red by severity), optional holiday ⚠ pill.
- Between tiles: 2px vertical lines + wait pill (clock icon, "Wait 7 days" / "No wait — sends
  immediately") + small ✕ to remove the wait.
- Under each tile a Mailchimp-style split: left lane "STAYED · CONTINUES" green pill + trunk
  line down; right lane 22px amber connector to either the goodbye card (1.5px amber border,
  "OPTED OUT" pill + "Goodbye email" + Ready/Empty, subject, Edit [amber-700 solid] / Test /
  Remove) or a dashed amber "+ Add an opt-out goodbye email" button.
- Bottom: dashed "+ Add touchpoint" full-width button.
- Modals: Test = "Test email N" / "Sends just this email, marked [TEST]… real sending always
  happens in order." submit "Send test", "Send to" prefilled with own email, comma-separated.
  Delete = "Delete Touchpoint N?" / "Its content and schedule are removed. Past sends keep
  their history." Wait = "Wait before Touchpoint N", units grid + optional "Then send at".
  Goodbye = "Goodbye email — if they opt out after Touchpoint N" (same editor as touchpoints).
  Start flow = radio Run now / Schedule it + Launch at + target group/segments/tags + test-run
  toggle ("Test run — send the whole journey to specific emails right now, waits skipped").

## Contacts (BE00003)
- Header actions: "Groups & segments" (rectangle-stack, gray) · "Pending approval (N)"
  (clock, warning when N>0) · "Import clients" (arrow-up-tray, gray) · Create.
- Status badges: success=active, gray=inactive, danger=undeliverable+opted out, warning=moved to HubSpot.
- Import modal (5xl, submit "Import"): left "File & target" (file, group, segment, tags);
  right "Fields to import" — clickable chips per field ("Click the fields you want — they light
  up when selected — then choose which spreadsheet column feeds each."), "Add a field" /
  "Remove a field", then "Email column" (required) + per-field column selects.
- Pending approval page: subheading "N opted-out contacts are waiting for your approval.";
  columns Organisation/Contact/Email/"Why they opted out"/"Seen in an import"; row actions
  "Make active" (check, success) / "Keep opted out" (no-symbol, gray). Empty state:
  "Nothing waiting for approval".
- Reactivation history: title "Who was approved", subheading "Every opted-out contact that
  was made active again, and who approved it."
- Public opt-out page: centered white card on #f5f5f7, max 430px; optional "Reason (optional)"
  textarea ("Tell us why, so we can do better…"), crimson "Unsubscribe me" button.

## Send Progress + Schedule (BE00004)
- Send Progress heading + "Track sends live — click any send to see exactly who received it
  and what happened." Header: "New Send".
- Active send card: blue accent, numbered tile, "Sending…" ping pill, giant counter, "Sending
  to <email>", gradient bar, pills Sent/Failed/Skipped.
- History: "History — newest first", filter toolbar (funnel + Filter, selects, "Only with
  failures" red pill, "Clear filters ✕"); cards clickable → sendDetail modal: 4 tiles
  (Arrived with %, Failed, Skipped, Recipients), "Why they failed" bars, grouped per-person
  sections, footer "See the full report for this campaign →".
- Schedule page: "Plan campaigns ahead and see what went out, what worked, and what's coming
  up." Sections "Coming up" (dashed cards, buttons green Run now / blue Edit / red-outline
  Turn off & cancel; label/value list Starts / Going to / "Its N emails") and "Already went
  out" ("The N most recent sends — the full, searchable history is on Send Progress.",
  verdict pills Worked / "Worked, N failed" / Failed / Cancelled).

## Reporting (BE00005)
Sections in order: filter toolbar · campaign focus banner · "Results at a glance" (People
reached, Emails per person, Audience growth, List quality grade A–E) + "Audience added vs
lost — last 8 weeks" mini chart · KPI row (Emails sent #6366f1, Arrived safely #10b981,
People you can email #0ea5e9, Opted out #f59e0b, Became leads #3b82f6) · donut "Who's in
your contact list" + "Emails sent per day" · "Sent by campaign" · "Campaign scorecard"
table · "How far people got" funnel + "Weekday vs weekend sending" (Heads up / All good
badge + drill-down) · "How each email performs" per-touchpoint bars · "Audience by group" +
"Recent sends" · "Bounces — emails that couldn't be delivered" (soft/hard split bar, "Dead
addresses — latest 10", "See all N dead addresses in Contacts →") · "Opt-outs" (tiles +
"How they opted out" chips + By organisation + Most recent).
Bounce categories: Invalid address — mailbox does not exist / Mailbox full / over quota /
Blocked or marked as spam / Rejected by recipient server / Connection problem / timeout /
Other failure.

## Users (BE00006)
Table: name · email · "User type" · Active (icon) · created (hidden). "New user" modal;
edit page; user_type select has only "User"; no delete in the UI.

## Wording conventions
Sentence-case buttons; destructive modals explain what is NOT affected; submit labels are
the action ("Yes, delete them", "Put it on the schedule"); notifications = short title +
explanatory body; uppercase letter-spaced slate mini-headings inside custom views.
