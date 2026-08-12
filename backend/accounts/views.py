import base64
import csv
import dns.resolver
import functools
import io
import json
import os
import re
import threading
import time

import boto3
from botocore.exceptions import ClientError
from django.conf import settings as django_settings
from django.contrib.auth import authenticate, login, logout
from django.core import signing
from django.db.models import F
from django.contrib.auth.models import User
from django.http import JsonResponse, HttpResponse
from django.utils import timezone
from django.utils.html import escape
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from .models import (
    TouchpointTemplate, UserProfile, OTP, ImportGroup, Segment, Contact,
    SendJob, SendLog, SavedTestEmail, EmailTemplate, CustomField,
    ReactivationRequest, FlowTemplate, ScheduledSend, Campaign, CampaignGroup,
    Tag,
)


def _resolve_campaign(campaign_id):
    """The campaign a request operates on. Falls back to (and auto-creates)
    a default campaign so pre-hierarchy clients keep working."""
    if campaign_id:
        c = Campaign.objects.filter(id=campaign_id).first()
        if c:
            return c
    c = Campaign.objects.order_by('id').first()
    if not c:
        group = CampaignGroup.objects.order_by('id').first() or CampaignGroup.objects.create(name='My Campaigns')
        c = Campaign.objects.create(name='Campaign 1', group=group)
    return c


# ── AWS SES helpers ──────────────────────────────────────────────────────────

def _get_ses_client():
    return boto3.client(
        'ses',
        region_name=django_settings.AWS_SES_REGION,
        aws_access_key_id=django_settings.AWS_SES_ACCESS_KEY_ID,
        aws_secret_access_key=django_settings.AWS_SES_SECRET_ACCESS_KEY,
    )


_mx_cache = {}  # domain -> (has_mx, timestamp)


def _domain_has_mx(email):
    """Check if the email's domain has valid MX records. Results are cached."""
    domain = email.split('@')[-1].lower()
    # Check cache (valid for 10 minutes)
    cached = _mx_cache.get(domain)
    if cached and (time.time() - cached[1]) < 600:
        return cached[0]
    try:
        dns.resolver.resolve(domain, 'MX')
        _mx_cache[domain] = (True, time.time())
        return True
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer, dns.resolver.NoNameservers):
        _mx_cache[domain] = (False, time.time())
        return False
    except Exception:
        # On DNS timeout or other errors, assume valid to avoid false positives
        return True


def _get_ses_v2_client():
    return boto3.client(
        'sesv2',
        region_name=django_settings.AWS_SES_REGION,
        aws_access_key_id=django_settings.AWS_SES_ACCESS_KEY_ID,
        aws_secret_access_key=django_settings.AWS_SES_SECRET_ACCESS_KEY,
    )


def _check_bounces_for_job(job_id):
    """Check SES suppression list for bounced emails in a send job."""
    if getattr(django_settings, 'EMAIL_CONSOLE_MODE', False):
        return 0
    try:
        job = SendJob.objects.get(id=job_id)
    except SendJob.DoesNotExist:
        return

    ses_v2 = _get_ses_v2_client()
    sent_logs = job.logs.filter(status='sent').select_related('contact')
    bounced_count = 0

    for log in sent_logs:
        email = log.contact.email
        try:
            resp = ses_v2.get_suppressed_destination(EmailAddress=email)
            reason = resp['SuppressedDestination']['Reason']  # BOUNCE or COMPLAINT
            # Update contact status
            contact = log.contact
            if reason == 'BOUNCE':
                contact.status = 'bounced'
            elif reason == 'COMPLAINT':
                contact.status = 'opted_out'
            else:
                contact.status = 'undeliverable'
            contact.save()

            # Update the send log
            log.status = 'failed'
            log.error = f'Bounced: {reason} (detected via suppression list)'
            log.save()

            # Update job counts atomically
            SendJob.objects.filter(id=job.id).update(
                sent_count=F('sent_count') - 1,
                failed_count=F('failed_count') + 1,
            )
            bounced_count += 1
            print(f'[BOUNCE-CHECK] {email} -> {contact.status} ({reason})', flush=True)
        except ClientError as e:
            if e.response['Error']['Code'] == 'NotFoundException':
                # Not on suppression list — email delivered fine
                continue
            print(f'[BOUNCE-CHECK] Error checking {email}: {e}', flush=True)
        except Exception as e:
            print(f'[BOUNCE-CHECK] Error checking {email}: {e}', flush=True)

    print(f'[BOUNCE-CHECK] Job #{job_id}: found {bounced_count} bounced emails', flush=True)
    return bounced_count


def _signature_img_style(height, width):
    """CSS for the inline signature image: explicit px per dimension, or auto
    to keep proportions. Both zero -> a sensible 90px height default."""
    height = max(0, min(240, int(height or 0)))
    width = max(0, min(480, int(width or 0)))
    if height == 0 and width == 0:
        height = 90
    return (
        (f'height:{height}px;' if height > 0 else 'height:auto;')
        + (f'width:{width}px;' if width > 0 else 'width:auto;')
    )


def _wrap_email_html(body_fragment):
    """Wrap an HTML body fragment in a full email document with Poppins 9pt."""
    return (
        '<!DOCTYPE html>'
        '<html><head><meta charset="utf-8">'
        '<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&display=swap" rel="stylesheet">'
        '</head>'
        '<body style="margin:0;padding:0;font-family:\'Poppins\',Arial,Helvetica,sans-serif;font-size:9pt;">'
        f'{body_fragment}'
        '</body></html>'
    )


_console_email_counter = {'n': 0}


def _console_email_mode():
    """True when emails should be printed to the console instead of sent."""
    return getattr(django_settings, 'EMAIL_CONSOLE_MODE', False)


def _print_console_email(to_address, subject, body_html, body_text, attachments):
    """Pretty-print an email to the server console instead of sending it."""
    _console_email_counter['n'] += 1
    n = _console_email_counter['n']
    body = body_html or body_text or ''
    # Strip tags for a readable console preview
    text = re.sub(r'<style[\s\S]*?</style>', '', body, flags=re.IGNORECASE)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    if len(text) > 600:
        text = text[:600] + ' …'
    print('', flush=True)
    print('=' * 68, flush=True)
    print(f'  CONSOLE EMAIL #{n}  (not really sent — console mode is on)', flush=True)
    print('=' * 68, flush=True)
    print(f'  To:          {to_address}', flush=True)
    print(f'  Subject:     {subject}', flush=True)
    if attachments:
        print(f'  Attachments: {len(attachments)}', flush=True)
    print('-' * 68, flush=True)
    print(f'  {text or "(empty body)"}', flush=True)
    print('=' * 68, flush=True)
    print('', flush=True)
    return True, f'console-email-{n}'


def _ses_send_mail(to_address, subject, body_html=None, body_text=None,
                   from_address=None, from_name='Waldo Gaybba',
                   attachments=None, max_retries=3):
    if _console_email_mode():
        return _print_console_email(to_address, subject, body_html, body_text, attachments)
    if body_html:
        body_html = _wrap_email_html(body_html)
    if not from_address:
        from_address = django_settings.AWS_SES_FROM_EMAIL

    source = f'{from_name} <{from_address}>' if from_name else from_address

    if attachments:
        return _ses_send_raw_mail(
            to_address, subject, body_html, body_text,
            source, from_address, attachments, max_retries
        )

    ses = _get_ses_client()
    body = {}
    if body_html:
        body['Html'] = {'Data': body_html, 'Charset': 'UTF-8'}
    if body_text:
        body['Text'] = {'Data': body_text, 'Charset': 'UTF-8'}
    if not body:
        body['Text'] = {'Data': '', 'Charset': 'UTF-8'}

    for attempt in range(max_retries):
        try:
            response = ses.send_email(
                Source=source,
                Destination={'ToAddresses': [to_address]},
                Message={
                    'Subject': {'Data': subject, 'Charset': 'UTF-8'},
                    'Body': body,
                },
            )
            return True, response['MessageId']
        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == 'Throttling':
                time.sleep(2 * (attempt + 1))
                continue
            return False, f"{error_code}: {e.response['Error']['Message']}"
        except Exception as e:
            if attempt < max_retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            return False, str(e)

    return False, 'Max retries exceeded'


def _ses_send_raw_mail(to_address, subject, body_html, body_text,
                       source, from_address, attachments, max_retries=3):
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    from email.mime.base import MIMEBase
    from email.mime.image import MIMEImage
    from email import encoders

    msg = MIMEMultipart('mixed')
    msg['Subject'] = subject
    msg['From'] = source
    msg['To'] = to_address

    if body_html:
        body_related = MIMEMultipart('related')
        body_related.attach(MIMEText(body_html, 'html', 'utf-8'))
        for att in (attachments or []):
            if att.get('isInline'):
                content_bytes = base64.b64decode(att.get('contentBytes', ''))
                img = MIMEImage(content_bytes)
                img.add_header('Content-ID', f"<{att.get('contentId', '')}>")
                img.add_header('Content-Disposition', 'inline', filename=att.get('name', 'image.png'))
                body_related.attach(img)
        msg.attach(body_related)
    elif body_text:
        msg.attach(MIMEText(body_text, 'plain', 'utf-8'))

    for att in (attachments or []):
        if att.get('isInline'):
            continue
        content_bytes = base64.b64decode(att.get('contentBytes', ''))
        part = MIMEBase('application', 'octet-stream')
        part.set_payload(content_bytes)
        encoders.encode_base64(part)
        part.add_header('Content-Disposition', 'attachment', filename=att.get('name', 'attachment'))
        msg.attach(part)

    ses = _get_ses_client()
    for attempt in range(max_retries):
        try:
            response = ses.send_raw_email(
                Source=source,
                Destinations=[to_address],
                RawMessage={'Data': msg.as_string()},
            )
            return True, response['MessageId']
        except ClientError as e:
            error_code = e.response['Error']['Code']
            if error_code == 'Throttling':
                time.sleep(2 * (attempt + 1))
                continue
            return False, f"{error_code}: {e.response['Error']['Message']}"
        except Exception as e:
            if attempt < max_retries - 1:
                time.sleep(2 * (attempt + 1))
                continue
            return False, str(e)

    return False, 'Max retries exceeded'


# ── Opt-out (unsubscribe) helpers ────────────────────────────────────────────

OPTOUT_SALT = 'contact-optout-v1'
DEFAULT_OPT_OUT_TEXT = "If you'd prefer not to receive further communication from us, you can opt out here."


def _optout_token(contact_id):
    """Signed, tamper-proof token encoding a contact id for the public opt-out link."""
    return signing.dumps({'cid': contact_id}, salt=OPTOUT_SALT)


def _optout_url(contact_id):
    base = getattr(django_settings, 'PUBLIC_BASE_URL', 'http://localhost:8000').rstrip('/')
    return f'{base}/api/optout/{_optout_token(contact_id)}/'


def _text_to_html(text):
    """Convert a plain-text email body to simple HTML, preserving line breaks."""
    safe = escape(text or '').replace('\n', '<br>')
    return f'<div style="font-family:\'Poppins\',Arial,sans-serif;font-size:9pt;color:#0a2a3c;line-height:1.6">{safe}</div>'


def _apply_opt_out(html, opt_out_text, contact_id, is_html=True):
    """Append/insert the opt-out line as a clickable HTML link.

    The entire sentence is linked. Replaces the {{opt_out}} marker inline
    when present, otherwise appends a footer.
    """
    text = (opt_out_text or '').strip() or DEFAULT_OPT_OUT_TEXT
    url = _optout_url(contact_id)
    safe = escape(text)
    linked = f'<a href="{url}" style="color:#054B70">{safe}</a>'
    footer = f'<div style="margin-top:18px;font-family:\'Poppins\',Arial,sans-serif;font-size:9pt;color:#8ca3b3;line-height:1.5">{linked}</div>'
    if '{{opt_out}}' in html:
        return html.replace('{{opt_out}}', linked)
    return html + footer


# ── OTP email helper ─────────────────────────────────────────────────────────

def _otp_email_html(code, purpose):
    """Build a branded HTML email for OTP delivery."""
    from django.conf import settings as djsettings
    frontend_url = getattr(djsettings, 'FRONTEND_URL', 'http://localhost:3000')

    if purpose == 'login':
        heading = 'Verify Your Login'
        intro = 'A sign-in attempt requires verification. Enter the code below to continue.'
        btn_label = 'Go to Login'
        btn_url = frontend_url + '/'
    elif purpose == 'password_reset':
        heading = 'Reset Your Password'
        intro = 'We received a request to reset your password. Use the code below to proceed.'
        btn_label = 'Reset Password'
        btn_url = frontend_url + '/set-password?purpose=reset'
    else:  # account_setup
        heading = 'Welcome Aboard'
        intro = 'Your account at <strong style="color:#054B70;">Magnum Opus Consultants</strong> has been created. Use the code below to set your password and get started.'
        btn_label = 'Set Up Account'
        btn_url = frontend_url + '/set-password?purpose=setup'

    # Individual digit cells for a clean look
    digits_html = ''
    for d in code:
        digits_html += (
            f'<td align="center" style="width:48px;height:56px;'
            f'background-color:#054B70;border-radius:10px;'
            f'font-family:\'Courier New\',monospace;font-size:26px;'
            f'font-weight:700;color:#ffffff;letter-spacing:1px;">{d}</td>'
            '<td width="8"></td>'
        )

    return f'''<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f0f4f7;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f0f4f7;">
    <tr><td align="center" style="padding:48px 16px;">

      <!-- Main card -->
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;background-color:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(5,75,112,0.08);">

        <!-- Top accent line -->
        <tr><td style="height:5px;background:linear-gradient(90deg,#054B70 0%,#0a7aad 50%,#94bccc 100%);font-size:0;line-height:0;">&nbsp;</td></tr>

        <!-- Logo & brand name -->
        <tr>
          <td style="padding:36px 40px 0;text-align:center;">
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
              <tr>
                <td style="width:44px;height:44px;background-color:#054B70;border-radius:12px;text-align:center;vertical-align:middle;">
                  <span style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#ffffff;line-height:44px;">M</span>
                </td>
                <td width="14"></td>
                <td style="vertical-align:middle;">
                  <p style="margin:0;font-size:18px;font-weight:700;color:#0a2a3c;letter-spacing:-0.5px;">Magnum Opus</p>
                  <p style="margin:2px 0 0;font-size:11px;font-weight:600;color:#94bccc;letter-spacing:1.5px;text-transform:uppercase;">Consultants</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Divider -->
        <tr><td style="padding:24px 40px 0;"><div style="height:1px;background-color:#e8eff3;"></div></td></tr>

        <!-- Heading -->
        <tr>
          <td style="padding:28px 40px 0;text-align:center;">
            <h1 style="margin:0;font-size:22px;font-weight:700;color:#0a2a3c;letter-spacing:-0.3px;">{heading}</h1>
          </td>
        </tr>

        <!-- Intro text -->
        <tr>
          <td style="padding:14px 40px 0;text-align:center;">
            <p style="margin:0;font-size:14px;color:#6b8a9e;line-height:1.7;">{intro}</p>
          </td>
        </tr>

        <!-- Code digits -->
        <tr>
          <td style="padding:28px 40px 0;" align="center">
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;">
              <tr>{digits_html}</tr>
            </table>
          </td>
        </tr>

        <!-- Expiry -->
        <tr>
          <td style="padding:20px 40px 0;text-align:center;">
            <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;background-color:#f0f4f7;border-radius:8px;">
              <tr>
                <td style="padding:8px 20px;font-size:12px;color:#6b8a9e;">
                  Valid for <strong style="color:#054B70;">1 hour</strong>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Action button -->
        <tr>
          <td style="padding:28px 40px 0;" align="center">
            <a href="{btn_url}" target="_blank"
               style="display:inline-block;background-color:#054B70;color:#ffffff;font-size:14px;font-weight:700;
                      text-decoration:none;padding:14px 36px;border-radius:12px;letter-spacing:0.3px;">
              {btn_label} &rarr;
            </a>
          </td>
        </tr>

        <!-- Security note -->
        <tr>
          <td style="padding:24px 40px 0;text-align:center;">
            <p style="margin:0;font-size:12px;color:#a0b4c0;line-height:1.6;">If you didn&rsquo;t request this code, you can safely ignore this email.<br>Your account remains secure.</p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:32px 40px 36px;">
            <div style="height:1px;background-color:#e8eff3;margin-bottom:24px;"></div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td style="text-align:center;">
                  <p style="margin:0 0 4px;font-size:12px;font-weight:700;color:#054B70;">Magnum Opus Consultants</p>
                  <p style="margin:0;font-size:11px;color:#a0b4c0;">Emailing System &mdash; Secure Verification</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>

      </table>

      <!-- Sub-footer -->
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
        <tr>
          <td style="padding:20px 40px 0;text-align:center;">
            <p style="margin:0;font-size:10px;color:#b0c4d0;">This is an automated message. Please do not reply directly to this email.</p>
          </td>
        </tr>
      </table>

    </td></tr>
  </table>
</body>
</html>'''


def _send_otp_email(email, code, purpose):
    subject_map = {
        'login': 'Your Login Verification Code',
        'password_reset': 'Your Password Reset Code',
        'account_setup': 'Welcome — Set Up Your Account',
    }
    # Plain text fallback
    text_map = {
        'login': f'Your verification code is: {code}\n\nThis code expires in 1 hour.',
        'password_reset': f'Your password reset code is: {code}\n\nThis code expires in 1 hour.',
        'account_setup': (
            f'Your account has been created at Magnum Opus Consultants.\n\n'
            f'Use this code to set your password: {code}\n\n'
            f'This code expires in 1 hour.\n\n'
            f'Visit the login page and click "Set up account" to get started.'
        ),
    }
    subject = subject_map.get(purpose, 'Your Verification Code')
    body_text = text_map.get(purpose, f'Your code is: {code}')
    body_html = _otp_email_html(code, purpose)
    print(f'[OTP-EMAIL] Sending to={email}, subject="{subject}", from=Magnum Opus Consultants <{django_settings.AWS_SES_FROM_EMAIL}>', flush=True)
    result = _ses_send_mail(
        to_address=email,
        subject=subject,
        body_html=body_html,
        body_text=body_text,
        from_name='Magnum Opus Consultants',
    )
    print(f'[OTP-EMAIL] Result: ok={result[0]}, detail={result[1]}', flush=True)
    return result


def _mask_email(email):
    parts = email.split('@')
    if len(parts) != 2:
        return '***'
    name = parts[0]
    domain = parts[1]
    if len(name) <= 2:
        masked = name[0] + '***'
    else:
        masked = name[0] + '***' + name[-1]
    return f'{masked}@{domain}'


# ── Role-checking decorator ──────────────────────────────────────────────────

def require_role(*roles):
    def decorator(view_func):
        @functools.wraps(view_func)
        def wrapper(request, *args, **kwargs):
            if not request.user.is_authenticated:
                return JsonResponse({'error': 'Not authenticated'}, status=401)
            try:
                profile = request.user.profile
            except UserProfile.DoesNotExist:
                return JsonResponse({'error': 'No profile found'}, status=403)
            if profile.role not in roles:
                return JsonResponse({'error': 'Insufficient permissions'}, status=403)
            return view_func(request, *args, **kwargs)
        return wrapper
    return decorator


def require_auth(view_func):
    @functools.wraps(view_func)
    def wrapper(request, *args, **kwargs):
        if not request.user.is_authenticated:
            return JsonResponse({'error': 'Not authenticated'}, status=401)
        return view_func(request, *args, **kwargs)
    return wrapper


