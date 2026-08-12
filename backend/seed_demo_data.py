"""Seed the app with realistic demo data on every page:
campaign groups/campaigns/touchpoints (with waits + a goodbye), import groups,
segments, contacts in various states, library templates, finished send history
(with soft/hard failures for the tallies), an upcoming scheduled batch, and
pending opt-out approvals. Idempotent — safe to run again.

Run:  .venv\\Scripts\\python.exe seed_demo_data.py
"""
import os
import sys
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'backend.settings')

import django

django.setup()

from django.utils import timezone

from accounts.models import (
    Campaign, CampaignGroup, Contact, EmailTemplate, ImportGroup,
    ReactivationRequest, ScheduledSend, Segment, SendJob, SendLog,
    TouchpointTemplate, User,
)

now = timezone.now()
admin = User.objects.filter(profile__role='admin').first()

# ── Campaign groups & campaigns ──────────────────────────────────────────────
outreach, _ = CampaignGroup.objects.get_or_create(
    name='Client Outreach', defaults={'description': 'New-business journeys for prospective clients.'})
updates, _ = CampaignGroup.objects.get_or_create(
    name='Product Updates', defaults={'description': 'Keeping existing clients in the loop.'})

spring, _ = Campaign.objects.get_or_create(
    name='Spring Onboarding', group=outreach,
    defaults={'description': 'Three-step welcome journey for the spring prospect list.'})
winter, _ = Campaign.objects.get_or_create(
    name='Winter Follow-ups', group=outreach,
    defaults={'description': 'Reactivating conversations that went quiet over the holidays.'})
newsletter, _ = Campaign.objects.get_or_create(
    name='Newsletter 2026', group=updates,
    defaults={'description': 'Monthly round-up for everyone who signed up on the website.'})

SIGNATURE = 'Kind regards,\nThe Magnum Opus Consultants team\n+27 21 555 0100'

def seed_tp(campaign, n, subject, body_html, wait_minutes, send_time=None):
    tp, created = TouchpointTemplate.objects.get_or_create(
        campaign=campaign, touchpoint_number=n,
        defaults={
            'subject': subject,
            'body_html': body_html,
            'body': '',
            'signature': SIGNATURE,
            'wait_minutes': wait_minutes,
            'days_after_previous': wait_minutes // 1440,
            'send_time': send_time,
        })
    if not created and not tp.subject:
        tp.subject = subject
        tp.body_html = body_html
        tp.signature = SIGNATURE
        tp.wait_minutes = wait_minutes
        tp.days_after_previous = wait_minutes // 1440
        tp.send_time = send_time
        tp.save()
    return tp

spring_tp1 = seed_tp(spring, 1, 'Welcome to Magnum Opus, {{contact_name}}',
    '<p>Hi {{contact_name}},</p><p>Thanks for connecting with Magnum Opus Consultants — '
    'here is what we can do for {{org_name}}.</p>', 0)
spring_tp2 = seed_tp(spring, 2, 'How {{org_name}} can save on compliance',
    '<p>Hi {{contact_name}},</p><p>A quick follow-up — most firms like {{org_name}} '
    'cut their compliance overhead by a third in the first quarter.</p>', 7 * 1440, '09:00')
spring_tp3 = seed_tp(spring, 3, 'A case study for {{org_name}}',
    '<p>Hi {{contact_name}},</p><p>Here is how a company in your industry made the switch — '
    'happy to walk {{org_name}} through the same numbers.</p>', 14 * 1440, '09:00')

# Goodbye email after touchpoint 1
TouchpointTemplate.objects.get_or_create(
    campaign=spring, touchpoint_number=TouchpointTemplate.GOODBYE_OFFSET + 1,
    defaults={
        'is_goodbye': True, 'goodbye_for': 1,
        'subject': 'Sorry to see you go',
        'body_html': '<p>Hi {{contact_name}},</p><p>You have been removed from our mailing list — '
                     'no more emails from us. All the best to the team at {{org_name}}.</p>',
        'signature': SIGNATURE, 'opt_out_text': '',
    })

