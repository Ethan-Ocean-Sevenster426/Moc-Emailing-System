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
| Backend | Django, **MySQL**, AWS SES via boto3 |
| Frontend | Next.js (App Router), React, Tailwind CSS, TypeScript |

## Local setup

### 1. Database (MySQL)

```sql
CREATE DATABASE moc_emailing CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'moc'@'localhost' IDENTIFIED BY 'your-mysql-password';
GRANT ALL PRIVILEGES ON moc_emailing.* TO 'moc'@'localhost';
FLUSH PRIVILEGES;
```

### 2. Backend

```bash
# Ubuntu build deps for mysqlclient:
sudo apt install -y python3-venv build-essential pkg-config default-libmysqlclient-dev

cd backend
python3 -m venv .venv && source .venv/bin/activate   # Linux
pip install -r requirements.txt
cp .env.example .env                                  # fill in MySQL creds + AWS SES values
python manage.py migrate
python manage.py createsuperuser
python manage.py runserver                            # http://localhost:8000
```

### 3. Frontend

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
