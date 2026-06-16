import secrets
from datetime import timedelta

from django.contrib.auth.models import User
from django.db import models
from django.utils import timezone


class TouchpointTemplate(models.Model):
    touchpoint_number = models.IntegerField(unique=True)
    subject = models.CharField(max_length=500, default='')
    body = models.TextField(default='')
    body_html = models.TextField(default='', blank=True)
    signature = models.TextField(default='', blank=True)
    opt_out_text = models.TextField(
        default="If you'd prefer not to receive further communication from us, you can opt out here.",
        blank=True,
        help_text='Opt-out sentence shown at the bottom of the email; rendered as a clickable unsubscribe link.',
    )
    attachment = models.FileField(upload_to='touchpoint_attachments/', blank=True, null=True)
    signature_image = models.FileField(
        upload_to='touchpoint_signatures/', blank=True, null=True,
        help_text='Inline signature image (referenced via cid:signature_tpN).'
    )
    days_after_previous = models.IntegerField(default=7)
    scheduled_date = models.DateField(null=True, blank=True)
    daily_send_limit = models.IntegerField(
        default=0, help_text='Max emails to send per day (0 = send all at once)'
    )
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'touchpoint_templates'
        ordering = ['touchpoint_number']

    def __str__(self):
        return f'Touchpoint {self.touchpoint_number}'


class UserProfile(models.Model):
    ROLE_CHOICES = [
        ('admin', 'Admin'),
        ('editor', 'Editor'),
        ('viewer', 'Viewer'),
    ]
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    role = models.CharField(max_length=10, choices=ROLE_CHOICES, default='viewer')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'user_profiles'

    def __str__(self):
        return f'{self.user.username} ({self.role})'


class OTP(models.Model):
    PURPOSE_CHOICES = [
        ('login', 'Login Verification'),
        ('password_reset', 'Password Reset'),
        ('account_setup', 'Account Setup'),
    ]
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='otps')
    code = models.CharField(max_length=6)
    purpose = models.CharField(max_length=20, choices=PURPOSE_CHOICES)
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField()
    is_used = models.BooleanField(default=False)

    class Meta:
        db_table = 'otps'
        ordering = ['-created_at']

    def is_valid(self):
        return not self.is_used and timezone.now() < self.expires_at

    @classmethod
    def generate(cls, user, purpose, expiry_minutes=60):
        # Rate limit: no more than 1 OTP per 60 seconds per user+purpose
        recent = cls.objects.filter(
            user=user, purpose=purpose,
            created_at__gte=timezone.now() - timedelta(seconds=60),
        ).exists()
        if recent:
            return None

        # Invalidate previous unused OTPs
        cls.objects.filter(user=user, purpose=purpose, is_used=False).update(is_used=True)
        code = f'{secrets.randbelow(1000000):06d}'
        expires_at = timezone.now() + timedelta(minutes=expiry_minutes)
        return cls.objects.create(
            user=user, code=code, purpose=purpose, expires_at=expires_at,
        )

    def __str__(self):
        return f'OTP {self.code} for {self.user.username} ({self.purpose})'


class ImportGroup(models.Model):
    """A named batch/region for imported contacts (e.g., 'South African Data', 'American Data')."""
    name = models.CharField(max_length=300)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'import_groups'
        ordering = ['-created_at']

    def __str__(self):
        return self.name