news_tp1 = seed_tp(newsletter, 1, 'The Magnum Opus round-up — May 2026',
    '<p>Hi {{contact_name}},</p><p>Everything worth knowing this month, in three minutes.</p>', 0)
seed_tp(newsletter, 2, 'The Magnum Opus round-up — June 2026',
    '<p>Hi {{contact_name}},</p><p>New tools, new case studies, and a webinar invite.</p>', 30 * 1440, '08:30')

seed_tp(winter, 1, 'Picking things back up, {{contact_name}}?',
    '<p>Hi {{contact_name}},</p><p>We spoke late last year — is now a better time for {{org_name}}?</p>', 0)

# ── Import groups & segments ─────────────────────────────────────────────────
sa, _ = ImportGroup.objects.get_or_create(name='South African Data')
us, _ = ImportGroup.objects.get_or_create(name='American Data')
web, _ = ImportGroup.objects.get_or_create(name='Website Leads')

gauteng, _ = Segment.objects.get_or_create(import_group=sa, name='Gauteng')
wcape, _ = Segment.objects.get_or_create(import_group=sa, name='Western Cape')
cali, _ = Segment.objects.get_or_create(import_group=us, name='California')
ny, _ = Segment.objects.get_or_create(import_group=us, name='New York')
signups, _ = Segment.objects.get_or_create(import_group=web, name='Newsletter signups')

if not newsletter.segment_id:
    newsletter.segment = signups
    newsletter.save()

# ── Contacts ─────────────────────────────────────────────────────────────────
CONTACTS = [
    # org, name, email, phone, status, group, segment, last_tp, last_campaign
    ('Acme Mining Co.', 'Thabo Nkosi', 'thabo@acmemining.example.com', '+27 11 555 0101', 'active', sa, gauteng, 2, spring),
    ('Highveld Logistics', 'Lerato Mokoena', 'lerato@highveldlog.example.com', '+27 11 555 0102', 'active', sa, gauteng, 1, spring),
    ('JoziTech Solutions', 'Sipho Dlamini', 'sipho@jozitech.example.com', '+27 11 555 0103', 'active', sa, gauteng, 1, spring),
    ('Savanna Safaris', 'Zanele Khumalo', 'zanele@savannasafaris.example.com', '+27 11 555 0104', 'active', sa, gauteng, 0, None),
    ('Cape Wine Estates', 'Anika van der Merwe', 'anika@capewine.example.com', '+27 21 555 0201', 'active', sa, wcape, 2, spring),
    ('Table Bay Tours', 'Pieter Botha', 'pieter@tablebaytours.example.com', '+27 21 555 0202', 'active', sa, wcape, 1, spring),
    ('Stellenbosch Organics', 'Marike Joubert', 'marike@sborganics.example.com', '+27 21 555 0203', 'opted_out', sa, wcape, 1, spring),
    ('Garden Route Property', 'Johan Steyn', 'johan@grproperty.example.com', '+27 44 555 0204', 'active', sa, wcape, 0, None),
    ('Golden State Media', 'Emily Carter', 'emily@gsmedia.example.com', '+1 415 555 0301', 'active', us, cali, 1, spring),
    ('Pacific Crest Foods', 'Daniel Reyes', 'daniel@pcfoods.example.com', '+1 415 555 0302', 'active', us, cali, 1, spring),
    ('Bay Area Robotics', 'Grace Lin', 'grace@bayrobotics.example.com', '+1 415 555 0303', 'active', us, cali, 0, None),
    ('Harbor Marine Supplies', 'Luke Bennett', 'luke@harbormarine.example.com', '+1 619 555 0304', 'active', us, cali, 0, None),
    ('Empire Analytics', 'Michael Ross', 'michael@empireanalytics.example.com', '+1 212 555 0401', 'active', us, ny, 2, spring),
    ('Hudson Publishing', 'Sarah Klein', 'sarah@hudsonpub.example.com', '+1 212 555 0402', 'active', us, ny, 1, spring),
    ('Brooklyn Coffee Roasters', "James O'Neil", 'james@bkroasters.example.com', '+1 718 555 0403', 'inactive', us, ny, 0, None),
    ('Liberty Legal Group', 'Rachel Adams', 'rachel@libertylegal.example.com', '+1 212 555 0404', 'active', us, ny, 0, None),
    ('Midtown Ventures', 'David Park', 'david@midtownventures.example.com', '+1 212 555 0405', 'opted_out', us, ny, 1, spring),
    ('Nordic Web Studio', 'Freja Larsen', 'freja@nordicweb.example.com', '+45 33 555 0501', 'active', web, signups, 1, newsletter),
    ('Lisbon Digital', 'Miguel Santos', 'miguel@lisbondigital.example.com', '+351 21 555 0502', 'active', web, signups, 1, newsletter),
    ('Alpine Consulting', 'Clara Meier', 'clara@alpineconsult.example.com', '+41 44 555 0503', 'active', web, signups, 1, newsletter),
    ('Kyoto Trading', 'Hana Sato', 'hana@kyototrading.example.com', '+81 75 555 0504', 'active', web, signups, 0, None),
    ('Old Mill Bakery', 'Tom Whitfield', 'tom@oldmillbakery.example.com', '+44 20 555 0601', 'undeliverable', web, None, 1, newsletter),
    ('Sunrise Fitness', 'Nina Petrova', 'nina@sunrisefit.example.com', '+359 2 555 0602', 'inactive', web, None, 0, None),
    ('Quantum Print Works', 'Oliver Grant', 'oliver@quantumprint.example.com', '+44 161 555 0603', 'moved_to_hubspot', us, None, 0, None),
]