# ── Auth views ───────────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["POST"])
def login_view(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    username = data.get("username")
    password = data.get("password")

    if not username or not password:
        return JsonResponse({"error": "Username and password are required"}, status=400)

    user = authenticate(request, username=username, password=password)
    if user is not None:
        print(f'[LOGIN] Authenticated user: {user.username} (email: {user.email})', flush=True)
        # Complete login directly — OTP is only used for account setup and password reset
        login(request, user)

        role = 'viewer'
        try:
            role = user.profile.role
        except UserProfile.DoesNotExist:
            pass

        return JsonResponse({
            "message": "Login successful",
            "username": user.username,
            "role": role,
        })
    else:
        print(f'[LOGIN] Authentication failed for username: {username}', flush=True)
        return JsonResponse({"error": "Invalid credentials"}, status=401)


@csrf_exempt
@require_http_methods(["POST"])
def verify_otp(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    code = data.get("code", "").strip()
    user_id = request.session.get('otp_user_id')
    purpose = request.session.get('otp_purpose')
    print(f'[VERIFY-OTP] session_key={request.session.session_key}, otp_user_id={user_id}, purpose={purpose}, code={code}', flush=True)

    if not user_id or purpose != 'login':
        print(f'[VERIFY-OTP] No pending verification found in session', flush=True)
        return JsonResponse({"error": "No pending OTP verification. Please log in again."}, status=400)

    try:
        user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return JsonResponse({"error": "Invalid session"}, status=400)

    otp = OTP.objects.filter(
        user=user, purpose='login', code=code, is_used=False,
    ).order_by('-created_at').first()

    if not otp or not otp.is_valid():
        return JsonResponse({"error": "Invalid or expired code"}, status=400)

    otp.is_used = True
    otp.save()

    # Complete login
    login(request, user)
    request.session.pop('otp_user_id', None)
    request.session.pop('otp_purpose', None)

    role = 'viewer'
    try:
        role = user.profile.role
    except UserProfile.DoesNotExist:
        pass

    return JsonResponse({
        "message": "Login successful",
        "username": user.username,
        "role": role,
    })


@csrf_exempt
@require_http_methods(["POST"])
def resend_otp(request):
    user_id = request.session.get('otp_user_id')
    purpose = request.session.get('otp_purpose')
    if not user_id or purpose != 'login':
        return JsonResponse({"error": "No pending verification"}, status=400)

    try:
        user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return JsonResponse({"error": "Invalid session"}, status=400)

    otp = OTP.generate(user, 'login')
    if otp is None:
        return JsonResponse({"error": "Please wait before requesting a new code."}, status=429)

    sent_ok, msg = _send_otp_email(user.email, otp.code, 'login')
    if not sent_ok:
        return JsonResponse({"error": "Failed to send code"}, status=500)

    return JsonResponse({"message": "New code sent", "email_hint": _mask_email(user.email)})


@csrf_exempt
@require_http_methods(["POST"])
def logout_view(request):
    logout(request)
    return JsonResponse({"message": "Logged out successfully"})


@csrf_exempt
@require_http_methods(["POST"])
def forgot_password(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    email = data.get("email", "").strip()
    if not email:
        return JsonResponse({"error": "Email is required"}, status=400)

    # Always return success to prevent email enumeration
    try:
        user = User.objects.get(email=email)
        otp = OTP.generate(user, 'password_reset')
        if otp:
            _send_otp_email(email, otp.code, 'password_reset')
    except User.DoesNotExist:
        pass

    return JsonResponse({"message": "If that email exists, a reset code has been sent."})


@csrf_exempt
@require_http_methods(["POST"])
def reset_password(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    email = data.get("email", "").strip()
    code = data.get("code", "").strip()
    new_password = data.get("new_password", "")

    if not email or not code or not new_password:
        return JsonResponse({"error": "Email, code, and new password are required"}, status=400)

    try:
        user = User.objects.get(email=email)
    except User.DoesNotExist:
        return JsonResponse({"error": "Invalid email or code"}, status=400)

    otp = OTP.objects.filter(
        user=user, purpose='password_reset', code=code, is_used=False,
    ).order_by('-created_at').first()

    if not otp or not otp.is_valid():
        return JsonResponse({"error": "Invalid or expired code"}, status=400)

    from django.contrib.auth.password_validation import validate_password
    from django.core.exceptions import ValidationError
    try:
        validate_password(new_password, user)
    except ValidationError as e:
        return JsonResponse({"error": e.messages[0]}, status=400)

    otp.is_used = True
    otp.save()
    user.set_password(new_password)
    user.save()

    return JsonResponse({"message": "Password updated successfully. You can now log in."})


@csrf_exempt
@require_http_methods(["POST"])
def set_password(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    email = data.get("email", "").strip()
    code = data.get("code", "").strip()
    new_password = data.get("new_password", "")

    if not email or not code or not new_password:
        return JsonResponse({"error": "Email, code, and new password are required"}, status=400)

    try:
        user = User.objects.get(email=email)
    except User.DoesNotExist:
        return JsonResponse({"error": "Invalid email or code"}, status=400)

    otp = OTP.objects.filter(
        user=user, purpose='account_setup', code=code, is_used=False,
    ).order_by('-created_at').first()

    if not otp or not otp.is_valid():
        return JsonResponse({"error": "Invalid or expired code"}, status=400)

    from django.contrib.auth.password_validation import validate_password
    from django.core.exceptions import ValidationError
    try:
        validate_password(new_password, user)
    except ValidationError as e:
        return JsonResponse({"error": e.messages[0]}, status=400)

    otp.is_used = True
    otp.save()
    user.set_password(new_password)
    user.is_active = True
    user.save()

    return JsonResponse({"message": "Password set successfully. You can now log in."})


@csrf_exempt
@require_http_methods(["GET"])
def me(request):
    if not request.user.is_authenticated:
        return JsonResponse({"error": "Not authenticated"}, status=401)

    role = 'viewer'
    try:
        role = request.user.profile.role
    except UserProfile.DoesNotExist:
        pass

    return JsonResponse({
        "username": request.user.username,
        "email": request.user.email,
        "first_name": request.user.first_name,
        "last_name": request.user.last_name,
        "role": role,
        # Super admin: may manage admin accounts too (set via the database)
        "is_superuser": bool(request.user.is_superuser),
    })


@csrf_exempt
@require_http_methods(["GET"])
def health_check(request):
    return JsonResponse({"status": "ok", "message": "Django backend is running"})


# ── User management views (admin only) ──────────────────────────────────────

@csrf_exempt
@require_http_methods(["GET"])
@require_role('admin', 'editor')
def users_list(request):
    users = []
    for u in User.objects.all().select_related('profile').order_by('-date_joined'):
        role = 'viewer'
        try:
            role = u.profile.role
        except UserProfile.DoesNotExist:
            pass
        users.append({
            'id': u.id,
            'username': u.username,
            'email': u.email,
            'first_name': u.first_name,
            'last_name': u.last_name,
            'role': role,
            'is_active': u.is_active,
            'date_joined': u.date_joined.isoformat(),
        })
    return JsonResponse({'ok': True, 'users': users})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def users_create(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    email = data.get('email', '').strip()
    first_name = data.get('first_name', '').strip()
    last_name = data.get('last_name', '').strip()
    role = data.get('role', 'viewer')

    if not email or not first_name:
        return JsonResponse({'error': 'Email and first name are required'}, status=400)
    # New accounts are editors or viewers — admin accounts are never created from the UI.
    if role not in ('editor', 'viewer'):
        return JsonResponse({'error': 'Role must be editor or viewer'}, status=400)
    if User.objects.filter(email=email).exists():
        return JsonResponse({'error': 'A user with this email already exists'}, status=400)

    # Create user with unusable password (they will set it via OTP)
    user = User.objects.create_user(
        username=email,
        email=email,
        first_name=first_name,
        last_name=last_name,
    )
    user.set_unusable_password()
    user.save()

    UserProfile.objects.create(user=user, role=role)

    # Send account setup OTP
    otp = OTP.generate(user, 'account_setup')
    sent_ok = False
    if otp:
        sent_ok, _ = _send_otp_email(email, otp.code, 'account_setup')

    return JsonResponse({
        'ok': True,
        'message': f'User created. Setup email {"sent" if sent_ok else "failed to send"}.',
        'user': {
            'id': user.id,
            'username': user.username,
            'email': user.email,
            'first_name': user.first_name,
            'last_name': user.last_name,
            'role': role,
            'is_active': user.is_active,
            'date_joined': user.date_joined.isoformat(),
        },
    })


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def users_update(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    user_id = data.get('user_id')
    role = data.get('role')

    if not user_id or not role:
        return JsonResponse({'error': 'user_id and role are required'}, status=400)
    # Only editor/viewer are assignable — except by a super admin, who may
    # also grant (or revoke) admin.
    allowed_roles = ('editor', 'viewer', 'admin') if request.user.is_superuser else ('editor', 'viewer')
    if role not in allowed_roles:
        return JsonResponse({'error': 'Role must be editor or viewer'}, status=400)

    try:
        target_user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return JsonResponse({'error': 'User not found'}, status=404)

    target_profile = getattr(target_user, 'profile', None)
    if target_profile and target_profile.role == 'admin' and not request.user.is_superuser:
        return JsonResponse({'error': 'Admin accounts cannot be changed here'}, status=400)
    if target_user.id == request.user.id:
        return JsonResponse({'error': 'Cannot change your own role'}, status=400)

    profile, created = UserProfile.objects.get_or_create(
        user=target_user, defaults={'role': role},
    )
    if not created:
        profile.role = role
        profile.save()

    return JsonResponse({'ok': True, 'message': 'Role updated'})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin')
def users_delete(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    user_id = data.get('user_id')
    if not user_id:
        return JsonResponse({'error': 'user_id is required'}, status=400)

    try:
        target_user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return JsonResponse({'error': 'User not found'}, status=404)

    if target_user.id == request.user.id:
        return JsonResponse({'error': 'Cannot delete your own account'}, status=400)
    profile = getattr(target_user, 'profile', None)
    if profile and profile.role == 'admin' and not request.user.is_superuser:
        return JsonResponse({'error': 'Admin accounts cannot be deleted here'}, status=400)

    target_user.delete()
    return JsonResponse({'ok': True, 'message': 'User deleted'})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def users_set_active(request):
    """Deactivate (or reactivate) an account — a deactivated user cannot log in."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    user_id = data.get('user_id')
    active = data.get('active')
    if not user_id or not isinstance(active, bool):
        return JsonResponse({'error': 'user_id and active (true/false) are required'}, status=400)

    try:
        target_user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return JsonResponse({'error': 'User not found'}, status=404)

    if target_user.id == request.user.id:
        return JsonResponse({'error': 'Cannot deactivate your own account'}, status=400)
    profile = getattr(target_user, 'profile', None)
    if profile and profile.role == 'admin' and not request.user.is_superuser:
        return JsonResponse({'error': 'Admin accounts cannot be changed here'}, status=400)

    target_user.is_active = active
    target_user.save(update_fields=['is_active'])
    return JsonResponse({'ok': True, 'message': 'Account reactivated' if active else 'Account deactivated'})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def users_send_reset(request):
    """Email a password-reset code to a user — they finish on the set-password page."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    user_id = data.get('user_id')
    if not user_id:
        return JsonResponse({'error': 'user_id is required'}, status=400)

    try:
        target_user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return JsonResponse({'error': 'User not found'}, status=404)
    if not target_user.email:
        return JsonResponse({'error': 'This account has no email address'}, status=400)

    otp = OTP.generate(target_user, 'password_reset')
    if otp is None:
        return JsonResponse({"error": "Please wait before requesting a new code."}, status=429)

    sent_ok, _ = _send_otp_email(target_user.email, otp.code, 'password_reset')
    if not sent_ok:
        return JsonResponse({"error": "Failed to send email"}, status=500)

    return JsonResponse({'ok': True, 'message': f'Password reset email sent to {target_user.email}'})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def resend_setup_otp(request):
    """Resend the account setup OTP for a user who hasn't set their password yet."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    user_id = data.get('user_id')
    if not user_id:
        return JsonResponse({'error': 'user_id is required'}, status=400)

    try:
        target_user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return JsonResponse({'error': 'User not found'}, status=404)

    otp = OTP.generate(target_user, 'account_setup')
    if otp is None:
        return JsonResponse({"error": "Please wait before requesting a new code."}, status=429)

    sent_ok, _ = _send_otp_email(target_user.email, otp.code, 'account_setup')
    if not sent_ok:
        return JsonResponse({"error": "Failed to send email"}, status=500)

    return JsonResponse({'ok': True, 'message': 'Setup email resent'})


# ── Email template views ────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def email_templates_list(request):
    campaign = _resolve_campaign(request.GET.get('campaign_id'))
    templates = []
    for t in TouchpointTemplate.objects.filter(is_goodbye=False, campaign=campaign):
        templates.append({
            'touchpoint_number': t.touchpoint_number,
            'subject': t.subject,
            'body': t.body,
            'body_html': t.body_html,
            'signature': t.signature,
            'opt_out_text': t.opt_out_text,
            'attachment_name': t.attachment.name.split('/')[-1] if t.attachment else '',
            'attachment_url': t.attachment.url if t.attachment else '',
            'signature_image_name': t.signature_image.name.split('/')[-1] if t.signature_image else '',
            'signature_image_url': t.signature_image.url if t.signature_image else '',
            'signature_image_height': t.signature_image_height,
            'signature_image_width': t.signature_image_width,
            'days_after_previous': t.days_after_previous,
        })
    return JsonResponse({'ok': True, 'templates': templates})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def email_template_save(request):
    tp_num = request.POST.get('touchpoint_number')
    if not tp_num:
        return JsonResponse({'ok': False, 'error': 'Missing touchpoint_number'}, status=400)

    tp_num = int(tp_num)
    campaign = _resolve_campaign(request.POST.get('campaign_id'))
    # Numbers at/above GOODBYE_OFFSET address a goodbye email (offset + the touchpoint it follows),
    # so the full editor can save goodbyes through the same endpoint.
    is_goodbye = tp_num >= TouchpointTemplate.GOODBYE_OFFSET
    goodbye_for = ((tp_num - TouchpointTemplate.GOODBYE_OFFSET) or None) if is_goodbye else None
    tpl, _ = TouchpointTemplate.objects.get_or_create(
        touchpoint_number=tp_num, campaign=campaign,
        defaults={'is_goodbye': is_goodbye, 'goodbye_for': goodbye_for},
    )
    if is_goodbye:
        tpl.is_goodbye = True
        tpl.goodbye_for = goodbye_for

    tpl.subject = request.POST.get('subject', '')
    tpl.body = request.POST.get('body', '')
    tpl.body_html = request.POST.get('body_html', '')
    tpl.signature = request.POST.get('signature', '')
    if 'opt_out_text' in request.POST:
        tpl.opt_out_text = request.POST.get('opt_out_text', '')
    tpl.days_after_previous = int(request.POST.get('days_after_previous', 7))

    if request.FILES.get('attachment'):
        tpl.attachment = request.FILES['attachment']
    if request.POST.get('clear_attachment') == '1':
        tpl.attachment = None

    if request.FILES.get('signature_image'):
        tpl.signature_image = request.FILES['signature_image']
    if request.POST.get('clear_signature_image') == '1':
        tpl.signature_image = None

    # Signature image render size (0 = auto, keeps proportions)
    if 'signature_image_height' in request.POST:
        try:
            tpl.signature_image_height = max(0, min(240, int(request.POST['signature_image_height'] or 0)))
        except (TypeError, ValueError):
            pass
    if 'signature_image_width' in request.POST:
        try:
            tpl.signature_image_width = max(0, min(480, int(request.POST['signature_image_width'] or 0)))
        except (TypeError, ValueError):
            pass

    try:
        tpl.save()
    except Exception as e:
        return JsonResponse({'ok': False, 'error': f'Failed to save template: {e}'}, status=500)

    return JsonResponse({
        'ok': True,
        'body_html': tpl.body_html,
        'attachment_name': tpl.attachment.name.split('/')[-1] if tpl.attachment else '',
        'attachment_url': tpl.attachment.url if tpl.attachment else '',
        'signature_image_name': tpl.signature_image.name.split('/')[-1] if tpl.signature_image else '',
        'signature_image_url': tpl.signature_image.url if tpl.signature_image else '',
    })


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def send_test_email(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'ok': False, 'error': 'Invalid JSON'}, status=400)

    tp_num = data.get('touchpoint_number')
    recipients = data.get('recipients', [])

    if not tp_num or not recipients:
        return JsonResponse({'ok': False, 'error': 'Missing touchpoint_number or recipients'}, status=400)

    recipients = [e.strip() for e in recipients if e.strip()][:10]

    campaign = _resolve_campaign(data.get('campaign_id'))
    tpl = TouchpointTemplate.objects.filter(touchpoint_number=tp_num, campaign=campaign).first()
    if not tpl:
        return JsonResponse({'ok': False, 'error': f'Template for TP{tp_num} not found. Save the template first.'}, status=404)

    # Determine email body — always sent as HTML so links (opt-out) are clickable
    if tpl.body_html:
        body_content = tpl.body_html
    else:
        body_content = _text_to_html(tpl.body)
        if tpl.signature:
            body_content += f'<div style="margin-top:12px;white-space:pre-wrap">{escape(tpl.signature)}</div>'
    content_type = 'HTML'

    # Inline signature image
    sig_inline = None
    if content_type == 'HTML' and tpl.signature_image:
        try:
            sig_path = tpl.signature_image.path
            sig_name = os.path.basename(sig_path)
            ext = os.path.splitext(sig_name)[1].lower().lstrip('.') or 'png'
            cid = f'signature_tp{tpl.touchpoint_number}'

            has_drive_url = bool(re.search(
                r'https://drive\.google\.com/thumbnail\?id=',
                body_content, flags=re.IGNORECASE,
            ))
            has_cid_ref = bool(re.search(
                r'cid:signature_tp\d+', body_content, flags=re.IGNORECASE,
            ))

            if has_drive_url:
                body_content = re.sub(
                    r'https://drive\.google\.com/thumbnail\?id=[^"\'&]+(?:&amp;[^"\']*|&[^"\']*)*',
                    f'cid:{cid}',
                    body_content,
                    flags=re.IGNORECASE,
                )
            elif not has_cid_ref:
                # No reference exists — append signature image at the end
                body_content += f'<div style="margin-top:16px"><img src="cid:{cid}" alt="Signature" style="{_signature_img_style(tpl.signature_image_height, tpl.signature_image_width)}" /></div>'

            with open(sig_path, 'rb') as sf:
                sig_inline = {
                    'name': sig_name,
                    'contentType': f'image/{"jpeg" if ext == "jpg" else ext}',
                    'contentBytes': base64.b64encode(sf.read()).decode('utf-8'),
                    'contentId': cid,
                    'isInline': True,
                }
        except Exception as e:
            print(f'[views] test email signature_image load failed: {e}', flush=True)

    # Sample variable values
    sample_vars = {
        '{{org_name}}': 'Sample Corp Inc.',
        '{{contact_name}}': 'John Doe',
        '{{email}}': 'johndoe@samplecorp.com',
        '{{phone}}': '+1 (555) 123-4567',
        '{{touchpoint_number}}': str(tp_num),
    }

    # Build attachments
    attachments = []
    attachment_included = False
    if tpl.attachment:
        try:
            att_path = tpl.attachment.path
            with open(att_path, 'rb') as f:
                att_bytes = f.read()
            raw_name = os.path.basename(att_path)
            name_part, ext = os.path.splitext(raw_name)
            att_name = name_part.replace('_', ' ').replace('-', ' ')
            att_name = ' '.join(att_name.split()) + ext
            attachments.append({
                'name': att_name,
                'contentBytes': base64.b64encode(att_bytes).decode('utf-8'),
            })
            attachment_included = True
        except Exception as e:
            print(f'[views] test email attachment load failed: {e}', flush=True)
    if sig_inline:
        attachments.append(sig_inline)

    # Substitute variables
    subject = tpl.subject
    final_body = body_content
    for var, val in sample_vars.items():
        subject = subject.replace(var, val)
        final_body = final_body.replace(var, val)

    # Create a SendJob to track this test send
    job = SendJob.objects.create(
        touchpoint=tpl,
        total_recipients=len(recipients),
        started_by=request.user,
        status='running',
        is_test=True,
    )

    results = []
    opted_out_emails = []
    for email_addr in recipients:
        # Check if this email belongs to a contact with non-active status
        existing = Contact.objects.filter(email=email_addr).first()
        if existing and existing.status != 'active':
            results.append({
                'email': email_addr,
                'ok': False,
                'status': f'Blocked: contact is {existing.status}',
            })
            opted_out_emails.append(email_addr)
            continue

        # Create or find a contact for logging (use a temporary one for test sends)
        contact, _ = Contact.objects.get_or_create(
            email=email_addr,
            defaults={
                'org_name': 'Test',
                'contact_name': email_addr.split('@')[0],
                'status': 'active',
            }
        )
        log = SendLog.objects.create(job=job, contact=contact, status='pending')

        # Per-recipient opt-out link (functional even on a test send)
        test_body = _apply_opt_out(final_body, tpl.opt_out_text, contact.id, is_html=(content_type == 'HTML'))
        body_html = test_body if content_type == 'HTML' else None
        body_text = test_body if content_type == 'Text' else None
        sent_ok, msg_id = _ses_send_mail(
            to_address=email_addr,
            subject=subject,
            body_html=body_html,
            body_text=body_text,
            attachments=attachments if attachments else None,
        )
        results.append({'email': email_addr, 'ok': sent_ok, 'status': msg_id})

        log.sent_at = timezone.now()
        if sent_ok:
            log.status = 'sent'
            log.message_id = msg_id
            job.sent_count += 1
            contact.last_touchpoint = tpl.touchpoint_number
            contact.save()
        else:
            log.status = 'failed'
            log.error = msg_id
            job.failed_count += 1
        log.save()
        job.save()

        if sent_ok:
            time.sleep(0.1)

    job.status = 'completed'
    job.completed_at = timezone.now()
    job.save()

    sent_count = sum(1 for r in results if r['ok'])
    msg = f'Test email sent to {sent_count}/{len(recipients)} recipients'
    if opted_out_emails:
        msg += f' ({len(opted_out_emails)} blocked — opted out/bounced)'
    if tpl.attachment and not attachment_included:
        msg += ' (attachment failed to load — save the template first)'
    elif attachment_included:
        msg += ' (with attachment)'
    return JsonResponse({
        'ok': True,
        'results': results,
        'message': msg,
        'attachment_included': attachment_included,
    })


@csrf_exempt
@require_http_methods(["GET"])
@require_role('admin', 'editor')
def saved_test_emails_list(request):
    """Return all saved test email recipients."""
    emails = list(SavedTestEmail.objects.values_list('email', flat=True))
    return JsonResponse({'ok': True, 'emails': emails})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def saved_test_emails_save(request):
    """Add or remove saved test email recipients."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    action = data.get('action', 'add')  # 'add' or 'remove'
    emails = data.get('emails', [])
    # Also accept single 'email' string
    if not emails and data.get('email'):
        emails = [data['email']]

    if not emails:
        return JsonResponse({'error': 'emails is required'}, status=400)

    if action == 'add':
        for email in emails:
            email = email.strip().lower()
            if email and '@' in email:
                SavedTestEmail.objects.get_or_create(
                    email=email,
                    defaults={'added_by': request.user},
                )
    elif action == 'remove':
        SavedTestEmail.objects.filter(email__in=[e.strip().lower() for e in emails]).delete()

    remaining = list(SavedTestEmail.objects.values_list('email', flat=True))
    return JsonResponse({'ok': True, 'emails': remaining})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def set_touchpoint_schedule(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'ok': False, 'error': 'Invalid JSON'}, status=400)

    tp_num = data.get('touchpoint_number')
    date_str = data.get('scheduled_date', '')

    if not tp_num:
        return JsonResponse({'ok': False, 'error': 'Missing touchpoint_number'}, status=400)

    campaign = _resolve_campaign(data.get('campaign_id'))
    tpl, _ = TouchpointTemplate.objects.get_or_create(touchpoint_number=tp_num, campaign=campaign)

    if date_str:
        from datetime import date as dt_date
        parts = date_str.split('-')
        d = dt_date(int(parts[0]), int(parts[1]), int(parts[2]))
        # Block Monday(0), Friday(4), Saturday(5), Sunday(6) — only allow Tue/Wed/Thu
        blocked_days = {0: 'Monday', 4: 'Friday', 5: 'Saturday', 6: 'Sunday'}
        if d.weekday() in blocked_days:
            return JsonResponse({
                'ok': False,
                'error': f'Cannot schedule on {blocked_days[d.weekday()]}. Only Tuesday, Wednesday, and Thursday are allowed.',
            }, status=400)
        tpl.scheduled_date = d
    else:
        tpl.scheduled_date = None

    # Update daily send limit if provided
    if 'daily_send_limit' in data:
        limit = data['daily_send_limit']
        tpl.daily_send_limit = max(0, int(limit)) if limit else 0

    tpl.save()

    return JsonResponse({
        'ok': True,
        'date': str(tpl.scheduled_date) if tpl.scheduled_date else '',
        'daily_send_limit': tpl.daily_send_limit,
    })


@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def get_touchpoint_schedules(request):
    schedules = {}
    limits = {}
    campaign = _resolve_campaign(request.GET.get('campaign_id'))
    for t in TouchpointTemplate.objects.filter(is_goodbye=False, campaign=campaign):
        if t.scheduled_date:
            schedules[str(t.touchpoint_number)] = str(t.scheduled_date)
        if t.daily_send_limit > 0:
            limits[str(t.touchpoint_number)] = t.daily_send_limit
    return JsonResponse({'ok': True, 'schedules': schedules, 'limits': limits})


# ── Campaign groups & campaigns (group → campaign → flow) ───────────────────

@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def campaign_groups_list(request):
    from django.db.models import Count
    groups = [{
        'id': g.id,
        'name': g.name,
        'description': g.description,
        'campaigns': g.campaign_count,
        'created_at': g.created_at.isoformat(),
    } for g in CampaignGroup.objects.annotate(campaign_count=Count('campaigns')).order_by('name')]
    return JsonResponse({'ok': True, 'groups': groups})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def campaign_groups_update(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    g = CampaignGroup.objects.filter(id=data.get('id')).first()
    if not g:
        return JsonResponse({'error': 'Group not found'}, status=404)
    if (data.get('name') or '').strip():
        g.name = data['name'].strip()
    if 'description' in data:
        g.description = (data.get('description') or '').strip()
    g.save()
    return JsonResponse({'ok': True})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def campaign_groups_create(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    name = (data.get('name') or '').strip()
    if not name:
        return JsonResponse({'error': 'Name is required'}, status=400)
    g = CampaignGroup.objects.create(name=name)
    return JsonResponse({'ok': True, 'id': g.id})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin')
def campaign_groups_delete(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    deleted, _ = CampaignGroup.objects.filter(id=data.get('id')).delete()
    return JsonResponse({'ok': True, 'deleted': bool(deleted)})


@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def campaigns_list(request):
    qs = Campaign.objects.select_related('group', 'segment')
    group_id = request.GET.get('group_id')
    if group_id:
        qs = qs.filter(group_id=group_id)
    campaigns = []
    for c in qs.order_by('name'):
        tps = c.touchpoints.filter(is_goodbye=False)
        campaigns.append({
            'id': c.id,
            'name': c.name,
            'group_id': c.group_id,
            'group_name': c.group.name,
            'description': c.description,
            'is_automated': c.is_automated,
            'segment_id': c.segment_id,
            'audience': c.segment.name if c.segment else '',
            'runs': SendJob.objects.filter(touchpoint__campaign=c, is_test=False).count(),
            'touchpoints': sum(1 for t in tps if (t.subject or t.body or t.body_html)),
            'created_at': c.created_at.isoformat(),
        })
    return JsonResponse({'ok': True, 'campaigns': campaigns})


@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def campaigns_detail(request):
    c = Campaign.objects.select_related('group').filter(id=request.GET.get('id')).first()
    if not c:
        return JsonResponse({'error': 'Campaign not found'}, status=404)
    return JsonResponse({'ok': True, 'campaign': {
        'id': c.id, 'name': c.name, 'description': c.description,
        'group_id': c.group_id, 'group_name': c.group.name,
    }})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def campaigns_create(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    name = (data.get('name') or '').strip()
    group = CampaignGroup.objects.filter(id=data.get('group_id')).first()
    if not name or not group:
        return JsonResponse({'error': 'Name and group_id are required'}, status=400)
    segment = Segment.objects.filter(id=data.get('segment_id')).first() if data.get('segment_id') else None
    c = Campaign.objects.create(
        name=name,
        group=group,
        description=(data.get('notes') or data.get('description') or '').strip(),
        segment=segment,
        is_automated=bool(data.get('is_automated')),
    )
    return JsonResponse({'ok': True, 'id': c.id})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def campaigns_update(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    c = Campaign.objects.filter(id=data.get('id')).first()
    if not c:
        return JsonResponse({'error': 'Campaign not found'}, status=404)
    if (data.get('name') or '').strip():
        c.name = data['name'].strip()
    if 'notes' in data or 'description' in data:
        c.description = (data.get('notes') or data.get('description') or '').strip()
    if 'segment_id' in data:
        c.segment = Segment.objects.filter(id=data.get('segment_id')).first() if data.get('segment_id') else None
    c.save()
    return JsonResponse({'ok': True})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin')
def campaigns_delete(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    deleted, _ = Campaign.objects.filter(id=data.get('id')).delete()
    return JsonResponse({'ok': True, 'deleted': bool(deleted)})


# ── Campaign flow board / goodbyes / flow templates ─────────────────────────

GOODBYE_OFFSET = TouchpointTemplate.GOODBYE_OFFSET


def _goodbye_number(goodbye_for):
    """Storage touchpoint_number for a goodbye (0 = campaign-wide fallback)."""
    return GOODBYE_OFFSET + int(goodbye_for or 0)


@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def flow_board(request):
    """The campaign journey: touchpoint tiles with waits, journey progress,
    bounce splits, and their optional goodbyes — data for the board."""
    campaign = _resolve_campaign(request.GET.get('campaign_id'))
    tps = {t.touchpoint_number: t for t in TouchpointTemplate.objects.filter(is_goodbye=False, campaign=campaign)}
    goodbyes = {g.goodbye_for or 0: g for g in TouchpointTemplate.objects.filter(is_goodbye=True, campaign=campaign)}

    def gb_dict(g):
        return {
            'name': g.name,
            'subject': g.subject,
            'has_content': bool(g.subject or g.body or g.body_html),
            'test_number': g.touchpoint_number,
        } if g else None

    # Journey progress: how many of the audience have received each touchpoint.
    audience = Contact.objects.filter(status='active').count()
    journey = Contact.objects.filter(last_touchpoint__gt=0, last_campaign=campaign).values_list('last_touchpoint', flat=True)
    by_position = {}
    for pos in journey:
        by_position[pos] = by_position.get(pos, 0) + 1

    # Opt-outs per touchpoint: contacts who opted out right after receiving it.
    optout_by_tp = {}
    for pos in Contact.objects.filter(
        status='opted_out', last_campaign=campaign, last_touchpoint__gt=0,
    ).values_list('last_touchpoint', flat=True):
        optout_by_tp[pos] = optout_by_tp.get(pos, 0) + 1

    # Delivery failures per touchpoint, split soft (temporary) / hard (permanent).
    bounce_split = {n: {'soft': 0, 'hard': 0} for n in tps.keys()}
    failed = SendLog.objects.filter(
        status='failed', job__is_test=False, job__touchpoint__campaign=campaign,
    ).values_list('job__touchpoint__touchpoint_number', 'error')
    for tp_num, err in failed:
        if tp_num in bounce_split:
            kind, _ = _categorize_bounce(err)
            if kind in ('soft', 'hard'):
                bounce_split[tp_num][kind] += 1
            else:
                bounce_split[tp_num]['soft'] += 1

    # Beacon-style: the campaign owns any number of touchpoints — the board
    # shows exactly the ones that exist, in sequence.
    board = []
    for n in sorted(tps.keys()):
        t = tps[n]
        received = sum(c for pos, c in by_position.items() if pos >= n)
        wait_min = t.wait_in_minutes()
        board.append({
            'touchpoint_number': n,
            'name': t.name,
            'subject': t.subject,
            'has_content': bool(t.subject or t.body or t.body_html),
            'days_after_previous': t.days_after_previous,
            'wait_minutes': wait_min,
            'wait_label': TouchpointTemplate.human_wait(wait_min),
            'wait_parts': TouchpointTemplate.decompose_wait(wait_min),
            'send_time': t.send_time.strftime('%H:%M') if t.send_time else '',
            'scheduled_date': str(t.scheduled_date) if t.scheduled_date else '',
            'daily_send_limit': t.daily_send_limit,
            'received': received,
            'audience': max(audience, received),
            'bounces_soft': bounce_split.get(n, {}).get('soft', 0),
            'bounces_hard': bounce_split.get(n, {}).get('hard', 0),
            'optouts': optout_by_tp.get(n, 0),
            'goodbye': gb_dict(goodbyes.get(n)),
        })
    return JsonResponse({
        'ok': True,
        'touchpoints': board,
        'campaign_goodbye': gb_dict(goodbyes.get(0)),
    })


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def flow_touchpoint_add(request):
    """Add one email (a step) to the journey: where it sits ('It comes after'),
    what it starts from (optional saved template), and how long to wait before
    it — minutes to months, with an optional pinned send time, or a pinned
    calendar date that overrides the wait."""
    from django.db import transaction
    from django.db.models import Max
    from django.utils.dateparse import parse_time, parse_date

    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    campaign = _resolve_campaign(data.get('campaign_id'))
    steps = campaign.touchpoints.filter(is_goodbye=False)
    # No cap — like Beacon, a journey holds as many touchpoints as you add.
    highest = steps.aggregate(m=Max('touchpoint_number'))['m'] or 0

    # Position: it comes after step N (0 = make it the first email)
    try:
        after = int(data.get('after', highest))
    except (TypeError, ValueError):
        after = highest
    after = max(0, min(after, highest))
    new_n = after + 1

    # Wait: unit fields (Beacon) or plain days (legacy callers)
    if any(k in data for k in ('months', 'weeks', 'days', 'hours', 'minutes')):
        minutes = TouchpointTemplate.compose_wait(data)
    else:
        try:
            minutes = max(0, int(data.get('days_after_previous', 7))) * 1440
        except (TypeError, ValueError):
            minutes = 7 * 1440
    send_time = parse_time((data.get('send_time') or '').strip()) if (data.get('send_time') or '').strip() else None
    send_date = parse_date((data.get('send_date') or '').strip()) if (data.get('send_date') or '').strip() else None

    lib = EmailTemplate.objects.filter(id=data.get('template_id')).first() if data.get('template_id') else None

    with transaction.atomic():
        # Later steps (and their goodbyes) step aside — descending keeps the key clear
        for row in steps.filter(touchpoint_number__gte=new_n).order_by('-touchpoint_number'):
            row.touchpoint_number += 1
            row.save(update_fields=['touchpoint_number'])
        for g in campaign.touchpoints.filter(is_goodbye=True, goodbye_for__gte=new_n).order_by('-goodbye_for'):
            g.goodbye_for += 1
            g.touchpoint_number = TouchpointTemplate.GOODBYE_OFFSET + g.goodbye_for
            g.save(update_fields=['goodbye_for', 'touchpoint_number'])
        Contact.objects.filter(last_campaign=campaign, last_touchpoint__gte=new_n).update(
            last_touchpoint=F('last_touchpoint') + 1,
        )
        step = TouchpointTemplate.objects.create(
            campaign=campaign,
            touchpoint_number=new_n,
            wait_minutes=0 if new_n == 1 else minutes,
            days_after_previous=0 if new_n == 1 else minutes // 1440,
            send_time=send_time,
            scheduled_date=send_date,
            subject=lib.subject if lib else '',
            body=lib.body if lib else '',
            body_html=lib.body_html if lib else '',
            signature=lib.signature if lib else '',
            opt_out_text=(lib.opt_out_text if lib and lib.opt_out_text else TouchpointTemplate._meta.get_field('opt_out_text').get_default()),
        )
    return JsonResponse({
        'ok': True,
        'touchpoint_number': step.touchpoint_number,
        'wait_label': TouchpointTemplate.human_wait(step.wait_in_minutes()),
        'copied_from': lib.name if lib else '',
    })


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def flow_touchpoint_rename(request):
    """Give a touchpoint (or a goodbye email, by its storage number) a custom
    label. Blank = back to the default name."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    tp_num = data.get('touchpoint_number')
    if not tp_num or int(tp_num) < 1:
        return JsonResponse({'error': 'touchpoint_number required'}, status=400)
    n = int(tp_num)
    campaign = _resolve_campaign(data.get('campaign_id'))
    if n >= TouchpointTemplate.GOODBYE_OFFSET:
        tpl = TouchpointTemplate.objects.filter(touchpoint_number=n, campaign=campaign, is_goodbye=True).first()
        if not tpl:
            return JsonResponse({'error': 'Goodbye email not found'}, status=404)
    else:
        tpl, _ = TouchpointTemplate.objects.get_or_create(touchpoint_number=n, campaign=campaign)
    tpl.name = (data.get('name') or '').strip()[:200]
    tpl.save(update_fields=['name', 'updated_at'])
    return JsonResponse({'ok': True, 'name': tpl.name})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def flow_touchpoint_delete(request):
    """Remove a touchpoint from the sequence. Its content and schedule are
    removed; later steps close ranks (renumber down), and past sends keep
    their history (jobs keep running totals with the touchpoint set to null)."""
    from django.db import transaction

    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    tp_num = data.get('touchpoint_number')
    if not tp_num:
        return JsonResponse({'error': 'touchpoint_number required'}, status=400)
    n = int(tp_num)
    campaign = _resolve_campaign(data.get('campaign_id'))

    t = TouchpointTemplate.objects.filter(touchpoint_number=n, is_goodbye=False, campaign=campaign).first()
    if not t:
        return JsonResponse({'error': 'Touchpoint not found'}, status=404)

    with transaction.atomic():
        # Its goodbye goes with it
        TouchpointTemplate.objects.filter(campaign=campaign, is_goodbye=True, goodbye_for=n).delete()
        t.delete()
        # Later steps close ranks (ascending order keeps the unique key clear)
        for row in TouchpointTemplate.objects.filter(
            campaign=campaign, is_goodbye=False, touchpoint_number__gt=n,
        ).order_by('touchpoint_number'):
            row.touchpoint_number -= 1
            row.save(update_fields=['touchpoint_number'])
        for g in TouchpointTemplate.objects.filter(
            campaign=campaign, is_goodbye=True, goodbye_for__gt=n,
        ).order_by('goodbye_for'):
            g.goodbye_for -= 1
            g.touchpoint_number = TouchpointTemplate.GOODBYE_OFFSET + g.goodbye_for
            g.save(update_fields=['goodbye_for', 'touchpoint_number'])
        # Contacts already past the deleted step shift down so the journey stays coherent
        Contact.objects.filter(last_campaign=campaign, last_touchpoint__gte=n).update(
            last_touchpoint=F('last_touchpoint') - 1,
        )
    return JsonResponse({'ok': True})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def flow_touchpoint_clear(request):
    """'Delete' a touchpoint from the board: its content and schedule are
    removed. Past sends keep their history (the row stays for FK integrity)."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    tp_num = data.get('touchpoint_number')
    if not tp_num or int(tp_num) < 1:
        return JsonResponse({'error': 'touchpoint_number required'}, status=400)
    campaign = _resolve_campaign(data.get('campaign_id'))
    t = TouchpointTemplate.objects.filter(touchpoint_number=int(tp_num), is_goodbye=False, campaign=campaign).first()
    if t:
        t.subject = ''
        t.body = ''
        t.body_html = ''
        t.signature = ''
        t.scheduled_date = None
        t.attachment = None
        t.signature_image = None
        t.save()
    return JsonResponse({'ok': True})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def flow_wait_save(request):
    """Edit the wait before a touchpoint — combine units freely (months to
    minutes), optionally pinning the clock time it sends at, or a calendar
    date that overrides the wait."""
    from django.utils.dateparse import parse_time, parse_date

    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    tp_num = data.get('touchpoint_number')
    if not tp_num or int(tp_num) < 1:
        return JsonResponse({'error': 'touchpoint_number required'}, status=400)

    if any(k in data for k in ('months', 'weeks', 'days', 'hours', 'minutes')):
        minutes = TouchpointTemplate.compose_wait(data)
    else:
        try:
            minutes = max(0, int(data.get('days_after_previous', 7))) * 1440
        except (TypeError, ValueError):
            return JsonResponse({'error': 'Invalid wait'}, status=400)

    campaign = _resolve_campaign(data.get('campaign_id'))
    tpl, _ = TouchpointTemplate.objects.get_or_create(touchpoint_number=int(tp_num), campaign=campaign)
    tpl.wait_minutes = minutes
    tpl.days_after_previous = minutes // 1440
    if 'send_time' in data:
        raw = (data.get('send_time') or '').strip()
        tpl.send_time = parse_time(raw) if raw else None
    if 'send_date' in data:
        raw = (data.get('send_date') or '').strip()
        tpl.scheduled_date = parse_date(raw) if raw else None
    tpl.save(update_fields=['wait_minutes', 'days_after_previous', 'send_time', 'scheduled_date', 'updated_at'])
    return JsonResponse({
        'ok': True,
        'wait_minutes': minutes,
        'wait_label': TouchpointTemplate.human_wait(minutes),
    })


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def goodbye_save(request):
    """Create/update a goodbye email for a touchpoint (or campaign-wide when goodbye_for is empty)."""
    raw = request.POST.get('goodbye_for', '')
    try:
        goodbye_for = int(raw) if str(raw).strip() else None
    except ValueError:
        return JsonResponse({'ok': False, 'error': 'Invalid goodbye_for'}, status=400)
    if goodbye_for is not None and goodbye_for < 1:
        return JsonResponse({'ok': False, 'error': 'goodbye_for must be a touchpoint number'}, status=400)

    campaign = _resolve_campaign(request.POST.get('campaign_id'))
    tpl, _ = TouchpointTemplate.objects.get_or_create(
        touchpoint_number=_goodbye_number(goodbye_for),
        campaign=campaign,
        defaults={'is_goodbye': True, 'goodbye_for': goodbye_for},
    )
    tpl.is_goodbye = True
    tpl.goodbye_for = goodbye_for
    tpl.subject = request.POST.get('subject', '')
    tpl.body = request.POST.get('body', '')
    tpl.body_html = request.POST.get('body_html', '')
    tpl.signature = request.POST.get('signature', '')

    if request.FILES.get('signature_image'):
        tpl.signature_image = request.FILES['signature_image']
    if request.POST.get('clear_signature_image') == '1':
        tpl.signature_image = None

    try:
        tpl.save()
    except Exception as e:
        return JsonResponse({'ok': False, 'error': f'Failed to save goodbye: {e}'}, status=500)
    return JsonResponse({'ok': True, 'test_number': tpl.touchpoint_number})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def goodbye_delete(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    raw = data.get('goodbye_for', '')
    goodbye_for = int(raw) if str(raw).strip() else None
    campaign = _resolve_campaign(data.get('campaign_id'))
    deleted, _ = TouchpointTemplate.objects.filter(
        is_goodbye=True, touchpoint_number=_goodbye_number(goodbye_for), campaign=campaign,
    ).delete()
    return JsonResponse({'ok': True, 'deleted': bool(deleted)})


@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def goodbye_get(request):
    """Full content of one goodbye email (for the editor)."""
    raw = request.GET.get('goodbye_for', '')
    goodbye_for = int(raw) if str(raw).strip() else None
    campaign = _resolve_campaign(request.GET.get('campaign_id'))
    g = TouchpointTemplate.objects.filter(
        is_goodbye=True, touchpoint_number=_goodbye_number(goodbye_for), campaign=campaign,
    ).first()
    if not g:
        return JsonResponse({'ok': True, 'goodbye': None})
    return JsonResponse({'ok': True, 'goodbye': {
        'goodbye_for': g.goodbye_for,
        'subject': g.subject,
        'body': g.body,
        'body_html': g.body_html,
        'signature': g.signature,
        'opt_out_text': g.opt_out_text,
        'attachment_name': g.attachment.name.split('/')[-1] if g.attachment else '',
        'attachment_url': g.attachment.url if g.attachment else '',
        'signature_image_name': g.signature_image.name.split('/')[-1] if g.signature_image else '',
        'signature_image_url': g.signature_image.url if g.signature_image else '',
        'signature_image_height': g.signature_image_height,
        'signature_image_width': g.signature_image_width,
        'test_number': g.touchpoint_number,
    }})


def _send_goodbye_email(contact):
    """Send the matching goodbye after an opt-out: the goodbye for the contact's
    last campaign + touchpoint, falling back to that campaign's campaign-wide
    goodbye. Runs best-effort."""
    gb = TouchpointTemplate.objects.filter(
        is_goodbye=True, goodbye_for=contact.last_touchpoint, campaign=contact.last_campaign,
    ).first()
    if not gb:
        gb = TouchpointTemplate.objects.filter(
            is_goodbye=True, goodbye_for__isnull=True, campaign=contact.last_campaign,
        ).first()
    if not gb or not gb.subject:
        return False

    body = gb.body_html or _text_to_html(gb.body)
    if gb.signature and not gb.body_html:
        body += f'<div style="margin-top:12px;white-space:pre-wrap">{escape(gb.signature)}</div>'
    var_map = {
        '{{org_name}}': contact.org_name,
        '{{contact_name}}': contact.contact_name,
        '{{email}}': contact.email,
        '{{phone}}': contact.phone,
    }
    subj = gb.subject
    for var, val in var_map.items():
        subj = subj.replace(var, val)
        body = body.replace(var, val)

    sent_ok, msg = _ses_send_mail(to_address=contact.email, subject=subj, body_html=body)
    print(f'[GOODBYE] {contact.email} (after TP{contact.last_touchpoint}): sent={sent_ok} {msg if not sent_ok else ""}', flush=True)
    return sent_ok


# ── Flow templates (save/reproduce the whole journey) ───────────────────────

@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def flow_templates_list(request):
    items = [{
        'id': f.id,
        'name': f.name,
        'touchpoint_count': len([t for t in (f.data.get('touchpoints') or []) if not t.get('is_goodbye')]),
        'goodbye_count': len([t for t in (f.data.get('touchpoints') or []) if t.get('is_goodbye')]),
        'created_by': f.created_by.username if f.created_by else '',
        'created_at': f.created_at.isoformat(),
    } for f in FlowTemplate.objects.select_related('created_by')]
    return JsonResponse({'ok': True, 'flow_templates': items})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def flow_templates_save(request):
    """Snapshot the current flow (content + waits + goodbyes; files are not snapshotted)."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    name = (data.get('name') or '').strip()
    if not name:
        return JsonResponse({'error': 'Name is required'}, status=400)

    campaign = _resolve_campaign(data.get('campaign_id'))
    snapshot = []
    for t in TouchpointTemplate.objects.filter(campaign=campaign):
        snapshot.append({
            'touchpoint_number': t.touchpoint_number,
            'is_goodbye': t.is_goodbye,
            'goodbye_for': t.goodbye_for,
            'subject': t.subject,
            'body': t.body,
            'body_html': t.body_html,
            'signature': t.signature,
            'opt_out_text': t.opt_out_text,
            'days_after_previous': t.days_after_previous,
            'wait_minutes': t.wait_minutes,
            'send_time': t.send_time.strftime('%H:%M') if t.send_time else '',
            'daily_send_limit': t.daily_send_limit,
        })
    f = FlowTemplate.objects.create(name=name, data={'touchpoints': snapshot}, created_by=request.user)
    return JsonResponse({'ok': True, 'id': f.id})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def flow_templates_apply(request):
    """Reproduce a saved flow: overwrite touchpoint/goodbye content and waits."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    f = FlowTemplate.objects.filter(id=data.get('id')).first()
    if not f:
        return JsonResponse({'error': 'Flow template not found'}, status=404)

    campaign = _resolve_campaign(data.get('campaign_id'))
    applied = 0
    for entry in (f.data.get('touchpoints') or []):
        num = entry.get('touchpoint_number')
        if not isinstance(num, int):
            continue
        tpl, _ = TouchpointTemplate.objects.get_or_create(touchpoint_number=num, campaign=campaign)
        tpl.is_goodbye = bool(entry.get('is_goodbye'))
        tpl.goodbye_for = entry.get('goodbye_for')
        tpl.subject = entry.get('subject', '')
        tpl.body = entry.get('body', '')
        tpl.body_html = entry.get('body_html', '')
        tpl.signature = entry.get('signature', '')
        if entry.get('opt_out_text'):
            tpl.opt_out_text = entry['opt_out_text']
        tpl.days_after_previous = int(entry.get('days_after_previous', 7) or 7)
        tpl.wait_minutes = entry.get('wait_minutes')
        if entry.get('send_time'):
            from django.utils.dateparse import parse_time
            tpl.send_time = parse_time(entry['send_time'])
        tpl.daily_send_limit = int(entry.get('daily_send_limit', 0) or 0)
        tpl.save()
        applied += 1
    return JsonResponse({'ok': True, 'applied': applied})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def flow_templates_delete(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    deleted, _ = FlowTemplate.objects.filter(id=data.get('id')).delete()
    return JsonResponse({'ok': True, 'deleted': bool(deleted)})


# ── Contact views ────────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def contacts_list(request):
    status_filter = request.GET.get('status', '')
    search = request.GET.get('search', '').strip()
    tp_filter = request.GET.get('last_touchpoint', '')
    group_filter = request.GET.get('import_group', '')
    segment_filter = request.GET.get('segment', '')

    qs = Contact.objects.select_related('import_group', 'segment', 'last_campaign').prefetch_related('tags')
    if status_filter:
        # 'undeliverable' also covers legacy/SES 'bounced'
        if status_filter == 'undeliverable':
            qs = qs.filter(status__in=['undeliverable', 'bounced'])
        else:
            qs = qs.filter(status=status_filter)
    if tp_filter:
        if tp_filter == 'none':
            qs = qs.filter(last_touchpoint=0)
        else:
            try:
                qs = qs.filter(last_touchpoint=int(tp_filter))
            except ValueError:
                pass
    if group_filter:
        if group_filter == 'none':
            qs = qs.filter(import_group__isnull=True)
        else:
            try:
                qs = qs.filter(import_group_id=int(group_filter))
            except ValueError:
                pass
    if segment_filter:
        if segment_filter == 'none':
            qs = qs.filter(segment__isnull=True)
        else:
            try:
                qs = qs.filter(segment_id=int(segment_filter))
            except ValueError:
                pass
    if search:
        from django.db.models import Q
        qs = qs.filter(
            Q(org_name__icontains=search) |
            Q(contact_name__icontains=search) |
            Q(email__icontains=search)
        )

    contacts = []
    for c in qs:
        contacts.append({
            'id': c.id,
            'org_name': c.org_name,
            'contact_name': c.contact_name,
            'email': c.email,
            'phone': c.phone,
            'status': c.status,
            'opt_out_reason': c.opt_out_reason,
            'notes': c.notes,
            'last_touchpoint': c.last_touchpoint,
            'last_campaign_id': c.last_campaign_id,
            'last_campaign_name': c.last_campaign.name if c.last_campaign else None,
            'import_group_id': c.import_group_id,
            'import_group_name': c.import_group.name if c.import_group else None,
            'segment_id': c.segment_id,
            'segment_name': c.segment.name if c.segment else None,
            'tags': [{'id': t.id, 'name': t.name} for t in c.tags.all()],
            'custom_data': c.custom_data or {},
            'created_at': c.created_at.isoformat(),
            'updated_at': c.updated_at.isoformat(),
        })

    # Summary counts
    total = Contact.objects.count()
    active = Contact.objects.filter(status='active').count()
    inactive = Contact.objects.filter(status='inactive').count()
    opted_out = Contact.objects.filter(status='opted_out').count()
    undeliverable = Contact.objects.filter(status__in=['undeliverable', 'bounced']).count()
    bounced = Contact.objects.filter(status='bounced').count()
    moved_to_hubspot = Contact.objects.filter(status='moved_to_hubspot').count()

    # Import groups list
    from django.db.models import Count
    groups = list(
        ImportGroup.objects.annotate(contact_count=Count('contacts'))
        .order_by('-created_at')
        .values('id', 'name', 'contact_count', 'created_at')
    )
    for g in groups:
        g['created_at'] = g['created_at'].isoformat()

    # Segments list (children of import groups)
    segments = list(
        Segment.objects.annotate(contact_count=Count('contacts'))
        .order_by('import_group__name', 'name')
        .values('id', 'name', 'import_group_id', 'contact_count')
    )

    return JsonResponse({
        'ok': True,
        'contacts': contacts,
        'counts': {
            'total': total,
            'active': active,
            'inactive': inactive,
            'opted_out': opted_out,
            'undeliverable': undeliverable,
            'bounced': bounced,
            'moved_to_hubspot': moved_to_hubspot,
        },
        'import_groups': groups,
        'segments': segments,
        'tags': [
            {'id': t.id, 'name': t.name, 'contact_count': t.n}
            for t in Tag.objects.annotate(n=Count('contacts')).order_by('name')
        ],
        'custom_fields': list(CustomField.objects.values_list('name', flat=True)),
        'pending_approvals': ReactivationRequest.objects.filter(status='pending').count(),
    })


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def contacts_create(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    email = data.get('email', '').strip()
    if not email:
        return JsonResponse({'error': 'Email is required'}, status=400)
    if Contact.objects.filter(email=email).exists():
        return JsonResponse({'error': 'A contact with this email already exists'}, status=400)

    custom_data = data.get('custom_data') or {}
    if not isinstance(custom_data, dict):
        custom_data = {}
    c = Contact.objects.create(
        org_name=data.get('org_name', '').strip(),
        contact_name=data.get('contact_name', '').strip(),
        email=email,
        phone=data.get('phone', '').strip(),
        status=data.get('status', 'active'),
        notes=data.get('notes', '').strip(),
        custom_data={k: str(v) for k, v in custom_data.items()},
    )
    return JsonResponse({'ok': True, 'id': c.id})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def contacts_update(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    contact_id = data.get('id')
    if not contact_id:
        return JsonResponse({'error': 'id is required'}, status=400)

    try:
        c = Contact.objects.get(id=contact_id)
    except Contact.DoesNotExist:
        return JsonResponse({'error': 'Contact not found'}, status=404)

    for field in ('org_name', 'contact_name', 'email', 'phone', 'status', 'opt_out_reason', 'notes'):
        if field in data:
            setattr(c, field, data[field].strip() if isinstance(data[field], str) else data[field])

    # Custom field values — replaces the whole dict (the form sends all values).
    if 'custom_data' in data and isinstance(data['custom_data'], dict):
        c.custom_data = {k: str(v) for k, v in data['custom_data'].items() if str(v).strip()}

    # Segment assignment (segment_id: int to set, null/empty to clear).
    # Setting a segment also syncs the contact's import_group to the segment's parent.
    if 'segment_id' in data:
        seg_val = data['segment_id']
        if seg_val in (None, '', 'none'):
            c.segment = None
        else:
            seg = Segment.objects.filter(id=seg_val).select_related('import_group').first()
            if not seg:
                return JsonResponse({'error': 'Segment not found'}, status=404)
            c.segment = seg
            c.import_group = seg.import_group
    c.save()
    return JsonResponse({'ok': True})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def contacts_bulk_update(request):
    """Bulk update a field on multiple contacts at once."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    ids = data.get('ids', [])
    if not ids:
        return JsonResponse({'error': 'ids is required'}, status=400)

    updates = {}
    for field in ('status', 'org_name', 'contact_name', 'phone', 'opt_out_reason', 'notes'):
        if field in data:
            updates[field] = data[field].strip() if isinstance(data[field], str) else data[field]

    # Bulk segment assignment (segment_id: int to set, null/empty to clear).
    if 'segment_id' in data:
        seg_val = data['segment_id']
        if seg_val in (None, '', 'none'):
            updates['segment'] = None
        else:
            seg = Segment.objects.filter(id=seg_val).select_related('import_group').first()
            if not seg:
                return JsonResponse({'error': 'Segment not found'}, status=404)
            updates['segment'] = seg
            updates['import_group'] = seg.import_group

    # Bulk group removal/assignment (import_group_id: int to set, null/empty to clear).
    if 'import_group_id' in data:
        grp_val = data['import_group_id']
        if grp_val in (None, '', 'none'):
            updates['import_group'] = None
        else:
            grp = ImportGroup.objects.filter(id=grp_val).first()
            if not grp:
                return JsonResponse({'error': 'Group not found'}, status=404)
            updates['import_group'] = grp

    if not updates:
        return JsonResponse({'error': 'No fields to update'}, status=400)

    count = Contact.objects.filter(id__in=ids).update(**updates)
    return JsonResponse({'ok': True, 'updated': count})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def segments_create(request):
    """Create a segment under an import group (existing group_id or new group_name)."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    name = (data.get('name') or '').strip()
    if not name:
        return JsonResponse({'error': 'Segment name is required'}, status=400)

    group_id = data.get('group_id')
    group_name = (data.get('group_name') or '').strip()
    if group_id:
        import_group = ImportGroup.objects.filter(id=group_id).first()
        if not import_group:
            return JsonResponse({'error': 'Import group not found'}, status=404)
    elif group_name:
        import_group, _ = ImportGroup.objects.get_or_create(name=group_name)
    else:
        return JsonResponse({'error': 'An import group is required for a segment'}, status=400)

    segment, created = Segment.objects.get_or_create(import_group=import_group, name=name)
    return JsonResponse({
        'ok': True,
        'created': created,
        'segment': {'id': segment.id, 'name': segment.name, 'import_group_id': import_group.id},
        'import_group': {'id': import_group.id, 'name': import_group.name},
    })


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def segments_update(request):
    """Update segment metadata — currently the manually-tracked positive_replies count."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    seg = Segment.objects.filter(id=data.get('id')).first()
    if not seg:
        return JsonResponse({'error': 'Segment not found'}, status=404)
    if 'positive_replies' in data:
        try:
            seg.positive_replies = max(0, int(data['positive_replies']))
        except (TypeError, ValueError):
            return JsonResponse({'error': 'positive_replies must be a number'}, status=400)
    if 'name' in data and str(data['name']).strip():
        seg.name = str(data['name']).strip()
    seg.save()
    return JsonResponse({'ok': True, 'positive_replies': seg.positive_replies, 'name': seg.name})


# ── Reusable template library ────────────────────────────────────────────────
def _template_dict(t):
    return {
        'id': t.id,
        'name': t.name,
        'subject': t.subject,
        'body_html': t.body_html,
        'body': t.body,
        'signature': t.signature,
        'opt_out_text': t.opt_out_text,
        'attachment_name': t.attachment.name.split('/')[-1] if t.attachment else '',
        'attachment_url': t.attachment.url if t.attachment else '',
        'signature_image_name': t.signature_image.name.split('/')[-1] if t.signature_image else '',
        'signature_image_url': t.signature_image.url if t.signature_image else '',
        'updated_at': t.updated_at.isoformat(),
    }


@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def templates_library_list(request):
    """List all saved reusable email templates."""
    templates = [_template_dict(t) for t in EmailTemplate.objects.all()]
    return JsonResponse({'ok': True, 'templates': templates})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def templates_library_save(request):
    """Create or update a reusable template (multipart form). Pass `id` to update, omit to create."""
    name = (request.POST.get('name') or '').strip()
    if not name:
        return JsonResponse({'error': 'Template name is required'}, status=400)

    tpl_id = request.POST.get('id')
    if tpl_id:
        tpl = EmailTemplate.objects.filter(id=tpl_id).first()
        if not tpl:
            return JsonResponse({'error': 'Template not found'}, status=404)
    else:
        tpl = EmailTemplate(created_by=request.user if request.user.is_authenticated else None)

    tpl.name = name
    tpl.subject = (request.POST.get('subject') or '').strip()
    tpl.body_html = request.POST.get('body_html') or ''
    tpl.body = request.POST.get('body') or ''
    tpl.signature = request.POST.get('signature') or ''
    if 'opt_out_text' in request.POST:
        tpl.opt_out_text = request.POST.get('opt_out_text') or ''

    if request.FILES.get('attachment'):
        tpl.attachment = request.FILES['attachment']
    if request.POST.get('clear_attachment') == '1':
        tpl.attachment = None

    if request.FILES.get('signature_image'):
        tpl.signature_image = request.FILES['signature_image']
    if request.POST.get('clear_signature_image') == '1':
        tpl.signature_image = None

    # "Save As": when branching from an existing template, carry over its files
    # unless the user uploaded/cleared them in this request.
    copy_from = request.POST.get('copy_files_from')
    if copy_from and not tpl_id:
        src = EmailTemplate.objects.filter(id=copy_from).first()
        if src:
            if not request.FILES.get('attachment') and request.POST.get('clear_attachment') != '1' and src.attachment:
                tpl.attachment = src.attachment.name
            if not request.FILES.get('signature_image') and request.POST.get('clear_signature_image') != '1' and src.signature_image:
                tpl.signature_image = src.signature_image.name

    try:
        tpl.save()
    except Exception as e:
        return JsonResponse({'error': f'Failed to save template: {e}'}, status=500)
    return JsonResponse({'ok': True, 'template': _template_dict(tpl)})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def templates_library_delete(request):
    """Delete a reusable template by id."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    tpl_id = data.get('id')
    if not tpl_id:
        return JsonResponse({'error': 'id is required'}, status=400)
    deleted, _ = EmailTemplate.objects.filter(id=tpl_id).delete()
    return JsonResponse({'ok': True, 'deleted': deleted})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def templates_library_send_test(request):
    """Send a test email of a reusable template (with sample data) to given recipients."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'ok': False, 'error': 'Invalid JSON'}, status=400)

    tpl_id = data.get('template_id')
    recipients = [e.strip() for e in data.get('recipients', []) if e.strip()][:10]
    if not tpl_id or not recipients:
        return JsonResponse({'ok': False, 'error': 'Missing template_id or recipients'}, status=400)

    tpl = EmailTemplate.objects.filter(id=tpl_id).first()
    if not tpl:
        return JsonResponse({'ok': False, 'error': 'Template not found'}, status=404)

    # Build content — always HTML so links (opt-out) are clickable
    if tpl.body_html:
        body_content = tpl.body_html
        if tpl.signature:
            body_content += f'<div style="margin-top:12px;white-space:pre-wrap">{tpl.signature}</div>'
    else:
        body_content = _text_to_html(tpl.body)
        if tpl.signature:
            body_content += f'<div style="margin-top:12px;white-space:pre-wrap">{escape(tpl.signature)}</div>'
    content_type = 'HTML'

    # Inline signature image
    sig_inline = None
    if content_type == 'HTML' and tpl.signature_image:
        try:
            sig_path = tpl.signature_image.path
            sig_name = os.path.basename(sig_path)
            ext = os.path.splitext(sig_name)[1].lower().lstrip('.') or 'png'
            cid = f'signature_tpl{tpl.id}'
            if not re.search(r'cid:signature_tpl?\d+', body_content, flags=re.IGNORECASE):
                body_content += f'<div style="margin-top:16px"><img src="cid:{cid}" alt="Signature" style="{_signature_img_style(tpl.signature_image_height, tpl.signature_image_width)}" /></div>'
            with open(sig_path, 'rb') as sf:
                sig_inline = {
                    'name': sig_name,
                    'contentType': f'image/{"jpeg" if ext == "jpg" else ext}',
                    'contentBytes': base64.b64encode(sf.read()).decode('utf-8'),
                    'contentId': cid,
                    'isInline': True,
                }
        except Exception as e:
            print(f'[lib-test] signature image load failed: {e}', flush=True)

    # Attachments
    attachments = []
    if tpl.attachment:
        try:
            att_path = tpl.attachment.path
            with open(att_path, 'rb') as f:
                att_bytes = f.read()
            name_part, ext = os.path.splitext(os.path.basename(att_path))
            att_name = ' '.join(name_part.replace('_', ' ').replace('-', ' ').split()) + ext
            attachments.append({'name': att_name, 'contentBytes': base64.b64encode(att_bytes).decode('utf-8')})
        except Exception as e:
            print(f'[lib-test] attachment load failed: {e}', flush=True)
    if sig_inline:
        attachments.append(sig_inline)

    sample_vars = {
        '{{org_name}}': 'Sample Corp Inc.',
        '{{contact_name}}': 'John Doe',
        '{{email}}': 'johndoe@samplecorp.com',
        '{{phone}}': '+1 (555) 123-4567',
    }
    subject = tpl.subject
    final_body = body_content
    for var, val in sample_vars.items():
        subject = subject.replace(var, val)
        final_body = final_body.replace(var, val)

    results = []
    blocked = []
    for email_addr in recipients:
        existing = Contact.objects.filter(email=email_addr).first()
        if existing and existing.status != 'active':
            results.append({'email': email_addr, 'ok': False, 'status': f'Blocked: contact is {existing.status}'})
            blocked.append(email_addr)
            continue
        contact, _ = Contact.objects.get_or_create(
            email=email_addr,
            defaults={'org_name': 'Test', 'contact_name': email_addr.split('@')[0], 'status': 'active'},
        )
        test_body = _apply_opt_out(final_body, tpl.opt_out_text, contact.id, is_html=(content_type == 'HTML'))
        sent_ok, msg_id = _ses_send_mail(
            to_address=email_addr,
            subject=subject,
            body_html=test_body if content_type == 'HTML' else None,
            body_text=test_body if content_type == 'Text' else None,
            attachments=attachments if attachments else None,
        )
        results.append({'email': email_addr, 'ok': sent_ok, 'status': msg_id})
        if sent_ok:
            time.sleep(0.1)

    sent_count = sum(1 for r in results if r['ok'])
    msg = f'Test sent to {sent_count}/{len(recipients)} recipient(s)'
    if blocked:
        msg += f' ({len(blocked)} blocked — opted out/bounced)'
    return JsonResponse({'ok': True, 'results': results, 'message': msg})


def _optout_page(title, message, ok=True):
    color = '#054B70' if ok else '#c0392b'
    return HttpResponse(f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title></head>
<body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f0f4f7;display:flex;align-items:center;justify-content:center;min-height:100vh">
  <div style="max-width:440px;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);padding:40px;text-align:center">
    <div style="width:56px;height:56px;border-radius:14px;background:{color};margin:0 auto 20px;display:flex;align-items:center;justify-content:center">
      <span style="color:#fff;font-size:28px">{'✓' if ok else '!'}</span>
    </div>
    <h1 style="font-size:20px;color:#0a2a3c;margin:0 0 10px">{title}</h1>
    <p style="font-size:14px;color:#6b8a9e;line-height:1.6;margin:0">{message}</p>
    <p style="font-size:12px;color:#b0c4d0;margin-top:24px">Magnum Opus Consultants</p>
  </div>
</body></html>""")


@csrf_exempt
@require_http_methods(["GET", "POST"])
def optout_confirm(request, token):
    """Public opt-out endpoint.

    GET shows a confirmation page (with an optional reason box); only the
    POSTed "Unsubscribe me" button actually opts the contact out. Mail
    clients and security scanners prefetch links in emails — acting on GET
    would unsubscribe people who never clicked.
    """
    try:
        data = signing.loads(token, salt=OPTOUT_SALT, max_age=60 * 60 * 24 * 365)
        contact = Contact.objects.filter(id=data.get('cid')).first()
    except signing.BadSignature:
        contact = None
    except Exception:
        contact = None

    if not contact:
        return _optout_page('Link not valid', 'This opt-out link is invalid or has expired. Please reply to the email with "STOP" and we will remove you.', ok=False)

    # GET: ask for confirmation — Beacon's public opt-out card.
    if request.method == 'GET' and contact.status != 'opted_out':
        return HttpResponse(f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribe</title></head>
<body style="margin:0;font-family:Arial,Helvetica,sans-serif;background:#f5f5f7;display:flex;align-items:center;justify-content:center;min-height:100vh">
  <form method="post" style="max-width:430px;width:100%;background:#fff;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);padding:40px;text-align:center">
    <h1 style="font-size:20px;color:#0a2a3c;margin:0 0 10px">Unsubscribe from our emails?</h1>
    <p style="font-size:14px;color:#6b8a9e;line-height:1.6;margin:0 0 18px"><strong>{escape(contact.email)}</strong> will stop receiving all emails from us.</p>
    <label style="display:block;text-align:left;font-size:12px;color:#6b8a9e;margin:0 0 6px">Reason (optional)</label>
    <textarea name="reason" rows="2" placeholder="Tell us why, so we can do better…" style="width:100%;box-sizing:border-box;border:1px solid #d9e2e8;border-radius:10px;padding:10px;font-size:13px;font-family:inherit;resize:vertical"></textarea>
    <button type="submit" style="margin-top:18px;width:100%;background:#c0392b;color:#fff;border:none;border-radius:10px;padding:12px;font-size:14px;font-weight:bold;cursor:pointer">Unsubscribe me</button>
    <p style="font-size:12px;color:#b0c4d0;margin-top:24px">Magnum Opus Consultants</p>
  </form>
</body></html>""")

    if contact.status != 'opted_out':
        # Optional reason from the opt-out page form (POST) or query string.
        reason = ''
        if request.method == 'POST':
            reason = (request.POST.get('reason') or '').strip()[:500]
        contact.status = 'opted_out'
        contact.opt_out_reason = reason or contact.opt_out_reason or 'Unsubscribed via email opt-out link'
        contact.save(update_fields=['status', 'opt_out_reason', 'updated_at'])
        print(f'[OPT-OUT] {contact.email} marked opted_out via link', flush=True)
        # Farewell email (specific to their last touchpoint, else campaign-wide),
        # sent in the background so the confirmation page renders immediately.
        threading.Thread(target=_send_goodbye_email, args=(contact,), daemon=True).start()

    return _optout_page(
        "You've been unsubscribed",
        f'<strong>{escape(contact.email)}</strong> has been removed from our mailing list. You will not receive any further emails from us.',
        ok=True,
    )


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin')
def contacts_delete(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    ids = data.get('ids', [])
    if not ids:
        return JsonResponse({'error': 'ids required'}, status=400)

    deleted, _ = Contact.objects.filter(id__in=ids).delete()
    return JsonResponse({'ok': True, 'deleted': deleted})


# ── Import parsing (CSV + dependency-free .xlsx) ────────────────────────────

BUILTIN_IMPORT_FIELDS = [
    {'key': 'org_name', 'label': 'Organization'},
    {'key': 'contact_name', 'label': 'Contact'},
    {'key': 'email', 'label': 'Email'},
    {'key': 'phone', 'label': 'Phone'},
    {'key': 'status', 'label': 'Status'},
]


def _xlsx_column_index(cell_ref):
    """'BC12' -> 0-based column index (54)."""
    col = 0
    for ch in cell_ref:
        if ch.isalpha():
            col = col * 26 + (ord(ch.upper()) - ord('A') + 1)
        else:
            break
    return col - 1


def _parse_xlsx_rows(file_obj):
    """Parse the first worksheet of an .xlsx into a list of rows (lists of strings).
    Dependency-free: an .xlsx is a zip of XML files."""
    import zipfile
    import xml.etree.ElementTree as ET

    NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(file_obj) as z:
        # Shared strings (cell type "s" indexes into this list)
        shared = []
        if 'xl/sharedStrings.xml' in z.namelist():
            root = ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in root.findall('m:si', NS):
                shared.append(''.join(t.text or '' for t in si.iter(f'{{{NS["m"]}}}t')))

        # First worksheet (sheet order in workbook.xml matches sheetN files via rels;
        # xl/worksheets/sheet1.xml is the standard first sheet)
        sheet_names = sorted(n for n in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml$', n))
        if not sheet_names:
            raise ValueError('No worksheet found in the .xlsx file')
        root = ET.fromstring(z.read(sheet_names[0]))

        rows = []
        for row_el in root.iter(f'{{{NS["m"]}}}row'):
            row = []
            for c in row_el.findall('m:c', NS):
                idx = _xlsx_column_index(c.get('r', ''))
                ctype = c.get('t', 'n')
                if ctype == 'inlineStr':
                    is_el = c.find('m:is', NS)
                    val = ''.join(t.text or '' for t in is_el.iter(f'{{{NS["m"]}}}t')) if is_el is not None else ''
                else:
                    v = c.find('m:v', NS)
                    raw = v.text if v is not None and v.text else ''
                    if ctype == 's':
                        try:
                            val = shared[int(raw)]
                        except (ValueError, IndexError):
                            val = ''
                    else:
                        val = raw
                # Pad to the right column position (sparse rows skip empty cells)
                while len(row) < idx:
                    row.append('')
                if idx >= 0:
                    row.append(str(val))
            rows.append(row)
        return rows


def _parse_upload_rows(uploaded):
    """Return (headers, data_rows) from an uploaded .csv or .xlsx file."""
    name = (uploaded.name or '').lower()
    if name.endswith('.xlsx'):
        rows = _parse_xlsx_rows(uploaded)
    else:
        decoded = uploaded.read().decode('utf-8-sig')
        rows = list(csv.reader(io.StringIO(decoded)))
    rows = [r for r in rows if any((cell or '').strip() for cell in r)]
    if not rows:
        return [], []
    headers = [(h or '').strip() for h in rows[0]]
    width = len(headers)
    data = []
    for r in rows[1:]:
        # Strip whitespace and Excel's leading-apostrophe text marker ('+44 → +44)
        r = [(cell or '').strip().lstrip("'").strip() for cell in r]
        r = (r + [''] * width)[:width] if width else r
        data.append(r)
    return headers, data


def _guess_import_field(header, custom_names):
    """Auto-guess which field a column header maps to."""
    key = re.sub(r'[^a-z0-9]', '', header.lower())
    if not key:
        return 'ignore'
    if key in ('email', 'emailaddress', 'mail', 'e-mail'.replace('-', '')):
        return 'email'
    if key in ('org', 'orgname', 'organization', 'organisation', 'company', 'companyname', 'business'):
        return 'org_name'
    if key in ('name', 'contact', 'contactname', 'fullname', 'person', 'firstname'):
        return 'contact_name'
    if key in ('phone', 'phonenumber', 'tel', 'telephone', 'mobile', 'cell', 'cellphone'):
        return 'phone'
    if key == 'status':
        return 'status'
    # Exact match against an existing custom field name
    for cname in custom_names:
        if re.sub(r'[^a-z0-9]', '', cname.lower()) == key:
            return f'custom:{cname}'
    return 'ignore'


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def contacts_import_preview(request):
    """Parse an uploaded file's headers + sample rows and auto-guess a column mapping."""
    up = request.FILES.get('file')
    if not up:
        return JsonResponse({'error': 'No file uploaded'}, status=400)
    try:
        headers, rows = _parse_upload_rows(up)
    except Exception as e:
        return JsonResponse({'error': f'Cannot parse file: {e}'}, status=400)
    if not headers:
        return JsonResponse({'error': 'The file appears to be empty'}, status=400)

    custom_names = list(CustomField.objects.values_list('name', flat=True))
    mapping = [_guess_import_field(h, custom_names) for h in headers]
    samples = [
        [row[i] if i < len(row) else '' for row in rows[:4]]
        for i in range(len(headers))
    ]
    return JsonResponse({
        'ok': True,
        'headers': headers,
        'samples': samples,
        'guessed_mapping': mapping,
        'row_count': len(rows),
        'builtin_fields': BUILTIN_IMPORT_FIELDS,
        'custom_fields': custom_names,
    })


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def contacts_import_csv(request):
    """Import contacts from a CSV or Excel (.xlsx) file.

    Accepts an optional `mapping` field (JSON array, one entry per column):
    'org_name' | 'contact_name' | 'email' | 'phone' | 'status' | 'ignore' | 'custom:<Name>'.
    Without a mapping, columns are matched by header name (legacy behavior).

    Opt-out protection: an import can NEVER overwrite or reactivate an
    opted-out contact — those rows land on Pending approval instead.
    """
    csv_file = request.FILES.get('file')
    if not csv_file:
        return JsonResponse({'error': 'No file uploaded'}, status=400)

    # Import group: pick an existing one (group_id) or create a new one (group_name).
    group_id = request.POST.get('group_id', '').strip()
    group_name = request.POST.get('group_name', '').strip()
    import_group = None
    created_group = False
    if group_id:
        import_group = ImportGroup.objects.filter(id=group_id).first()
        if not import_group:
            return JsonResponse({'error': 'Selected import group not found'}, status=400)
    elif group_name:
        # Reuse an existing group with the same name rather than duplicating it
        import_group = ImportGroup.objects.filter(name=group_name).order_by('created_at').first()
        if not import_group:
            import_group = ImportGroup.objects.create(name=group_name)
            created_group = True

    # Segment (child of import group): pick existing (segment_id) or create new (segment_name).
    segment_id = request.POST.get('segment_id', '').strip()
    segment_name = request.POST.get('segment_name', '').strip()
    segment = None
    created_segment = False
    if (segment_id or segment_name) and not import_group:
        if created_group:
            import_group.delete()
        return JsonResponse({'error': 'A segment requires an import group'}, status=400)
    if segment_id:
        segment = Segment.objects.filter(id=segment_id, import_group=import_group).first()
        if not segment:
            if created_group:
                import_group.delete()
            return JsonResponse({'error': 'Selected segment not found in this group'}, status=400)
    elif segment_name:
        segment, created_segment = Segment.objects.get_or_create(
            import_group=import_group, name=segment_name,
        )

    # Tags for this upload: existing ids and/or new names (both JSON lists) —
    # applied to every contact the upload creates or touches.
    tags = []
    try:
        tag_ids = json.loads(request.POST.get('tag_ids', '[]'))
        new_tags = json.loads(request.POST.get('new_tags', '[]'))
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid tags'}, status=400)
    for tid in (tag_ids if isinstance(tag_ids, list) else []):
        t = Tag.objects.filter(id=tid).first()
        if t:
            tags.append(t)
    for tname in (new_tags if isinstance(new_tags, list) else []):
        tname = str(tname).strip()[:100]
        if tname:
            t, _ = Tag.objects.get_or_create(name=tname)
            tags.append(t)

    try:
        headers, rows = _parse_upload_rows(csv_file)
    except Exception as e:
        if created_segment:
            segment.delete()
        if created_group:
            import_group.delete()
        return JsonResponse({'error': f'Cannot parse file: {e}'}, status=400)

    # Column mapping: explicit from the request, else guessed from headers.
    mapping_raw = request.POST.get('mapping', '')
    custom_names = list(CustomField.objects.values_list('name', flat=True))
    if mapping_raw:
        try:
            mapping = json.loads(mapping_raw)
            assert isinstance(mapping, list)
        except Exception:
            return JsonResponse({'error': 'Invalid mapping'}, status=400)
    else:
        mapping = [_guess_import_field(h, custom_names) for h in headers]

    if 'email' not in mapping:
        if created_segment:
            segment.delete()
        if created_group:
            import_group.delete()
        return JsonResponse({'error': 'No column is mapped to Email — an email column is required.'}, status=400)

    # Register any new custom fields used by the mapping
    valid_statuses = {s[0] for s in Contact.STATUS_CHOICES}
    for m in mapping:
        if isinstance(m, str) and m.startswith('custom:'):
            fname = m[len('custom:'):].strip()
            if fname:
                CustomField.objects.get_or_create(name=fname)

    def row_to_record(row):
        rec = {'custom_data': {}}
        for idx, m in enumerate(mapping):
            if idx >= len(row) or not isinstance(m, str) or m == 'ignore':
                continue
            val = row[idx].strip()
            if m.startswith('custom:'):
                fname = m[len('custom:'):].strip()
                if fname and val:
                    rec['custom_data'][fname] = val
            elif m in ('org_name', 'contact_name', 'email', 'phone'):
                rec[m] = val
            elif m == 'status':
                sval = re.sub(r'[^a-z]', '_', val.lower()).strip('_')
                aliases = {'opt_out': 'opted_out', 'optout': 'opted_out', 'unsubscribed': 'opted_out'}
                sval = aliases.get(sval, sval)
                if sval in valid_statuses:
                    rec['status'] = sval
        return rec

    created = 0
    updated = 0
    skipped = 0
    pending_approval = 0
    errors = []
    source_label = f'Import: {csv_file.name}'
    for i, row in enumerate(rows, start=2):
        rec = row_to_record(row)
        email = rec.get('email', '')
        if not email:
            skipped += 1
            continue
        existing = Contact.objects.filter(email=email).first()
        if existing:
            # Opt-out protection: never overwrite or reactivate an opted-out
            # contact — hold the incoming row for approval instead.
            if existing.status == 'opted_out':
                payload = {k: v for k, v in rec.items() if k != 'custom_data'}
                if rec['custom_data']:
                    payload['custom_data'] = rec['custom_data']
                if import_group:
                    payload['import_group_id'] = import_group.id
                    payload['import_group_name'] = import_group.name
                if segment:
                    payload['segment_id'] = segment.id
                    payload['segment_name'] = segment.name
                if not ReactivationRequest.objects.filter(contact=existing, status='pending').exists():
                    ReactivationRequest.objects.create(
                        contact=existing, source=source_label, payload=payload,
                    )
                pending_approval += 1
                continue
            # Existing (non-opted-out) contact: re-tag group/segment and merge
            # any custom-field values; never change their status from an import.
            fields = []
            if import_group:
                existing.import_group = import_group
                fields.append('import_group')
            if segment:
                existing.segment = segment
                fields.append('segment')
            if rec['custom_data']:
                merged = dict(existing.custom_data or {})
                merged.update(rec['custom_data'])
                existing.custom_data = merged
                fields.append('custom_data')
            if fields:
                existing.save(update_fields=fields + ['updated_at'])
            if tags:
                existing.tags.add(*tags)
            if fields or tags:
                updated += 1
            else:
                skipped += 1
            continue
        try:
            new_contact = Contact.objects.create(
                org_name=rec.get('org_name', ''),
                contact_name=rec.get('contact_name', ''),
                email=email,
                phone=rec.get('phone', ''),
                status=rec.get('status', 'active'),
                custom_data=rec['custom_data'],
                import_group=import_group,
                segment=segment,
            )
            if tags:
                new_contact.tags.add(*tags)
            created += 1
        except Exception as e:
            errors.append(f'Row {i}: {e}')

    # Clean up freshly-created group/segment only if nothing landed in them
    if created == 0 and updated == 0:
        if created_segment:
            segment.delete()
            segment = None
        if created_group:
            import_group.delete()
            import_group = None

    return JsonResponse({
        'ok': True,
        'created': created,
        'updated': updated,
        'skipped': skipped,
        'pending_approval': pending_approval,
        'errors': errors[:10],
        'import_group': {'id': import_group.id, 'name': import_group.name} if import_group else None,
        'segment': {'id': segment.id, 'name': segment.name} if segment else None,
    })


# ── Pending approvals / reactivation history ────────────────────────────────

@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def pending_approvals_list(request):
    """Pending reactivation requests (opted-out contacts an import tried to touch)."""
    items = []
    qs = ReactivationRequest.objects.filter(status='pending').select_related('contact')
    for r in qs:
        items.append({
            'id': r.id,
            'contact_id': r.contact_id,
            'email': r.contact.email,
            'org_name': r.contact.org_name,
            'contact_name': r.contact.contact_name,
            'opt_out_reason': r.contact.opt_out_reason,
            'source': r.source,
            'payload': r.payload,
            'created_at': r.created_at.isoformat(),
        })
    return JsonResponse({'ok': True, 'pending': items, 'count': len(items)})


@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def pending_approvals_count(request):
    """Lightweight count for the sidebar badge."""
    return JsonResponse({'ok': True, 'count': ReactivationRequest.objects.filter(status='pending').count()})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def pending_approvals_decide(request):
    """Approve (reactivate + apply the held import row) or keep opted out."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    ids = data.get('ids') or ([data['id']] if data.get('id') else [])
    action = data.get('action')
    if not ids or action not in ('approve', 'keep'):
        return JsonResponse({'error': 'ids and action (approve|keep) are required'}, status=400)

    decided = 0
    for r in ReactivationRequest.objects.filter(id__in=ids, status='pending').select_related('contact'):
        if action == 'approve':
            c = r.contact
            p = r.payload or {}
            for field in ('org_name', 'contact_name', 'phone'):
                if p.get(field):
                    setattr(c, field, p[field])
            if p.get('custom_data'):
                merged = dict(c.custom_data or {})
                merged.update(p['custom_data'])
                c.custom_data = merged
            if p.get('import_group_id'):
                c.import_group = ImportGroup.objects.filter(id=p['import_group_id']).first() or c.import_group
            if p.get('segment_id'):
                seg = Segment.objects.filter(id=p['segment_id']).first()
                if seg:
                    c.segment = seg
                    c.import_group = seg.import_group
            c.status = 'active'
            c.opt_out_reason = ''
            c.save()
            r.status = 'approved'
        else:
            r.status = 'kept_opted_out'
        r.decided_by = request.user
        r.decided_at = timezone.now()
        r.save()
        decided += 1

    return JsonResponse({'ok': True, 'decided': decided})


@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def reactivation_history(request):
    """Decided reactivation requests — who approved/kept-opted-out and when."""
    items = []
    qs = ReactivationRequest.objects.exclude(status='pending').select_related('contact', 'decided_by')[:200]
    for r in qs:
        items.append({
            'id': r.id,
            'email': r.contact.email,
            'org_name': r.contact.org_name,
            'contact_name': r.contact.contact_name,
            'source': r.source,
            'status': r.status,
            'decided_by': r.decided_by.username if r.decided_by else '',
            'decided_at': r.decided_at.isoformat() if r.decided_at else '',
            'created_at': r.created_at.isoformat(),
        })
    return JsonResponse({'ok': True, 'history': items})


# ── Custom fields ───────────────────────────────────────────────────────────

@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def custom_fields_list(request):
    return JsonResponse({'ok': True, 'fields': list(CustomField.objects.values_list('name', flat=True))})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def custom_fields_create(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    name = (data.get('name') or '').strip()
    if not name:
        return JsonResponse({'error': 'Field name is required'}, status=400)
    if len(name) > 100:
        return JsonResponse({'error': 'Field name is too long'}, status=400)
    builtin_keys = {f['key'] for f in BUILTIN_IMPORT_FIELDS} | {'notes', 'status'}
    if re.sub(r'[^a-z0-9]', '_', name.lower()) in builtin_keys:
        return JsonResponse({'error': f'"{name}" is a built-in field'}, status=400)
    field, created = CustomField.objects.get_or_create(name=name)
    return JsonResponse({'ok': True, 'name': field.name, 'created': created})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def custom_fields_delete(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    name = (data.get('name') or '').strip()
    deleted, _ = CustomField.objects.filter(name=name).delete()
    return JsonResponse({'ok': True, 'deleted': bool(deleted)})


@csrf_exempt
@require_http_methods(["GET"])
@require_role('admin', 'editor')
def contacts_export_csv(request):
    """Export all contacts as CSV."""
    response = HttpResponse(content_type='text/csv')
    response['Content-Disposition'] = 'attachment; filename="contacts.csv"'

    custom_names = list(CustomField.objects.values_list('name', flat=True))
    writer = csv.writer(response)
    writer.writerow(['org_name', 'contact_name', 'email', 'phone', 'status', 'opt_out_reason', 'last_touchpoint', 'notes'] + custom_names)
    for c in Contact.objects.all():
        cd = c.custom_data or {}
        writer.writerow(
            [c.org_name, c.contact_name, c.email, c.phone, c.status, c.opt_out_reason, c.last_touchpoint, c.notes]
            + [cd.get(n, '') for n in custom_names]
        )

    return response


# ── Bulk send / progress views ──────────────────────────────────────────────

def _run_bulk_send(job_id):
    """Background thread: sends emails for a SendJob."""
    try:
        job = SendJob.objects.get(id=job_id)
        tpl = job.touchpoint
    except SendJob.DoesNotExist:
        return

    if tpl is None:
        # The touchpoint was deleted before the job could run.
        job.status = 'cancelled'
        job.completed_at = timezone.now()
        job.save()
        return

    job.status = 'running'
    job.save()

    # Content comes from the chosen reusable template when present, else the touchpoint.
    # Attachment + signature image always come from the touchpoint (per-touchpoint files).
    lib = job.template
    src_subject = lib.subject if lib else tpl.subject
    src_body_html = lib.body_html if lib else tpl.body_html
    src_body = lib.body if lib else tpl.body
    src_signature = lib.signature if lib else tpl.signature
    src_opt_out_text = (lib.opt_out_text if lib else tpl.opt_out_text) or DEFAULT_OPT_OUT_TEXT

    # Prepare email content — always HTML so links (opt-out) are clickable
    if src_body_html:
        body_content = src_body_html
        # Library templates carry a dedicated signature field — append it.
        if lib and src_signature:
            body_content += f'<div style="margin-top:12px;white-space:pre-wrap">{src_signature}</div>'
    else:
        body_content = _text_to_html(src_body)
        if src_signature:
            body_content += f'<div style="margin-top:12px;white-space:pre-wrap">{escape(src_signature)}</div>'
    content_type = 'HTML'

    # Signature image + attachment come from the chosen template when present, else the touchpoint.
    src_signature_image = lib.signature_image if lib else tpl.signature_image
    src_attachment = lib.attachment if lib else tpl.attachment

    # Inline signature image
    sig_inline = None
    if content_type == 'HTML' and src_signature_image:
        try:
            sig_path = src_signature_image.path
            sig_name = os.path.basename(sig_path)
            ext = os.path.splitext(sig_name)[1].lower().lstrip('.') or 'png'
            cid = f'signature_tpl{lib.id}' if lib else f'signature_tp{tpl.touchpoint_number}'

            has_drive_url = bool(re.search(r'https://drive\.google\.com/thumbnail\?id=', body_content, flags=re.IGNORECASE))
            has_cid_ref = bool(re.search(r'cid:signature_tp\d+', body_content, flags=re.IGNORECASE))

            if has_drive_url:
                body_content = re.sub(
                    r'https://drive\.google\.com/thumbnail\?id=[^"\'&]+(?:&amp;[^"\']*|&[^"\']*)*',
                    f'cid:{cid}', body_content, flags=re.IGNORECASE,
                )
            elif not has_cid_ref:
                body_content += f'<div style="margin-top:16px"><img src="cid:{cid}" alt="Signature" style="{_signature_img_style(tpl.signature_image_height, tpl.signature_image_width)}" /></div>'

            with open(sig_path, 'rb') as sf:
                sig_inline = {
                    'name': sig_name,
                    'contentType': f'image/{"jpeg" if ext == "jpg" else ext}',
                    'contentBytes': base64.b64encode(sf.read()).decode('utf-8'),
                    'contentId': cid,
                    'isInline': True,
                }
        except Exception:
            pass

    # Build attachment list
    attachments = []
    if src_attachment:
        try:
            att_path = src_attachment.path
            with open(att_path, 'rb') as f:
                att_bytes = f.read()
            raw_name = os.path.basename(att_path)
            name_part, ext = os.path.splitext(raw_name)
            att_name = name_part.replace('_', ' ').replace('-', ' ')
            att_name = ' '.join(att_name.split()) + ext
            attachments.append({
                'name': att_name,
                'contentBytes': base64.b64encode(att_bytes).decode('utf-8'),
            })
        except Exception:
            pass
    if sig_inline:
        attachments.append(sig_inline)

    logs = list(job.logs.filter(status='pending').select_related('contact'))

    for log in logs:
        # Check if job was cancelled (always read fresh from DB)
        if SendJob.objects.filter(id=job.id, status='cancelled').exists():
            break

        # Re-check this log's status (cancel may have already marked it skipped)
        log.refresh_from_db()
        if log.status != 'pending':
            continue

        contact = log.contact
        contact.refresh_from_db(fields=['status', 'last_touchpoint'])
        if contact.status != 'active':
            log.status = 'skipped'
            log.error = f'Contact status: {contact.status}'
            log.save()
            SendJob.objects.filter(id=job.id).update(skipped_count=F('skipped_count') + 1)
            continue
        # Sequencing guard: only send TP N to contacts currently at TP N-1
        # (a previous touchpoint must be done; otherwise skip).
        if contact.last_touchpoint != tpl.touchpoint_number - 1:
            log.status = 'skipped'
            log.error = f'Skipped: at TP{contact.last_touchpoint}, needs TP{tpl.touchpoint_number - 1} first'
            log.save()
            SendJob.objects.filter(id=job.id).update(skipped_count=F('skipped_count') + 1)
            continue

        # Pre-send validation: check domain has MX records (skipped in console mode)
        if not _console_email_mode() and not _domain_has_mx(contact.email):
            log.status = 'failed'
            log.error = f'Invalid domain: no MX records for {contact.email.split("@")[-1]}'
            log.sent_at = timezone.now()
            log.save()
            SendJob.objects.filter(id=job.id).update(failed_count=F('failed_count') + 1)
            contact.status = 'undeliverable'
            contact.save()
            print(f'[BULK-SEND] Skipped {contact.email}: no MX records', flush=True)
            continue

        # Pre-send validation: check SES suppression list (skipped in console mode)
        try:
            if _console_email_mode():
                raise ClientError({'Error': {'Code': 'NotFoundException', 'Message': 'console mode'}}, 'GetSuppressedDestination')
            ses_v2 = _get_ses_v2_client()
            resp = ses_v2.get_suppressed_destination(EmailAddress=contact.email)
            reason = resp['SuppressedDestination']['Reason']
            log.status = 'failed'
            log.error = f'Email on SES suppression list: {reason}'
            log.sent_at = timezone.now()
            log.save()
            SendJob.objects.filter(id=job.id).update(failed_count=F('failed_count') + 1)
            contact.status = 'bounced' if reason == 'BOUNCE' else 'opted_out'
            contact.save()
            print(f'[BULK-SEND] Skipped {contact.email}: on suppression list ({reason})', flush=True)
            continue
        except ClientError as e:
            if e.response['Error']['Code'] == 'NotFoundException':
                pass  # Not suppressed, proceed with sending
            else:
                print(f'[BULK-SEND] Suppression check error for {contact.email}: {e}', flush=True)
        except Exception as e:
            print(f'[BULK-SEND] Suppression check error for {contact.email}: {e}', flush=True)

        # Substitute variables per contact
        subj = src_subject
        final_body = body_content
        var_map = {
            '{{org_name}}': contact.org_name,
            '{{contact_name}}': contact.contact_name,
            '{{email}}': contact.email,
            '{{phone}}': contact.phone,
            '{{touchpoint_number}}': str(tpl.touchpoint_number),
        }
        for var, val in var_map.items():
            subj = subj.replace(var, val)
            final_body = final_body.replace(var, val)

        # Per-recipient opt-out (unsubscribe) link — required for compliance.
        final_body = _apply_opt_out(final_body, src_opt_out_text, contact.id, is_html=(content_type == 'HTML'))

        body_html = final_body if content_type == 'HTML' else None
        body_text = final_body if content_type == 'Text' else None

        sent_ok, msg_id = _ses_send_mail(
            to_address=contact.email,
            subject=subj,
            body_html=body_html,
            body_text=body_text,
            attachments=attachments if attachments else None,
        )

        log.sent_at = timezone.now()
        if sent_ok:
            log.status = 'sent'
            log.message_id = msg_id
            SendJob.objects.filter(id=job.id).update(sent_count=F('sent_count') + 1)
            contact.last_touchpoint = tpl.touchpoint_number
            contact.last_campaign_id = tpl.campaign_id
            contact.save()
        else:
            log.status = 'failed'
            log.error = msg_id
            SendJob.objects.filter(id=job.id).update(failed_count=F('failed_count') + 1)
            if 'MessageRejected' in str(msg_id) or 'bounce' in str(msg_id).lower():
                contact.status = 'undeliverable'
                contact.save()
        log.save()

        # Rate limit: ~10 emails/sec
        time.sleep(0.1)

    # Atomically set final status only if not already cancelled
    updated = SendJob.objects.filter(id=job.id).exclude(status='cancelled').update(
        status='completed', completed_at=timezone.now()
    )
    job.refresh_from_db()
    print(f'[BULK-SEND] Job #{job.id} finished: status={job.status}, sent={job.sent_count}, failed={job.failed_count}, skipped={job.skipped_count}', flush=True)

    # Schedule bounce check after a delay to give SES time to process bounces
    def _delayed_bounce_check():
        time.sleep(30)  # Wait 30 seconds for SES to process bounces
        print(f'[BULK-SEND] Running bounce check for job #{job_id}...', flush=True)
        _check_bounces_for_job(job_id)

    bounce_thread = threading.Thread(target=_delayed_bounce_check, daemon=True)
    bounce_thread.start()


def _create_and_start_job(tpl, library_tpl, data, user, send_limit):
    """Create a SendJob for the eligible contacts and start the send thread.
    Returns (job, total_eligible, batch_size); job is None when nobody is eligible."""
    contacts = _eligible_contacts_for_send(tpl.touchpoint_number, data, campaign=tpl.campaign)
    contacts = contacts.order_by('id')  # deterministic ordering so "next N" is consistent
    total_eligible = contacts.count()
    if total_eligible == 0:
        return None, 0, 0

    contact_list = list(contacts[:send_limit] if send_limit > 0 else contacts)

    # Remember who this run targeted, for the history cards ("to …")
    target_parts = []
    group_id = data.get('import_group_id')
    if group_id:
        g = ImportGroup.objects.filter(id=group_id).first()
        if g:
            target_parts.append(g.name)
    seg_ids = data.get('segment_ids') or ([data.get('segment_id')] if data.get('segment_id') else [])
    seg_names = list(Segment.objects.filter(id__in=[s for s in seg_ids if s]).values_list('name', flat=True))
    target_parts.extend(seg_names)
    target_summary = ' · '.join(target_parts) if target_parts else 'all contacts'

    job = SendJob.objects.create(
        touchpoint=tpl,
        template=library_tpl,
        total_recipients=len(contact_list),
        target_summary=target_summary[:300],
        started_by=user,
    )
    SendLog.objects.bulk_create([SendLog(job=job, contact=c) for c in contact_list])
    threading.Thread(target=_run_bulk_send, args=(job.id,), daemon=True).start()
    return job, total_eligible, len(contact_list)


# ── Scheduled sends ('Coming up' cards) ─────────────────────────────────────

def _run_scheduled_send(ss_id):
    """Start the send for a claimed ScheduledSend (status already set to 'sent')."""
    ss = ScheduledSend.objects.select_related('touchpoint', 'template', 'created_by').filter(id=ss_id).first()
    if not ss:
        return
    data = {
        'import_group_id': ss.import_group_id,
        'segment_id': ss.segment_id,
    }
    job, total_eligible, batch = _create_and_start_job(ss.touchpoint, ss.template, data, ss.created_by, ss.limit)
    if job:
        ScheduledSend.objects.filter(id=ss_id).update(send_job=job)
    print(f'[SCHEDULE] Scheduled send #{ss_id} ran: eligible={total_eligible}, batch={batch}, job={job.id if job else None}', flush=True)


def _process_due_scheduled_sends():
    """Run any scheduled sends whose time has arrived. Called opportunistically
    from the schedule/progress endpoints (no separate queue worker needed)."""
    now = timezone.now()
    due_ids = list(
        ScheduledSend.objects.filter(status='scheduled', scheduled_for__lte=now).values_list('id', flat=True)
    )
    for ss_id in due_ids:
        # Atomic claim so concurrent polls can't double-send the batch
        claimed = ScheduledSend.objects.filter(id=ss_id, status='scheduled').update(status='sent')
        if claimed:
            try:
                _run_scheduled_send(ss_id)
            except Exception as e:
                print(f'[SCHEDULE] Failed to run scheduled send #{ss_id}: {e}', flush=True)


def _scheduled_send_dict(ss):
    return {
        'id': ss.id,
        'batch_key': ss.batch_key,
        'campaign_id': ss.touchpoint.campaign_id,
        'campaign_name': ss.touchpoint.campaign.name if ss.touchpoint.campaign else '',
        'subject': ss.touchpoint.subject,
        'touchpoint_number': ss.touchpoint.touchpoint_number,
        'scheduled_for': ss.scheduled_for.isoformat(),
        'status': ss.status,
        'limit': ss.limit,
        'template_id': ss.template_id,
        'template_name': ss.template.name if ss.template else '',
        'import_group_id': ss.import_group_id,
        'import_group_name': ss.import_group.name if ss.import_group else '',
        'segment_id': ss.segment_id,
        'segment_name': ss.segment.name if ss.segment else '',
        'created_by': ss.created_by.username if ss.created_by else '',
        'created_at': ss.created_at.isoformat(),
        'job_id': ss.send_job_id,
        'job': {
            'sent': ss.send_job.sent_count,
            'failed': ss.send_job.failed_count,
            'skipped': ss.send_job.skipped_count,
            'total': ss.send_job.total_recipients,
            'status': ss.send_job.status,
        } if ss.send_job else None,
    }


@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def schedules_list(request):
    """The Schedule page: one 'Coming up' card per scheduled batch (its emails
    listed inside) + the 8 most recent past runs."""
    _process_due_scheduled_sends()
    base = ScheduledSend.objects.select_related(
        'touchpoint', 'touchpoint__campaign', 'template', 'import_group', 'segment', 'created_by', 'send_job',
    )

    # Group coming-up rows into batches (rows scheduled together share a key).
    batches = {}
    order = []
    for ss in base.filter(status='scheduled').order_by('scheduled_for'):
        key = ss.batch_key or f'single-{ss.id}'
        if key not in batches:
            campaign = ss.touchpoint.campaign
            target = ss.segment.name if ss.segment else (ss.import_group.name if ss.import_group else 'All contacts')
            batches[key] = {
                'batch_key': ss.batch_key,
                'id': ss.id,  # fallback for pre-batch rows
                'campaign_id': campaign.id if campaign else None,
                'campaign_name': campaign.name if campaign else 'Campaign',
                'starts_at': ss.scheduled_for.isoformat(),
                'target': target,
                'import_group_id': ss.import_group_id,
                'segment_id': ss.segment_id,
                'limit': ss.limit,
                'created_by': ss.created_by.username if ss.created_by else '',
                'emails': [],
            }
            order.append(key)
        batches[key]['emails'].append({
            'touchpoint_number': ss.touchpoint.touchpoint_number,
            'subject': ss.touchpoint.subject,
            'scheduled_for': ss.scheduled_for.isoformat(),
            'status': 'sending' if (ss.send_job and ss.send_job.status in ('pending', 'running')) else 'scheduled',
        })
    coming_up = [batches[k] for k in order]

    past = [_scheduled_send_dict(s) for s in base.exclude(status='scheduled').order_by('-updated_at')[:8]]
    return JsonResponse({'ok': True, 'coming_up': coming_up, 'already_went_out': past})


def _parse_schedule_fields(data):
    """Shared field parsing for schedule create/update. Returns (fields, error)."""
    from django.utils.dateparse import parse_datetime
    fields = {}
    when_raw = (data.get('scheduled_for') or '').strip()
    if when_raw:
        when = parse_datetime(when_raw)
        if not when:
            return None, 'Invalid scheduled_for datetime'
        if timezone.is_naive(when):
            when = timezone.make_aware(when, timezone.get_current_timezone())
        fields['scheduled_for'] = when
    if 'limit' in data:
        try:
            fields['limit'] = max(0, int(data.get('limit') or 0))
        except (TypeError, ValueError):
            return None, 'limit must be a number'
    if 'template_id' in data:
        tid = data.get('template_id')
        fields['template'] = EmailTemplate.objects.filter(id=tid).first() if tid else None
    if 'import_group_id' in data:
        gid = data.get('import_group_id')
        fields['import_group'] = ImportGroup.objects.filter(id=gid).first() if gid else None
    if 'segment_id' in data:
        sid = data.get('segment_id')
        seg = Segment.objects.filter(id=sid).first() if sid else None
        fields['segment'] = seg
        if seg:
            fields['import_group'] = seg.import_group
    return fields, None


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def schedules_schedule_campaign(request):
    """Beacon's 'Schedule a campaign': the whole flow — touchpoint 1 at the
    launch time, each next touchpoint after its own wait. Empty touchpoints
    are skipped. 'Run now' launches touchpoint 1 immediately."""
    import uuid
    from django.utils.dateparse import parse_datetime
    from datetime import timedelta as td

    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    campaign = Campaign.objects.filter(id=data.get('campaign_id')).first() if data.get('campaign_id') else _resolve_campaign(None)
    if not campaign:
        return JsonResponse({'error': 'Pick a campaign first'}, status=400)

    steps = [
        t for t in campaign.touchpoints.filter(is_goodbye=False).order_by('touchpoint_number')
        if (t.subject or t.body or t.body_html)
    ]
    skipped = campaign.touchpoints.filter(is_goodbye=False).count() - len(steps)
    if not steps:
        return JsonResponse({'error': 'None of the touchpoints have content yet — add a subject first.'}, status=400)

    run_now = (data.get('when') or 'now') != 'later'
    if run_now:
        launch = timezone.now()
    else:
        launch = parse_datetime((data.get('start_at') or '').strip())
        if not launch:
            return JsonResponse({'error': 'Pick the launch date'}, status=400)
        if timezone.is_naive(launch):
            launch = timezone.make_aware(launch, timezone.get_current_timezone())

    group = ImportGroup.objects.filter(id=data.get('import_group_id')).first() if data.get('import_group_id') else None
    segment = Segment.objects.filter(id=data.get('segment_id')).first() if data.get('segment_id') else None
    # Callers that don't pick an audience (e.g. the flow board's Schedule
    # button) fall back to the campaign's default segment.
    if segment is None and 'segment_id' not in data and campaign.segment_id:
        segment = campaign.segment
    if segment:
        group = segment.import_group

    batch_key = uuid.uuid4().hex
    rows = []
    prev_when = launch
    for i, step in enumerate(steps):
        when = launch if i == 0 else prev_when + td(minutes=step.wait_in_minutes())
        if step.scheduled_date:
            # A pinned calendar date overrides the relative wait
            when = when.replace(year=step.scheduled_date.year, month=step.scheduled_date.month, day=step.scheduled_date.day)
        if step.send_time:
            # The time pins the clock — e.g. wait 1 week and 3 days, then at 9:00 AM
            when = when.replace(hour=step.send_time.hour, minute=step.send_time.minute, second=0)
        prev_when = when
        rows.append(ScheduledSend.objects.create(
            touchpoint=step,
            import_group=group,
            segment=segment,
            limit=max(0, int(data.get('limit') or 0)),
            scheduled_for=when,
            batch_key=batch_key,
            created_by=request.user,
        ))

    if run_now:
        first = rows[0]
        # A first step pinned to a future date stays scheduled instead of firing now
        claimed = 0
        if first.scheduled_for <= timezone.now():
            claimed = ScheduledSend.objects.filter(id=first.id, status='scheduled').update(status='sent')
        if claimed:
            try:
                _run_scheduled_send(first.id)
            except Exception as e:
                print(f'[SCHEDULE] Run-now launch failed for batch {batch_key}: {e}', flush=True)

    return JsonResponse({
        'ok': True,
        'batch_key': batch_key,
        'scheduled': len(rows),
        'skipped': skipped,
        'ran_now': run_now,
    })


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def schedules_batch_run_now(request):
    """Run a coming-up batch now: the flow starts immediately, waits preserved."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    rows = list(ScheduledSend.objects.filter(batch_key=data.get('batch_key'), status='scheduled').order_by('scheduled_for'))
    if not rows:
        return JsonResponse({'error': 'Nothing left to run in this batch'}, status=404)
    delta = timezone.now() - rows[0].scheduled_for
    for r in rows:
        ScheduledSend.objects.filter(id=r.id).update(scheduled_for=r.scheduled_for + delta)
    _process_due_scheduled_sends()
    return JsonResponse({'ok': True})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def schedules_batch_edit(request):
    """Edit a coming-up batch: shift the launch (waits preserved) and retarget."""
    from django.utils.dateparse import parse_datetime
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    rows = list(ScheduledSend.objects.filter(batch_key=data.get('batch_key'), status='scheduled').order_by('scheduled_for'))
    if not rows:
        return JsonResponse({'error': 'Batch not found (it may have already run)'}, status=404)

    if (data.get('start_at') or '').strip():
        start = parse_datetime(data['start_at'].strip())
        if not start:
            return JsonResponse({'error': 'Invalid launch date'}, status=400)
        if timezone.is_naive(start):
            start = timezone.make_aware(start, timezone.get_current_timezone())
        delta = start - rows[0].scheduled_for
        for r in rows:
            ScheduledSend.objects.filter(id=r.id).update(scheduled_for=r.scheduled_for + delta)

    updates = {}
    if 'import_group_id' in data:
        gid = data.get('import_group_id')
        updates['import_group'] = ImportGroup.objects.filter(id=gid).first() if gid else None
    if 'segment_id' in data:
        sid = data.get('segment_id')
        seg = Segment.objects.filter(id=sid).first() if sid else None
        updates['segment'] = seg
        if seg:
            updates['import_group'] = seg.import_group
    if updates:
        ScheduledSend.objects.filter(id__in=[r.id for r in rows]).update(
            **{k: v for k, v in updates.items()}
        )
    return JsonResponse({'ok': True})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def schedules_batch_cancel(request):
    """Turn off & cancel every remaining send in a coming-up batch."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    updated = ScheduledSend.objects.filter(batch_key=data.get('batch_key'), status='scheduled').update(status='cancelled')
    if not updated:
        return JsonResponse({'error': 'Batch not found (it may have already run)'}, status=404)
    return JsonResponse({'ok': True, 'cancelled': updated})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def schedules_create(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    tp_num = data.get('touchpoint_number')
    if not tp_num:
        return JsonResponse({'error': 'touchpoint_number required'}, status=400)
    campaign = _resolve_campaign(data.get('campaign_id'))
    tpl = TouchpointTemplate.objects.filter(touchpoint_number=tp_num, is_goodbye=False, campaign=campaign).first()
    if not tpl:
        return JsonResponse({'error': 'Touchpoint not found. Save its content first.'}, status=404)

    fields, err = _parse_schedule_fields(data)
    if err:
        return JsonResponse({'error': err}, status=400)
    if 'scheduled_for' not in fields:
        return JsonResponse({'error': 'scheduled_for is required'}, status=400)
    if fields['scheduled_for'] <= timezone.now():
        return JsonResponse({'error': 'The scheduled time is in the past. Use "Send now" for an immediate run.'}, status=400)

    import uuid
    ss = ScheduledSend.objects.create(touchpoint=tpl, created_by=request.user, batch_key=uuid.uuid4().hex, **fields)
    return JsonResponse({'ok': True, 'id': ss.id})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def schedules_update(request):
    """Edit a coming-up schedule — replaces the batch settings."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    ss = ScheduledSend.objects.filter(id=data.get('id'), status='scheduled').first()
    if not ss:
        return JsonResponse({'error': 'Scheduled send not found (it may have already run)'}, status=404)

    fields, err = _parse_schedule_fields(data)
    if err:
        return JsonResponse({'error': err}, status=400)
    for k, v in fields.items():
        setattr(ss, k, v)
    ss.save()
    return JsonResponse({'ok': True})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def schedules_cancel(request):
    """Turn off & cancel a coming-up schedule."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    updated = ScheduledSend.objects.filter(id=data.get('id'), status='scheduled').update(status='cancelled')
    if not updated:
        return JsonResponse({'error': 'Scheduled send not found (it may have already run)'}, status=404)
    return JsonResponse({'ok': True})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def schedules_run_now(request):
    """Run a coming-up schedule immediately (no timezone maths — now means now)."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)
    ss_id = data.get('id')
    claimed = ScheduledSend.objects.filter(id=ss_id, status='scheduled').update(status='sent')
    if not claimed:
        return JsonResponse({'error': 'Scheduled send not found (it may have already run)'}, status=404)
    try:
        _run_scheduled_send(ss_id)
    except Exception as e:
        return JsonResponse({'error': f'Failed to start: {e}'}, status=500)
    ss = ScheduledSend.objects.filter(id=ss_id).first()
    return JsonResponse({'ok': True, 'job_id': ss.send_job_id if ss else None})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def send_bulk_start(request):
    """Start a bulk send for a touchpoint to all active contacts."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    tp_num = data.get('touchpoint_number')
    if not tp_num:
        return JsonResponse({'error': 'touchpoint_number required'}, status=400)

    campaign = _resolve_campaign(data.get('campaign_id'))
    tpl = TouchpointTemplate.objects.filter(touchpoint_number=tp_num, campaign=campaign, is_goodbye=False).first()
    if not tpl:
        return JsonResponse({'error': 'Template not found. Save it first.'}, status=404)

    # Optional reusable template — its content overrides the touchpoint's for this send.
    library_tpl = None
    template_id = data.get('template_id')
    if template_id:
        library_tpl = EmailTemplate.objects.filter(id=template_id).first()
        if not library_tpl:
            return JsonResponse({'error': 'Selected template not found.'}, status=404)

    # The content source is the library template when chosen, else the touchpoint.
    content_subject = library_tpl.subject if library_tpl else tpl.subject
    if not content_subject:
        return JsonResponse({'error': 'The selected content has no subject line.'}, status=400)

    # Sequencing rule: a contact may only receive touchpoint N once they've received N-1.
    # (So TP1 -> contacts at TP0, TP2 -> contacts at TP1, etc. Anyone missing the prior
    #  touchpoint is simply not eligible and gets skipped.)
    # Per-send cap for AWS-friendly batching. Falls back to the template's daily limit.
    send_limit = data.get('limit')
    try:
        send_limit = int(send_limit)
    except (TypeError, ValueError):
        send_limit = 0
    if send_limit <= 0 and tpl.daily_send_limit > 0:
        send_limit = tpl.daily_send_limit

    job, total_eligible, batch_size = _create_and_start_job(tpl, library_tpl, data, request.user, send_limit)
    if job is None:
        return JsonResponse({'error': f'No contacts are eligible for Touchpoint {tp_num} (they must have received Touchpoint {tp_num - 1} first).'}, status=400)
    capped = send_limit > 0 and total_eligible > batch_size
    remaining = total_eligible - batch_size
    msg = f'Sending started — {batch_size} of {total_eligible} eligible'
    if capped:
        msg += f' (capped, {remaining} left for next batch)'

    return JsonResponse({
        'ok': True,
        'job_id': job.id,
        'total_recipients': batch_size,
        'total_eligible': total_eligible,
        'remaining': remaining,
        'limit_applied': capped,
        'message': msg,
    })


def _eligible_contacts_for_send(tp_num, data, campaign=None):
    """Contacts eligible to receive touchpoint `tp_num` — active and currently at
    TP(N-1) on this campaign's journey (TP1 starts anyone not mid-journey),
    optionally narrowed by import group and/or segment(s)."""
    qs = Contact.objects.filter(status='active', last_touchpoint=int(tp_num) - 1)
    if campaign is not None and int(tp_num) > 1:
        qs = qs.filter(last_campaign=campaign)
    group_id = data.get('import_group_id')
    if group_id:
        qs = qs.filter(import_group_id=group_id)
    segment_ids = data.get('segment_ids')
    if not segment_ids and data.get('segment_id'):
        segment_ids = [data['segment_id']]
    if segment_ids:
        qs = qs.filter(segment_id__in=segment_ids)
    return qs


@csrf_exempt
@require_http_methods(["GET"])
@require_role('admin', 'editor')
def send_eligible_count(request):
    """How many contacts are eligible to receive a touchpoint right now (for the Send dialog)."""
    tp_num = request.GET.get('touchpoint_number')
    if not tp_num:
        return JsonResponse({'error': 'touchpoint_number required'}, status=400)
    data = {
        'import_group_id': request.GET.get('import_group_id') or None,
        'segment_id': request.GET.get('segment_id') or None,
    }
    campaign = _resolve_campaign(request.GET.get('campaign_id'))
    eligible = _eligible_contacts_for_send(int(tp_num), data, campaign=campaign).count()
    return JsonResponse({'ok': True, 'touchpoint_number': int(tp_num), 'eligible': eligible})


def _categorize_bounce(error_text):
    """Categorize a send failure into (kind, reason) where kind is 'hard'|'soft'|'other'."""
    e = (error_text or '').lower()
    if 'no mx records' in e or 'invalid domain' in e:
        return 'hard', 'Invalid domain (no MX records)'
    if 'suppression list' in e:
        return 'hard', 'On SES suppression list'
    if 'does not exist' in e or 'invalidrecipient' in e or 'user unknown' in e or '550' in e or 'no such user' in e:
        return 'hard', 'Mailbox does not exist'
    if 'messagerejected' in e or 'rejected' in e:
        return 'hard', 'Rejected by the mail server'
    if 'mailbox full' in e or 'quota' in e or 'over quota' in e:
        return 'soft', 'Mailbox full'
    if 'throttl' in e or 'timeout' in e or 'timed out' in e or 'temporar' in e or 'try again' in e or 'greylist' in e:
        return 'soft', 'Temporary failure'
    if 'spam' in e or 'blocked' in e or 'blacklist' in e or 'policy' in e:
        return 'soft', 'Blocked by spam policy'
    return 'other', (error_text or 'Unknown reason')[:80] or 'Unknown reason'


def _grade(value, bands):
    """bands: [(threshold, grade)] evaluated in order; value >= threshold wins."""
    for threshold, grade in bands:
        if value >= threshold:
            return grade
    return bands[-1][1]


@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def reporting_touchpoint(request):
    """Dedicated per-touchpoint (campaign) report: jobs, totals, failure reasons."""
    from django.db.models import Sum, Count
    try:
        tp_num = int(request.GET.get('n', ''))
    except ValueError:
        return JsonResponse({'error': 'n (touchpoint number) required'}, status=400)

    jobs = SendJob.objects.filter(touchpoint__touchpoint_number=tp_num, is_test=False)
    agg = jobs.aggregate(
        sent=Sum('sent_count'), failed=Sum('failed_count'),
        skipped=Sum('skipped_count'), recipients=Sum('total_recipients'), n=Count('id'),
    )
    sent = agg['sent'] or 0
    failed = agg['failed'] or 0
    attempted = sent + failed
    job_rows = [{
        'id': j.id,
        'status': j.status,
        'total_recipients': j.total_recipients,
        'sent_count': j.sent_count,
        'failed_count': j.failed_count,
        'skipped_count': j.skipped_count,
        'started_by': j.started_by.username if j.started_by else '',
        'created_at': j.created_at.isoformat(),
    } for j in jobs.select_related('started_by').order_by('-created_at')[:20]]

    reasons = {}
    for err in SendLog.objects.filter(job__in=jobs, status='failed').values_list('error', flat=True)[:5000]:
        kind, reason = _categorize_bounce(err)
        key = (kind, reason)
        reasons[key] = reasons.get(key, 0) + 1
    reason_rows = [
        {'kind': k, 'reason': r, 'count': c}
        for (k, r), c in sorted(reasons.items(), key=lambda kv: -kv[1])
    ]

    return JsonResponse({
        'ok': True,
        'touchpoint_number': tp_num,
        'totals': {
            'jobs': agg['n'] or 0,
            'sent': sent,
            'failed': failed,
            'skipped': agg['skipped'] or 0,
            'recipients': agg['recipients'] or 0,
            'delivery_rate': round(sent / attempted * 100, 1) if attempted else 0,
        },
        'jobs': job_rows,
        'failure_reasons': reason_rows,
    })


@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def reporting_stats(request):
    """Aggregate reporting stats for the dashboard."""
    from django.db.models import Count, Q, Sum
    from collections import defaultdict
    from datetime import timedelta, datetime

    # Parse optional filters
    filter_group = request.GET.get('import_group')  # import group id
    filter_tp = request.GET.get('touchpoint')       # touchpoint number
    filter_from = request.GET.get('date_from')      # YYYY-MM-DD
    filter_to = request.GET.get('date_to')          # YYYY-MM-DD
    filter_campaign = request.GET.get('campaign_id')  # scope sends to one campaign
    filter_segment = request.GET.get('segment_id')  # scope to one segment's contacts
    filter_tag = request.GET.get('tag_id')          # scope to contacts carrying a tag

    # Build base querysets with filters applied
    job_qs = SendJob.objects.all()
    log_qs = SendLog.objects.all()
    contact_qs = Contact.objects.all()

    if filter_campaign:
        try:
            job_qs = job_qs.filter(touchpoint__campaign_id=int(filter_campaign))
            log_qs = log_qs.filter(job__touchpoint__campaign_id=int(filter_campaign))
        except (TypeError, ValueError):
            pass

    if filter_tp:
        job_qs = job_qs.filter(touchpoint__touchpoint_number=int(filter_tp))
        log_qs = log_qs.filter(job__touchpoint__touchpoint_number=int(filter_tp))

    if filter_group:
        log_qs = log_qs.filter(contact__import_group_id=int(filter_group))
        contact_qs = contact_qs.filter(import_group_id=int(filter_group))
        # For jobs, filter to those that have logs matching the group
        job_ids = log_qs.values_list('job_id', flat=True).distinct()
        job_qs = job_qs.filter(id__in=job_ids)

    if filter_segment:
        try:
            log_qs = log_qs.filter(contact__segment_id=int(filter_segment))
            contact_qs = contact_qs.filter(segment_id=int(filter_segment))
            job_qs = job_qs.filter(id__in=log_qs.values_list('job_id', flat=True).distinct())
        except (TypeError, ValueError):
            pass

    if filter_tag:
        try:
            log_qs = log_qs.filter(contact__tags__id=int(filter_tag))
            contact_qs = contact_qs.filter(tags__id=int(filter_tag))
            job_qs = job_qs.filter(id__in=log_qs.values_list('job_id', flat=True).distinct())
        except (TypeError, ValueError):
            pass

    if filter_from:
        d = datetime.strptime(filter_from, '%Y-%m-%d').date()
        job_qs = job_qs.filter(created_at__date__gte=d)
        log_qs = log_qs.filter(sent_at__date__gte=d)

    if filter_to:
        d = datetime.strptime(filter_to, '%Y-%m-%d').date()
        job_qs = job_qs.filter(created_at__date__lte=d)
        log_qs = log_qs.filter(sent_at__date__lte=d)

    # When filtering by contact scope or date, compute totals from SendLog instead of SendJob aggregates
    if filter_group or filter_segment or filter_tag or filter_from or filter_to:
        total_jobs = job_qs.count()
        total_sent = log_qs.filter(status='sent').count()
        total_failed = log_qs.filter(status='failed').count()
        total_skipped = log_qs.filter(status='skipped').count()
        total_recipients = total_sent + total_failed + total_skipped
    else:
        total_jobs = job_qs.count()
        total_sent = job_qs.aggregate(s=Sum('sent_count'))['s'] or 0
        total_failed = job_qs.aggregate(s=Sum('failed_count'))['s'] or 0
        total_skipped = job_qs.aggregate(s=Sum('skipped_count'))['s'] or 0
        total_recipients = job_qs.aggregate(s=Sum('total_recipients'))['s'] or 0

    # Contact breakdown
    contact_stats = contact_qs.aggregate(
        total=Count('id'),
        active=Count('id', filter=Q(status='active')),
        inactive=Count('id', filter=Q(status='inactive')),
        bounced=Count('id', filter=Q(status='bounced')),
        opted_out=Count('id', filter=Q(status='opted_out')),
        undeliverable=Count('id', filter=Q(status__in=['undeliverable', 'bounced'])),
        moved_to_hubspot=Count('id', filter=Q(status='moved_to_hubspot')),
    )

    # Per-touchpoint stats — over the touchpoint numbers that actually have sends
    # (journeys can hold any number of touchpoints, like Beacon)
    tp_numbers = sorted(
        n for n in set(
            job_qs.filter(is_test=False).values_list('touchpoint__touchpoint_number', flat=True)
        ) if n is not None and n < TouchpointTemplate.GOODBYE_OFFSET
    )
    tp_stats = []
    for tp_num in tp_numbers:
        tp_jobs = job_qs.filter(touchpoint__touchpoint_number=tp_num, is_test=False)
        if filter_group or filter_from or filter_to:
            tp_logs = log_qs.filter(job__touchpoint__touchpoint_number=tp_num, job__is_test=False)
            sent = tp_logs.filter(status='sent').count()
            failed = tp_logs.filter(status='failed').count()
            skipped = tp_logs.filter(status='skipped').count()
            recipients = sent + failed + skipped
            job_count = tp_jobs.filter(is_test=False).count()
            if job_count == 0 and recipients == 0:
                continue
        else:
            if not tp_jobs.exists():
                continue
            agg = tp_jobs.aggregate(
                total_jobs=Count('id'),
                sent=Sum('sent_count'),
                failed=Sum('failed_count'),
                skipped=Sum('skipped_count'),
                recipients=Sum('total_recipients'),
            )
            sent = agg['sent'] or 0
            failed = agg['failed'] or 0
            skipped = agg['skipped'] or 0
            recipients = agg['recipients'] or 0
            job_count = agg['total_jobs'] or 0

        total = sent + failed
        delivery_rate = round((sent / total * 100), 1) if total > 0 else 0

        last_job = tp_jobs.order_by('-created_at').first()
        tp_stats.append({
            'touchpoint_number': tp_num,
            'total_jobs': job_count,
            'sent': sent,
            'failed': failed,
            'skipped': skipped,
            'recipients': recipients,
            'delivery_rate': delivery_rate,
            'last_sent': last_job.created_at.isoformat() if last_job else None,
            'last_status': last_job.status if last_job else None,
        })

    # Recent activity (last 10 jobs)
    recent_jobs = []
    for job in job_qs.select_related('touchpoint', 'started_by').order_by('-created_at')[:10]:
        recent_jobs.append({
            'id': job.id,
            'touchpoint_number': job.touchpoint.touchpoint_number if job.touchpoint else 0,
            'status': job.status,
            'total_recipients': job.total_recipients,
            'sent_count': job.sent_count,
            'failed_count': job.failed_count,
            'skipped_count': job.skipped_count,
            'started_by': job.started_by.username if job.started_by else '',
            'is_test': job.is_test,
            'created_at': job.created_at.isoformat(),
            'completed_at': job.completed_at.isoformat() if job.completed_at else None,
        })

    # Delivery rate over time (per day, last 30 days)
    thirty_days_ago = timezone.now() - timedelta(days=30)
    chart_logs = log_qs.filter(
        sent_at__gte=thirty_days_ago,
        sent_at__isnull=False,
    )
    daily_stats = defaultdict(lambda: {'sent': 0, 'failed': 0})
    for log in chart_logs.values('sent_at__date', 'status'):
        day = str(log['sent_at__date'])
        if log['status'] == 'sent':
            daily_stats[day]['sent'] += 1
        elif log['status'] == 'failed':
            daily_stats[day]['failed'] += 1

    daily_chart = []
    for day in sorted(daily_stats.keys()):
        s = daily_stats[day]
        total = s['sent'] + s['failed']
        daily_chart.append({
            'date': day,
            'sent': s['sent'],
            'failed': s['failed'],
            'rate': round(s['sent'] / total * 100, 1) if total > 0 else 0,
        })

    # Overall delivery rate
    total_attempted = total_sent + total_failed
    overall_delivery_rate = round(total_sent / total_attempted * 100, 1) if total_attempted > 0 else 0

    # ── Per-segment performance (Jané's analytics) ──
    # Emails sent per segment (respects active filters); statuses are current totals.
    seg_sent = dict(
        log_qs.filter(status='sent', job__is_test=False, contact__segment__isnull=False)
        .values('contact__segment_id')
        .annotate(n=Count('id'))
        .values_list('contact__segment_id', 'n')
    )
    seg_qs = Segment.objects.select_related('import_group')
    if filter_group:
        seg_qs = seg_qs.filter(import_group_id=int(filter_group))
    total_positive_replies = seg_qs.aggregate(s=Sum('positive_replies'))['s'] or 0
    segment_stats = []
    for seg in seg_qs.order_by('import_group__name', 'name'):
        cs = contact_qs.filter(segment_id=seg.id).aggregate(
            total=Count('id'),
            active=Count('id', filter=Q(status='active')),
            opted_out=Count('id', filter=Q(status='opted_out')),
            undeliverable=Count('id', filter=Q(status__in=['undeliverable', 'bounced'])),
            moved=Count('id', filter=Q(status='moved_to_hubspot')),
        )
        segment_stats.append({
            'id': seg.id,
            'name': seg.name,
            'group_name': seg.import_group.name,
            'contacts': cs['total'],
            'active': cs['active'],
            'sent': seg_sent.get(seg.id, 0),
            'positive_replies': seg.positive_replies,
            'moved_to_hubspot': cs['moved'],
            'undeliverable': cs['undeliverable'],
            'opted_out': cs['opted_out'],
        })

    # ── Results at a glance: plain-language grades ──
    total_contacts = contact_stats['total'] or 0
    active_pct = round(contact_stats['active'] / total_contacts * 100, 1) if total_contacts else 0
    optout_pct = round(contact_stats['opted_out'] / total_contacts * 100, 1) if total_contacts else 0
    glance = [
        {
            'label': 'Delivery',
            'value': f'{overall_delivery_rate}%',
            'grade': _grade(overall_delivery_rate, [(98, 'excellent'), (95, 'good'), (88, 'fair'), (0, 'poor')]) if total_attempted else 'none',
            'note': 'of attempted emails arrived' if total_attempted else 'no emails attempted yet',
        },
        {
            'label': 'Audience health',
            'value': f'{active_pct}%',
            'grade': _grade(active_pct, [(80, 'excellent'), (60, 'good'), (40, 'fair'), (0, 'poor')]) if total_contacts else 'none',
            'note': 'of contacts are active and reachable' if total_contacts else 'no contacts yet',
        },
        {
            'label': 'Opt-outs',
            'value': f'{optout_pct}%',
            'grade': _grade(-optout_pct, [(-1, 'excellent'), (-3, 'good'), (-6, 'fair'), (-100, 'poor')]) if total_contacts else 'none',
            'note': 'of contacts have opted out',
        },
        {
            'label': 'Leads',
            'value': str(total_positive_replies),
            'grade': 'info',
            'note': 'positive replies across segments',
        },
    ]

    # ── Weekday vs weekend sending (with per-day drill-down) ──
    day_names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    per_day = {n: {'sent': 0, 'failed': 0} for n in day_names}
    for row in log_qs.filter(sent_at__isnull=False, status__in=['sent', 'failed']).values('sent_at', 'status'):
        name = day_names[timezone.localtime(row['sent_at']).weekday()]
        per_day[name]['sent' if row['status'] == 'sent' else 'failed'] += 1
    weekday_totals = {'sent': 0, 'failed': 0}
    weekend_totals = {'sent': 0, 'failed': 0}
    for name in day_names:
        bucket = weekend_totals if name in ('Saturday', 'Sunday') else weekday_totals
        bucket['sent'] += per_day[name]['sent']
        bucket['failed'] += per_day[name]['failed']

    def _rate(d):
        att = d['sent'] + d['failed']
        return round(d['sent'] / att * 100, 1) if att else 0

    weekday_split = {
        'weekday': {**weekday_totals, 'rate': _rate(weekday_totals)},
        'weekend': {**weekend_totals, 'rate': _rate(weekend_totals)},
        'days': [{'day': n, **per_day[n], 'rate': _rate(per_day[n])} for n in day_names],
    }

    # ── Bounces: soft/hard split, categorized reasons, dead-address list ──
    reason_counts = {}
    kind_counts = {'hard': 0, 'soft': 0, 'other': 0}
    for err in log_qs.filter(status='failed').values_list('error', flat=True)[:5000]:
        kind, reason = _categorize_bounce(err)
        kind_counts[kind] += 1
        key = (kind, reason)
        reason_counts[key] = reason_counts.get(key, 0) + 1
    bounce_reasons = [
        {'kind': k, 'reason': r, 'count': c}
        for (k, r), c in sorted(reason_counts.items(), key=lambda kv: -kv[1])
    ][:12]
    dead_qs = contact_qs.filter(status__in=['undeliverable', 'bounced']).order_by('-updated_at')
    dead_total = dead_qs.count()
    dead_addresses = [
        {'email': c.email, 'org_name': c.org_name, 'updated_at': c.updated_at.isoformat()}
        for c in dead_qs[:10]
    ]

    # ── Beacon dashboard extras ──────────────────────────────────────────────
    from datetime import timedelta as _td

    now_ts = timezone.now()

    # Results at a glance: people reached, emails per person, growth, list grade
    people_reached = log_qs.filter(status='sent').values('contact_id').distinct().count()
    emails_per_person = round(total_sent / people_reached, 1) if people_reached else 0
    window_start = now_ts - _td(weeks=8)
    added_8w = contact_qs.filter(created_at__gte=window_start).count()
    lost_8w = contact_qs.filter(status='opted_out', updated_at__gte=window_start).count()
    weeks = []
    for i in range(8):
        w_start = now_ts - _td(weeks=8 - i)
        w_end = now_ts - _td(weeks=7 - i)
        weeks.append({
            'added': contact_qs.filter(created_at__gte=w_start, created_at__lt=w_end).count(),
            'lost': contact_qs.filter(status='opted_out', updated_at__gte=w_start, updated_at__lt=w_end).count(),
        })
    hard_rate = round(dead_total / total_contacts * 100, 1) if total_contacts else 0
    reached_optouts = contact_qs.filter(status='opted_out', last_touchpoint__gt=0).count()
    opt_rate = round(reached_optouts / people_reached * 100, 1) if people_reached else 0
    quality_score = hard_rate * 2 + opt_rate
    grade = 'A' if quality_score < 2 else 'B' if quality_score < 4 else 'C' if quality_score < 7 else 'D' if quality_score < 12 else 'F'
    results = {
        'people_reached': people_reached,
        'emails_per_person': emails_per_person,
        'added': added_8w,
        'lost': lost_8w,
        'window_label': 'last 8 weeks',
        'weeks': weeks,
        'grade': grade,
        'hard_rate': hard_rate,
        'opt_rate': opt_rate,
    }

    # Sent by campaign (green delivered / red failed)
    by_campaign = []
    camp_rows = {}
    for cid, cname, status_val in log_qs.filter(
        job__is_test=False, job__touchpoint__campaign__isnull=False, status__in=['sent', 'failed'],
    ).values_list('job__touchpoint__campaign_id', 'job__touchpoint__campaign__name', 'status'):
        row = camp_rows.setdefault(cid, {'id': cid, 'name': cname, 'sent': 0, 'failed': 0})
        row['sent' if status_val == 'sent' else 'failed'] += 1
    by_campaign = sorted(camp_rows.values(), key=lambda r: -(r['sent'] + r['failed']))

    # Campaign scorecard — the full picture per campaign
    scorecard = []
    for camp in Campaign.objects.select_related('group').order_by('name'):
        camp_jobs = SendJob.objects.filter(touchpoint__campaign=camp, is_test=False)
        c_sent = camp_jobs.aggregate(s=Sum('sent_count'))['s'] or 0
        c_failed = camp_jobs.aggregate(s=Sum('failed_count'))['s'] or 0
        soft_n = hard_n = 0
        for err in SendLog.objects.filter(job__in=camp_jobs, status='failed').values_list('error', flat=True)[:2000]:
            kind, _r = _categorize_bounce(err)
            if kind == 'hard':
                hard_n += 1
            else:
                soft_n += 1
        last_job = camp_jobs.order_by('-created_at').first()
        scorecard.append({
            'id': camp.id,
            'name': camp.name,
            'automated': camp.is_automated,
            'touchpoints': camp.touchpoints.filter(is_goodbye=False).count(),
            'sent': c_sent,
            'rate': (int(round(c_sent / (c_sent + c_failed) * 100)) if (c_sent + c_failed) else None),
            'soft': soft_n,
            'hard': hard_n,
            'optouts': Contact.objects.filter(status='opted_out', last_campaign=camp).count(),
            'upcoming': ScheduledSend.objects.filter(status='scheduled', touchpoint__campaign=camp).count(),
            'last_at': last_job.created_at.isoformat() if last_job else None,
        })

    # How far people got — funnel for the focus campaign (most active, or ?campaign_id=)
    funnel = None
    focus_id = request.GET.get('campaign_id')
    focus = Campaign.objects.filter(id=focus_id).first() if focus_id else None
    if not focus:
        busiest = max(camp_rows.values(), key=lambda r: r['sent'] + r['failed'], default=None)
        focus = Campaign.objects.filter(id=busiest['id']).first() if busiest else Campaign.objects.order_by('name').first()
    if focus:
        tp_nums = sorted(focus.touchpoints.filter(is_goodbye=False).values_list('touchpoint_number', flat=True))
        base = Contact.objects.filter(last_campaign=focus, last_touchpoint__gte=1).count()
        steps = []
        for n in tp_nums:
            cnt = Contact.objects.filter(last_campaign=focus, last_touchpoint__gte=n).count()
            steps.append({'n': n, 'count': cnt, 'pct': int(round(cnt / base * 100)) if base else 0})
        funnel = {'campaign': focus.name, 'auto': not bool(focus_id), 'steps': steps}

    # Audience by group
    audience_groups = [
        {'name': g.name, 'count': Contact.objects.filter(import_group=g).count()}
        for g in ImportGroup.objects.order_by('name')
    ]
    no_group = Contact.objects.filter(import_group__isnull=True).count()
    if no_group:
        audience_groups.append({'name': 'No group', 'count': no_group})

    # Opt-outs — everyone who opted out, and which organisations they belong to.
    # Scoped to the campaign when one is selected (their last journey was on it).
    opt_qs = Contact.objects.filter(status='opted_out')
    if filter_campaign:
        try:
            opt_qs = opt_qs.filter(last_campaign_id=int(filter_campaign))
        except (TypeError, ValueError):
            pass
    opt_by_org = {}
    for org in opt_qs.values_list('org_name', flat=True):
        key = org or '(no organisation)'
        opt_by_org[key] = opt_by_org.get(key, 0) + 1
    optouts = {
        'total': opt_qs.count(),
        'with_reason': opt_qs.exclude(opt_out_reason='').count(),
        'by_org': sorted(({'org': k, 'count': v} for k, v in opt_by_org.items()), key=lambda r: -r['count'])[:8],
        'recent': [
            {'email': c.email, 'contact_name': c.contact_name, 'org_name': c.org_name,
             'reason': c.opt_out_reason, 'at': c.updated_at.isoformat()}
            for c in opt_qs.order_by('-updated_at')[:8]
        ],
    }

    # Return available import groups for filter dropdown
    groups = list(ImportGroup.objects.values('id', 'name').order_by('name'))

    return JsonResponse({
        'ok': True,
        'results': results,
        'by_campaign': by_campaign,
        'scorecard': scorecard,
        'funnel': funnel,
        'audience_groups': audience_groups,
        'optouts': optouts,
        'glance': glance,
        'weekday_split': weekday_split,
        'bounces': {
            'hard': kind_counts['hard'],
            'soft': kind_counts['soft'],
            'other': kind_counts['other'],
            'reasons': bounce_reasons,
            'dead_addresses': dead_addresses,
            'dead_total': dead_total,
        },
        'overview': {
            'total_jobs': total_jobs,
            'total_sent': total_sent,
            'total_failed': total_failed,
            'total_skipped': total_skipped,
            'total_recipients': total_recipients,
            'delivery_rate': overall_delivery_rate,
        },
        'contacts': contact_stats,
        'touchpoints': tp_stats,
        'recent_jobs': recent_jobs,
        'daily_chart': daily_chart,
        'import_groups': groups,
        'segments': segment_stats,
        'positive_replies': total_positive_replies,
        'filter_options': {
            'groups': groups,
            'segments': [
                {'id': s['id'], 'name': s['name'], 'group_name': s['import_group__name']}
                for s in Segment.objects.select_related('import_group').values('id', 'name', 'import_group__name').order_by('name')
            ],
            'tags': list(Tag.objects.values('id', 'name').order_by('name')),
        },
    })


@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def reporting_drilldown(request):
    """Return detailed send log records filtered by status (sent, failed, skipped)."""
    filter_type = request.GET.get('type', '')  # sent, failed, skipped
    page = int(request.GET.get('page', '1'))
    per_page = 50

    valid_types = {'sent', 'failed', 'skipped'}
    if filter_type not in valid_types:
        return JsonResponse({'error': f'type must be one of: {", ".join(valid_types)}'}, status=400)

    qs = SendLog.objects.filter(status=filter_type).select_related('contact', 'job', 'job__touchpoint')
    total = qs.count()
    logs = qs.order_by('-sent_at', '-id')[(page - 1) * per_page:page * per_page]

    records = []
    for log in logs:
        records.append({
            'id': log.id,
            'email': log.contact.email,
            'contact_name': log.contact.contact_name,
            'org_name': log.contact.org_name,
            'status': log.status,
            'error': log.error,
            'touchpoint_number': log.job.touchpoint.touchpoint_number if log.job.touchpoint else 0,
            'job_id': log.job.id,
            'sent_at': log.sent_at.isoformat() if log.sent_at else None,
            'job_created_at': log.job.created_at.isoformat(),
        })

    return JsonResponse({
        'ok': True,
        'records': records,
        'total': total,
        'page': page,
        'pages': (total + per_page - 1) // per_page if total > 0 else 1,
    })


@csrf_exempt
@require_http_methods(["GET"])
@require_role('admin')
def user_stats(request):
    """Return activity stats for each user (emails sent, jobs started, etc.)."""
    from django.db.models import Count, Sum, Q

    user_list = []
    for u in User.objects.select_related('profile').order_by('-date_joined'):
        profile = getattr(u, 'profile', None)
        jobs = SendJob.objects.filter(started_by=u)
        job_count = jobs.count()
        agg = jobs.aggregate(
            total_sent=Sum('sent_count'),
            total_failed=Sum('failed_count'),
        )
        total_sent = agg['total_sent'] or 0
        total_failed = agg['total_failed'] or 0
        last_job = jobs.order_by('-created_at').first()

        user_list.append({
            'id': u.id,
            'username': u.username,
            'email': u.email,
            'first_name': u.first_name,
            'last_name': u.last_name,
            'role': profile.role if profile else 'viewer',
            'is_active': u.is_active,
            'date_joined': u.date_joined.isoformat(),
            'jobs_started': job_count,
            'emails_sent': total_sent,
            'emails_failed': total_failed,
            'last_activity': last_job.created_at.isoformat() if last_job else None,
        })

    return JsonResponse({'ok': True, 'users': user_list})


@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def send_job_progress(request):
    """Get progress of a specific send job or list recent jobs."""
    # Piggyback: fire any scheduled sends that are now due (no queue worker needed).
    _process_due_scheduled_sends()
    job_id = request.GET.get('job_id')

    if job_id:
        try:
            job = SendJob.objects.get(id=job_id)
        except SendJob.DoesNotExist:
            return JsonResponse({'error': 'Job not found'}, status=404)

        return JsonResponse({
            'ok': True,
            'job': {
                'id': job.id,
                'touchpoint_number': job.touchpoint.touchpoint_number if job.touchpoint else 0,
                'status': job.status,
                'total_recipients': job.total_recipients,
                'sent_count': job.sent_count,
                'failed_count': job.failed_count,
                'skipped_count': job.skipped_count,
                'created_at': job.created_at.isoformat(),
                'completed_at': job.completed_at.isoformat() if job.completed_at else None,
            },
        })

    # List recent jobs
    jobs = []
    for job in SendJob.objects.select_related('touchpoint', 'touchpoint__campaign', 'template', 'started_by').all()[:50]:
        # Find the contact currently being sent to (last pending log)
        current_contact = None
        if job.status == 'running':
            current_log = job.logs.filter(status='pending').select_related('contact').first()
            if current_log:
                current_contact = current_log.contact.contact_name or current_log.contact.org_name or current_log.contact.email

        # Finished jobs: split failures into soft/hard bounces for the history tallies
        soft = hard = 0
        if job.status not in ('running', 'pending') and job.failed_count:
            for err in job.logs.filter(status='failed').values_list('error', flat=True):
                kind, _ = _categorize_bounce(err)
                if kind == 'hard':
                    hard += 1
                else:
                    soft += 1

        # Recipients of this run who opted out after it started
        optouts = 0
        if job.status not in ('running', 'pending'):
            optouts = job.logs.filter(
                status='sent', contact__status='opted_out', contact__updated_at__gte=job.created_at,
            ).count()

        jobs.append({
            'id': job.id,
            'touchpoint_number': job.touchpoint.touchpoint_number if job.touchpoint else 0,
            'campaign_id': job.touchpoint.campaign_id if job.touchpoint else None,
            'campaign_name': (job.touchpoint.campaign.name if job.touchpoint and job.touchpoint.campaign else ''),
            'subject': job.touchpoint.subject if job.touchpoint else '',
            'template_name': job.template.name if job.template else '',
            'status': job.status,
            'total_recipients': job.total_recipients,
            'sent_count': job.sent_count,
            'failed_count': job.failed_count,
            'skipped_count': job.skipped_count,
            'soft_bounces': soft,
            'hard_bounces': hard,
            'optout_count': optouts,
            'target_summary': job.target_summary or 'all contacts',
            'started_by': job.started_by.username if job.started_by else '',
            'is_test': job.is_test,
            'created_at': job.created_at.isoformat(),
            'completed_at': job.completed_at.isoformat() if job.completed_at else None,
            'current_contact': current_contact,
        })

    return JsonResponse({'ok': True, 'jobs': jobs})


@csrf_exempt
@require_http_methods(["GET"])
@require_auth
def send_job_report(request):
    """Per-send report: arrived/failed/skipped/recipient tiles, failure reasons
    grouped with counts, and per-person lists."""
    job_id = request.GET.get('job_id')
    job = SendJob.objects.select_related('touchpoint', 'touchpoint__campaign', 'template', 'started_by').filter(id=job_id).first()
    if not job:
        return JsonResponse({'error': 'Job not found'}, status=404)

    logs = list(job.logs.select_related('contact').order_by('id'))
    people = {'sent': [], 'failed': [], 'skipped': [], 'pending': []}
    reason_counts = {}
    for log in logs:
        entry = {
            'email': log.contact.email,
            'contact_name': log.contact.contact_name,
            'org_name': log.contact.org_name,
            'error': log.error,
            'sent_at': log.sent_at.isoformat() if log.sent_at else None,
        }
        people.setdefault(log.status, []).append(entry)
        if log.status == 'failed':
            kind, reason = _categorize_bounce(log.error)
            key = (kind, reason)
            reason_counts[key] = reason_counts.get(key, 0) + 1

    failure_reasons = [
        {'kind': k, 'reason': r, 'count': c}
        for (k, r), c in sorted(reason_counts.items(), key=lambda kv: -kv[1])
    ]

    return JsonResponse({
        'ok': True,
        'job': {
            'id': job.id,
            'touchpoint_number': job.touchpoint.touchpoint_number if job.touchpoint else 0,
            'campaign_name': (job.touchpoint.campaign.name if job.touchpoint and job.touchpoint.campaign else ''),
            'template_name': job.template.name if job.template else '',
            'status': job.status,
            'is_test': job.is_test,
            'total_recipients': job.total_recipients,
            'sent_count': job.sent_count,
            'failed_count': job.failed_count,
            'skipped_count': job.skipped_count,
            'started_by': job.started_by.username if job.started_by else '',
            'created_at': job.created_at.isoformat(),
            'completed_at': job.completed_at.isoformat() if job.completed_at else None,
        },
        'failure_reasons': failure_reasons,
        'people': people,
    })


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def send_job_cancel(request):
    """Cancel a running send job immediately."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    job_id = data.get('job_id')
    try:
        job = SendJob.objects.get(id=job_id)
    except SendJob.DoesNotExist:
        return JsonResponse({'error': 'Job not found'}, status=404)

    if job.status in ('running', 'pending'):
        # Mark remaining pending logs as skipped immediately
        pending_count = job.logs.filter(status='pending').update(status='skipped')
        job.status = 'cancelled'
        job.skipped_count += pending_count
        job.completed_at = timezone.now()
        job.save()
        return JsonResponse({'ok': True, 'message': f'Job cancelled. {pending_count} remaining emails skipped.'})

    return JsonResponse({'error': 'Job is not running'}, status=400)


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def check_bounces(request):
    """Manually check SES suppression list for bounced emails in a job."""
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    job_id = data.get('job_id')
    if job_id:
        # Check bounces for a specific job
        bounced = _check_bounces_for_job(job_id)
        if bounced is None:
            return JsonResponse({'error': 'Job not found'}, status=404)
        return JsonResponse({'ok': True, 'bounced_count': bounced})
    else:
        # Check bounces for ALL completed jobs
        jobs = SendJob.objects.filter(status__in=['completed', 'cancelled'])
        total_bounced = 0
        for job in jobs:
            result = _check_bounces_for_job(job.id)
            if result:
                total_bounced += result
        return JsonResponse({'ok': True, 'bounced_count': total_bounced})


@csrf_exempt
@require_http_methods(["POST"])
def ses_bounce_webhook(request):
    """Handle AWS SES bounce/complaint notifications via SNS."""
    # SNS sends JSON in the body
    try:
        payload = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON'}, status=400)

    msg_type = request.headers.get('x-amz-sns-message-type', '')

    # Handle SNS subscription confirmation
    if msg_type == 'SubscriptionConfirmation':
        subscribe_url = payload.get('SubscribeURL')
        if subscribe_url:
            import urllib.request
            try:
                urllib.request.urlopen(subscribe_url)
                print(f'[SES-WEBHOOK] SNS subscription confirmed', flush=True)
            except Exception as e:
                print(f'[SES-WEBHOOK] Failed to confirm subscription: {e}', flush=True)
        return JsonResponse({'ok': True, 'message': 'Subscription confirmed'})

    # Handle actual notifications
    if msg_type == 'Notification':
        try:
            message = json.loads(payload.get('Message', '{}'))
        except json.JSONDecodeError:
            return JsonResponse({'error': 'Invalid Message JSON'}, status=400)

        notif_type = message.get('notificationType')

        if notif_type == 'Bounce':
            bounce = message.get('bounce', {})
            bounce_type = bounce.get('bounceType', '')  # Permanent or Transient
            recipients = bounce.get('bouncedRecipients', [])

            for recipient in recipients:
                email = recipient.get('emailAddress', '').lower()
                if not email:
                    continue

                try:
                    contact = Contact.objects.get(email__iexact=email)
                    if bounce_type == 'Permanent':
                        contact.status = 'bounced'
                    else:
                        contact.status = 'undeliverable'
                    contact.save()
                    print(f'[SES-WEBHOOK] Bounce ({bounce_type}): {email} -> {contact.status}', flush=True)

                    # Update any send logs for this contact with the bounce info
                    msg_id = message.get('mail', {}).get('messageId', '')
                    if msg_id:
                        SendLog.objects.filter(
                            contact=contact, message_id=msg_id
                        ).update(status='failed', error=f'Bounced: {bounce_type} - {recipient.get("diagnosticCode", "")}')
                except Contact.DoesNotExist:
                    print(f'[SES-WEBHOOK] Bounce for unknown contact: {email}', flush=True)

        elif notif_type == 'Complaint':
            complaint = message.get('complaint', {})
            recipients = complaint.get('complainedRecipients', [])

            for recipient in recipients:
                email = recipient.get('emailAddress', '').lower()
                if not email:
                    continue

                try:
                    contact = Contact.objects.get(email__iexact=email)
                    contact.status = 'opted_out'
                    contact.save()
                    print(f'[SES-WEBHOOK] Complaint: {email} -> opted_out', flush=True)
                except Contact.DoesNotExist:
                    print(f'[SES-WEBHOOK] Complaint for unknown contact: {email}', flush=True)

        return JsonResponse({'ok': True})

    return JsonResponse({'ok': True})
