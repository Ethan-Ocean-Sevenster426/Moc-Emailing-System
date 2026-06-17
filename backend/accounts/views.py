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

from .models import TouchpointTemplate, UserProfile, OTP, ImportGroup, Segment, Contact, SendJob, SendLog, SavedTestEmail, EmailTemplate


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


def _ses_send_mail(to_address, subject, body_html=None, body_text=None,
                   from_address=None, from_name='Waldo Gaybba',
                   attachments=None, max_retries=3):
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
    })


@csrf_exempt
@require_http_methods(["GET"])
def health_check(request):
    return JsonResponse({"status": "ok", "message": "Django backend is running"})


# ── User management views (admin only) ──────────────────────────────────────

@csrf_exempt
@require_http_methods(["GET"])
@require_role('admin')
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
@require_role('admin')
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
    if role not in ('admin', 'editor', 'viewer'):
        return JsonResponse({'error': 'Invalid role'}, status=400)
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
@require_role('admin')
def users_update(request):
    try:
        data = json.loads(request.body)
    except json.JSONDecodeError:
        return JsonResponse({"error": "Invalid JSON"}, status=400)

    user_id = data.get('user_id')
    role = data.get('role')

    if not user_id or not role:
        return JsonResponse({'error': 'user_id and role are required'}, status=400)
    if role not in ('admin', 'editor', 'viewer'):
        return JsonResponse({'error': 'Invalid role'}, status=400)

    try:
        target_user = User.objects.get(id=user_id)
    except User.DoesNotExist:
        return JsonResponse({'error': 'User not found'}, status=404)

    if target_user.id == request.user.id and role != 'admin':
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

    target_user.delete()
    return JsonResponse({'ok': True, 'message': 'User deleted'})


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin')
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
    templates = []
    for t in TouchpointTemplate.objects.all():
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
    tpl, _ = TouchpointTemplate.objects.get_or_create(touchpoint_number=tp_num)

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

    try:
        tpl = TouchpointTemplate.objects.get(touchpoint_number=tp_num)
    except TouchpointTemplate.DoesNotExist:
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
                body_content += f'<div style="margin-top:16px"><img src="cid:{cid}" alt="Signature" style="max-width:320px;height:auto" /></div>'

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

    tpl, _ = TouchpointTemplate.objects.get_or_create(touchpoint_number=tp_num)

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
    for t in TouchpointTemplate.objects.all():
        if t.scheduled_date:
            schedules[str(t.touchpoint_number)] = str(t.scheduled_date)
        if t.daily_send_limit > 0:
            limits[str(t.touchpoint_number)] = t.daily_send_limit
    return JsonResponse({'ok': True, 'schedules': schedules, 'limits': limits})


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

    qs = Contact.objects.select_related('import_group', 'segment')
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
            'import_group_id': c.import_group_id,
            'import_group_name': c.import_group.name if c.import_group else None,
            'segment_id': c.segment_id,
            'segment_name': c.segment.name if c.segment else None,
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

    c = Contact.objects.create(
        org_name=data.get('org_name', '').strip(),
        contact_name=data.get('contact_name', '').strip(),
        email=email,
        phone=data.get('phone', '').strip(),
        status=data.get('status', 'active'),
        notes=data.get('notes', '').strip(),
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
                body_content += f'<div style="margin-top:16px"><img src="cid:{cid}" alt="Signature" style="max-width:320px;height:auto" /></div>'
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
    """Public opt-out endpoint. Marks the contact as opted_out when the link is clicked."""
    try:
        data = signing.loads(token, salt=OPTOUT_SALT, max_age=60 * 60 * 24 * 365)
        contact = Contact.objects.filter(id=data.get('cid')).first()
    except signing.BadSignature:
        contact = None
    except Exception:
        contact = None

    if not contact:
        return _optout_page('Link not valid', 'This opt-out link is invalid or has expired. Please reply to the email with "STOP" and we will remove you.', ok=False)

    if contact.status != 'opted_out':
        contact.status = 'opted_out'
        if not contact.opt_out_reason:
            contact.opt_out_reason = 'Unsubscribed via email opt-out link'
        contact.save(update_fields=['status', 'opt_out_reason', 'updated_at'])
        print(f'[OPT-OUT] {contact.email} marked opted_out via link', flush=True)

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


@csrf_exempt
@require_http_methods(["POST"])
@require_role('admin', 'editor')
def contacts_import_csv(request):
    """Import contacts from a CSV file. Expected columns: org_name, contact_name, email, phone"""
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

    try:
        decoded = csv_file.read().decode('utf-8-sig')
        reader = csv.DictReader(io.StringIO(decoded))
    except Exception as e:
        if created_segment:
            segment.delete()
        if created_group:
            import_group.delete()
        return JsonResponse({'error': f'Cannot parse CSV: {e}'}, status=400)

    created = 0
    updated = 0
    skipped = 0
    errors = []
    for i, row in enumerate(reader, start=2):
        email = (row.get('email') or row.get('Email') or '').strip()
        if not email:
            skipped += 1
            continue
        existing = Contact.objects.filter(email=email).first()
        if existing:
            # Contact already exists. If this import targets a group/segment, re-tag it
            # (so re-importing a batch into "Nigeria" actually tags those people).
            if import_group or segment:
                if import_group:
                    existing.import_group = import_group
                if segment:
                    existing.segment = segment
                existing.save(update_fields=['import_group', 'segment', 'updated_at'])
                updated += 1
            else:
                skipped += 1
            continue
        try:
            Contact.objects.create(
                org_name=(row.get('org_name') or row.get('Organization') or row.get('Company') or '').strip(),
                contact_name=(row.get('contact_name') or row.get('Name') or row.get('Contact') or '').strip(),
                email=email,
                phone=(row.get('phone') or row.get('Phone') or '').strip(),
                status='active',
                import_group=import_group,
                segment=segment,
            )
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
        'errors': errors[:10],
        'import_group': {'id': import_group.id, 'name': import_group.name} if import_group else None,
        'segment': {'id': segment.id, 'name': segment.name} if segment else None,
    })