by_email = {}
for org, name, email, phone, status, group, segment, last_tp, last_camp in CONTACTS:
    c, _ = Contact.objects.get_or_create(email=email, defaults={
        'org_name': org, 'contact_name': name, 'phone': phone, 'status': status,
        'import_group': group, 'segment': segment,
        'last_touchpoint': last_tp, 'last_campaign': last_camp,
        'opt_out_reason': 'No longer relevant to our business.' if status == 'opted_out' else '',
    })
    by_email[email] = c

# ── Library templates ────────────────────────────────────────────────────────
for name, subject, html in [
    ('Standard Intro', 'Introducing Magnum Opus Consultants',
     '<p>Hi {{contact_name}},</p><p>We help companies like {{org_name}} simplify compliance and cut costs.</p>'),
    ('Follow-up Nudge', 'Still a good time, {{contact_name}}?',
     '<p>Hi {{contact_name}},</p><p>Just floating this back to the top of your inbox.</p>'),
    ('Sorry to see you go', 'Sorry to see you go',
     '<p>Hi {{contact_name}},</p><p>You have been removed from our mailing list.</p>'),
]:
    EmailTemplate.objects.get_or_create(name=name, defaults={
        'subject': subject, 'body_html': html, 'signature': SIGNATURE, 'created_by': admin,
    })

# ── Finished send history (soft/hard failures included) ──────────────────────
def seed_job(tp, days_ago, sent, failures, skipped, status='completed', minutes_run=9):
    """failures: list of (email, error). Contacts for 'sent' rows come from the pool."""
    created = now - timedelta(days=days_ago)
    job = SendJob.objects.create(
        touchpoint=tp, status=status, started_by=admin, is_test=False,
        total_recipients=len(sent) + len(failures) + len(skipped),
        sent_count=len(sent), failed_count=len(failures), skipped_count=len(skipped),
    )
    for i, email in enumerate(sent):
        SendLog.objects.create(job=job, contact=by_email[email], status='sent',
                               message_id=f'console-email-{job.id}-{i}',
                               sent_at=created + timedelta(minutes=i))
    for email, err in failures:
        SendLog.objects.create(job=job, contact=by_email[email], status='failed', error=err)
    for email, why in skipped:
        SendLog.objects.create(job=job, contact=by_email[email], status='skipped', error=why)
    SendJob.objects.filter(id=job.id).update(
        created_at=created, completed_at=created + timedelta(minutes=minutes_run))
    return job

