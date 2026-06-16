# Magnum Opus Consultants — Emailing System

A B2B cold-outreach email platform built on **AWS SES**, with a Django REST backend and a Next.js frontend.

## Features

- **Campaigns (touchpoints)** — 10-stage drip sequence with strict sequencing: a contact only receives Touchpoint N once they've received N−1.
- **Per-send caps** — batch sends to stay within AWS limits (e.g. "send Touchpoint 1 to 300 of the 2,500 eligible this week").
- **Template Library** — reusable email templates with subject, HTML body, signature, signature image, and attachments.
- **Contacts** — import via CSV, statuses (Active, Inactive, Undeliverable, Opt-out, Moved to HubSpot), and only Active contacts are ever emailed.
- **Import groups & segments** — tag imports (e.g. "UK Logistics Companies") and keep growing a segment over time; target sends by group/segment.
- **Opt-out / unsubscribe** — every email carries a unique, signed opt-out link; clicking it marks the contact Opted-out and blocks all future sends (AWS-compliant).
- **Reporting dashboard** — emails sent, delivery rate, audience health, leads, opt-outs, and per-segment performance.
- **Auth** — login + OTP-secured account setup / password reset.

## Tech stack

| Layer | Stack |
|-------|-------|
| Backend | Django, SQLite (dev), AWS SES via boto3 |
| Frontend | Next.js (App Router), React, Tailwind CSS, TypeScript |

## Local setup

### 1. Backend

```bash
cd backend
python -m venv .venv && .venv/Scripts/activate    # Windows
pip install -r requirements.txt                    # or: django boto3 python-dotenv dnspython
cp .env.example .env                               # then fill in real AWS SES values
python manage.py migrate
python manage.py createsuperuser
python manage.py runserver                         # http://localhost:8000
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev                                        # http://localhost:3000
```

Sign in at **http://localhost:3000**.

## Configuration

Backend config lives in `backend/.env` (see `backend/.env.example`):

- `AWS_SES_*` — SES credentials, region, and verified sender.
- `DJANGO_SECRET_KEY` / `DJANGO_DEBUG` — Django settings.
- `PUBLIC_BASE_URL` — the public URL of the backend, used to build opt-out links in outgoing emails. **Set this to the real domain in production** or unsubscribe links won't work in real inboxes.

## Notes

- `db.sqlite3`, `backend/media/`, and `.env` are gitignored — they hold real contact data, uploaded files, and secrets.
- Only contacts with **Active** status receive email; opt-outs, bounces, and undeliverables are skipped automatically.