@csrf_exempt
@require_http_methods(["GET"])
@require_role('admin', 'editor')
def contacts_export_csv(request):
    """Export all contacts as CSV."""
    response = HttpResponse(content_type='text/csv')
    response['Content-Disposition'] = 'attachment; filename="contacts.csv"'

    writer = csv.writer(response)
    writer.writerow(['org_name', 'contact_name', 'email', 'phone', 'status', 'opt_out_reason', 'last_touchpoint', 'notes'])
    for c in Contact.objects.all():
        writer.writerow([c.org_name, c.contact_name, c.email, c.phone, c.status, c.opt_out_reason, c.last_touchpoint, c.notes])

    return response


# ── Bulk send / progress views ──────────────────────────────────────────────

def _run_bulk_send(job_id):
    """Background thread: sends emails for a SendJob."""
    try:
        job = SendJob.objects.get(id=job_id)
        tpl = job.touchpoint
    except SendJob.DoesNotExist:
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
                body_content += f'<div style="margin-top:16px"><img src="cid:{cid}" alt="Signature" style="max-width:320px;height:auto" /></div>'

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

        # Pre-send validation: check domain has MX records
        if not _domain_has_mx(contact.email):
            log.status = 'failed'
            log.error = f'Invalid domain: no MX records for {contact.email.split("@")[-1]}'
            log.sent_at = timezone.now()
            log.save()
            SendJob.objects.filter(id=job.id).update(failed_count=F('failed_count') + 1)
            contact.status = 'undeliverable'
            contact.save()
            print(f'[BULK-SEND] Skipped {contact.email}: no MX records', flush=True)
            continue

        # Pre-send validation: check SES suppression list
        try:
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

    try:
        tpl = TouchpointTemplate.objects.get(touchpoint_number=tp_num)
    except TouchpointTemplate.DoesNotExist:
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
    contacts = _eligible_contacts_for_send(tp_num, data)
    contacts = contacts.order_by('id')  # deterministic ordering so "next N" is consistent

    total_eligible = contacts.count()
    if total_eligible == 0:
        return JsonResponse({'error': f'No contacts are eligible for Touchpoint {tp_num} (they must have received Touchpoint {tp_num - 1} first).'}, status=400)

    # Per-send cap for AWS-friendly batching. Falls back to the template's daily limit.
    send_limit = data.get('limit')
    try:
        send_limit = int(send_limit)
    except (TypeError, ValueError):
        send_limit = 0
    if send_limit <= 0 and tpl.daily_send_limit > 0:
        send_limit = tpl.daily_send_limit

    contact_list = list(contacts[:send_limit] if send_limit > 0 else contacts)

    # Create the job
    job = SendJob.objects.create(
        touchpoint=tpl,
        template=library_tpl,
        total_recipients=len(contact_list),
        started_by=request.user,
    )

    # Create log entries
    SendLog.objects.bulk_create([
        SendLog(job=job, contact=c) for c in contact_list
    ])

    # Start background thread
    thread = threading.Thread(target=_run_bulk_send, args=(job.id,), daemon=True)
    thread.start()

    capped = send_limit > 0 and total_eligible > len(contact_list)
    remaining = total_eligible - len(contact_list)
    msg = f'Sending started — {len(contact_list)} of {total_eligible} eligible'
    if capped:
        msg += f' (capped, {remaining} left for next batch)'

    return JsonResponse({
        'ok': True,
        'job_id': job.id,
        'total_recipients': len(contact_list),
        'total_eligible': total_eligible,
        'remaining': remaining,
        'limit_applied': capped,
        'message': msg,
    })