if not SendJob.objects.filter(touchpoint__campaign=spring).exists():
    seed_job(spring_tp1, 21,
        sent=['thabo@acmemining.example.com', 'lerato@highveldlog.example.com', 'sipho@jozitech.example.com',
              'anika@capewine.example.com', 'pieter@tablebaytours.example.com', 'emily@gsmedia.example.com',
              'daniel@pcfoods.example.com', 'michael@empireanalytics.example.com', 'sarah@hudsonpub.example.com',
              'marike@sborganics.example.com', 'david@midtownventures.example.com'],
        failures=[('tom@oldmillbakery.example.com', '550 5.1.1 User unknown — no such user here'),
                  ('nina@sunrisefit.example.com', 'Mailbox full — over quota, try again later')],
        skipped=[('james@bkroasters.example.com', 'Contact is inactive')])

    seed_job(spring_tp2, 12,
        sent=['thabo@acmemining.example.com', 'anika@capewine.example.com', 'michael@empireanalytics.example.com'],
        failures=[('luke@harbormarine.example.com', 'Connection timed out — temporary failure')],
        skipped=[('marike@sborganics.example.com', 'Contact opted out'),
                 ('david@midtownventures.example.com', 'Contact opted out')])

    seed_job(spring_tp3, 2,
        sent=['thabo@acmemining.example.com'],
        failures=[], skipped=[], status='cancelled', minutes_run=3)

if not SendJob.objects.filter(touchpoint__campaign=newsletter).exists():
    seed_job(news_tp1, 5,
        sent=['freja@nordicweb.example.com', 'miguel@lisbondigital.example.com',
              'clara@alpineconsult.example.com', 'hana@kyototrading.example.com'],
        failures=[('tom@oldmillbakery.example.com', 'Address rejected by the mail server')],
        skipped=[])

# ── Upcoming scheduled batch ('Coming up' on the Schedule page) ──────────────
if not ScheduledSend.objects.filter(batch_key='demo-spring-batch').exists():
    launch = (now + timedelta(days=1)).replace(hour=9, minute=0, second=0, microsecond=0)
    for tp, offset_days in [(spring_tp1, 0), (spring_tp2, 7), (spring_tp3, 21)]:
        ScheduledSend.objects.create(
            touchpoint=tp, import_group=sa, segment=None, limit=0,
            scheduled_for=launch + timedelta(days=offset_days),
            batch_key='demo-spring-batch', status='scheduled', created_by=admin)

# ── Pending opt-out approvals (Contacts page badge) ──────────────────────────
for email in ['marike@sborganics.example.com', 'david@midtownventures.example.com']:
    c = by_email[email]
    ReactivationRequest.objects.get_or_create(
        contact=c, status='pending',
        defaults={'source': 'Import: q3-prospects.xlsx',
                  'payload': {'org_name': c.org_name, 'contact_name': c.contact_name,
                              'email': c.email, 'phone': c.phone}})

print('Seeded:')
print('  groups:', CampaignGroup.objects.count(), '| campaigns:', Campaign.objects.count())
print('  touchpoints:', TouchpointTemplate.objects.filter(is_goodbye=False).count(),
      '| goodbyes:', TouchpointTemplate.objects.filter(is_goodbye=True).count())
print('  import groups:', ImportGroup.objects.count(), '| segments:', Segment.objects.count())
print('  contacts:', Contact.objects.count(), '| templates:', EmailTemplate.objects.count())
print('  send jobs:', SendJob.objects.count(), '| scheduled:', ScheduledSend.objects.filter(status='scheduled').count())
print('  pending approvals:', ReactivationRequest.objects.filter(status='pending').count())