class Segment(models.Model):
    """A tag/sub-group within an import group (e.g. 'California' under 'American Data').

    Contacts can be assigned to a segment so emails can be targeted MailChimp-style.
    """
    name = models.CharField(max_length=300)
    import_group = models.ForeignKey(
        ImportGroup, on_delete=models.CASCADE, related_name='segments',
    )
    positive_replies = models.IntegerField(
        default=0, help_text='Manually tracked count of positive replies for this segment.'
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'segments'
        ordering = ['name']
        unique_together = ('import_group', 'name')

    def __str__(self):
        return f'{self.name} ({self.import_group.name})'


class Contact(models.Model):
    STATUS_CHOICES = [
        ('active', 'Active'),
        ('inactive', 'Inactive'),
        ('undeliverable', 'Undeliverable'),
        ('opted_out', 'Opt-out'),
        ('moved_to_hubspot', 'Moved to HubSpot'),
        ('bounced', 'Bounced'),  # legacy/SES — displayed as Undeliverable
    ]
    org_name = models.CharField(max_length=300, default='')
    contact_name = models.CharField(max_length=300, default='')
    email = models.EmailField(unique=True)
    phone = models.CharField(max_length=50, default='', blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='active')
    opt_out_reason = models.TextField(default='', blank=True, help_text='Reason for opting out')
    notes = models.TextField(default='', blank=True)
    last_touchpoint = models.IntegerField(default=0, help_text='Last touchpoint number sent')
    import_group = models.ForeignKey(
        ImportGroup, on_delete=models.SET_NULL, null=True, blank=True, related_name='contacts',
    )
    segment = models.ForeignKey(
        'Segment', on_delete=models.SET_NULL, null=True, blank=True, related_name='contacts',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'contacts'
        ordering = ['org_name', 'contact_name']

    def __str__(self):
        return f'{self.contact_name} ({self.org_name}) <{self.email}>'


class EmailTemplate(models.Model):
    """A reusable, named email template that can be selected when sending a touchpoint.

    Optional — if no template is chosen at send time, the touchpoint's own content is used.
    """
    name = models.CharField(max_length=300)
    subject = models.CharField(max_length=500, default='')
    body_html = models.TextField(default='', blank=True)
    body = models.TextField(default='', blank=True, help_text='Plain-text fallback')
    signature = models.TextField(default='', blank=True)
    opt_out_text = models.TextField(
        default="If you'd prefer not to receive further communication from us, you can opt out here.",
        blank=True,
        help_text='Opt-out sentence rendered as a clickable unsubscribe link at the bottom of the email.',
    )
    signature_image = models.FileField(
        upload_to='template_signatures/', blank=True, null=True,
        help_text='Inline signature image (referenced via cid:signature_tplN).'
    )
    attachment = models.FileField(upload_to='template_attachments/', blank=True, null=True)
    created_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'saved_templates'
        ordering = ['name']

    def __str__(self):
        return self.name


class SendJob(models.Model):
    """A bulk email send job for a specific touchpoint."""
    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('running', 'Running'),
        ('completed', 'Completed'),
        ('failed', 'Failed'),
        ('cancelled', 'Cancelled'),
    ]
    touchpoint = models.ForeignKey(TouchpointTemplate, on_delete=models.CASCADE, related_name='send_jobs')
    template = models.ForeignKey(
        'EmailTemplate', on_delete=models.SET_NULL, null=True, blank=True, related_name='send_jobs',
        help_text='Optional reusable template whose content overrides the touchpoint for this send.',
    )
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending')
    total_recipients = models.IntegerField(default=0)
    sent_count = models.IntegerField(default=0)
    failed_count = models.IntegerField(default=0)
    skipped_count = models.IntegerField(default=0)
    started_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True)
    is_test = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'send_jobs'
        ordering = ['-created_at']

    def __str__(self):
        return f'SendJob #{self.id} - TP{self.touchpoint.touchpoint_number} ({self.status})'


class SendLog(models.Model):
    """Individual send result per contact per job."""
    STATUS_CHOICES = [
        ('pending', 'Pending'),
        ('sent', 'Sent'),
        ('failed', 'Failed'),
        ('skipped', 'Skipped'),
    ]
    job = models.ForeignKey(SendJob, on_delete=models.CASCADE, related_name='logs')
    contact = models.ForeignKey(Contact, on_delete=models.CASCADE, related_name='send_logs')
    status = models.CharField(max_length=10, choices=STATUS_CHOICES, default='pending')
    message_id = models.CharField(max_length=200, default='', blank=True)
    error = models.TextField(default='', blank=True)
    sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'send_logs'
        ordering = ['-sent_at']

    def __str__(self):
        return f'{self.contact.email} - {self.status}'


class SavedTestEmail(models.Model):
    """Saved test email recipients so users don't have to re-enter them."""
    email = models.EmailField(unique=True)
    added_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'saved_test_emails'
        ordering = ['email']

    def __str__(self):
        return self.email