def _eligible_contacts_for_send(tp_num, data):
    """Contacts eligible to receive touchpoint `tp_num` — active and currently at TP(N-1),
    optionally narrowed by import group and/or segment(s)."""
    qs = Contact.objects.filter(status='active', last_touchpoint=int(tp_num) - 1)
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
    eligible = _eligible_contacts_for_send(int(tp_num), data).count()
    return JsonResponse({'ok': True, 'touchpoint_number': int(tp_num), 'eligible': eligible})


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

    # Build base querysets with filters applied
    job_qs = SendJob.objects.all()
    log_qs = SendLog.objects.all()
    contact_qs = Contact.objects.all()

    if filter_tp:
        job_qs = job_qs.filter(touchpoint__touchpoint_number=int(filter_tp))
        log_qs = log_qs.filter(job__touchpoint__touchpoint_number=int(filter_tp))

    if filter_group:
        log_qs = log_qs.filter(contact__import_group_id=int(filter_group))
        contact_qs = contact_qs.filter(import_group_id=int(filter_group))
        # For jobs, filter to those that have logs matching the group
        job_ids = log_qs.values_list('job_id', flat=True).distinct()
        job_qs = job_qs.filter(id__in=job_ids)

    if filter_from:
        d = datetime.strptime(filter_from, '%Y-%m-%d').date()
        job_qs = job_qs.filter(created_at__date__gte=d)
        log_qs = log_qs.filter(sent_at__date__gte=d)

    if filter_to:
        d = datetime.strptime(filter_to, '%Y-%m-%d').date()
        job_qs = job_qs.filter(created_at__date__lte=d)
        log_qs = log_qs.filter(sent_at__date__lte=d)

    # When filtering by group or date, compute totals from SendLog instead of SendJob aggregates
    if filter_group or filter_from or filter_to:
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

    # Per-touchpoint stats
    tp_stats = []
    for tp_num in range(1, 11):
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
            'touchpoint_number': job.touchpoint.touchpoint_number,
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

    # Return available import groups for filter dropdown
    groups = list(ImportGroup.objects.values('id', 'name').order_by('name'))

    return JsonResponse({
        'ok': True,
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
            'touchpoint_number': log.job.touchpoint.touchpoint_number,
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
                'touchpoint_number': job.touchpoint.touchpoint_number,
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
    for job in SendJob.objects.all()[:20]:
        # Find the contact currently being sent to (last pending log)
        current_contact = None
        if job.status == 'running':
            current_log = job.logs.filter(status='pending').select_related('contact').first()
            if current_log:
                current_contact = current_log.contact.contact_name or current_log.contact.org_name or current_log.contact.email

        jobs.append({
            'id': job.id,
            'touchpoint_number': job.touchpoint.touchpoint_number,
            'status': job.status,
            'total_recipients': job.total_recipients,
            'sent_count': job.sent_count,
            'failed_count': job.failed_count,
            'skipped_count': job.skipped_count,
            'started_by': job.started_by.username if job.started_by else '',
            'is_test': job.is_test,
            'created_at': job.created_at.isoformat(),
            'completed_at': job.completed_at.isoformat() if job.completed_at else None,
            'current_contact': current_contact,
        })

    return JsonResponse({'ok': True, 'jobs': jobs})


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
