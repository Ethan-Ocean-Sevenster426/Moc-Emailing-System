import secrets
from datetime import timedelta

from django.contrib.auth.models import User
from django.db import models
from django.utils import timezone


class CampaignGroup(models.Model):
    """Top of the Beacon hierarchy: group -> campaign -> flow of touchpoints."""
    name = models.CharField(max_length=300)
    description = models.TextField(default='', blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'campaign_groups'
        ordering = ['name']

    def __str__(self):
        return self.name


class Campaign(models.Model):
    """A campaign inside a group; it owns a flow of touchpoints and waits."""
    name = models.CharField(max_length=300)
    group = models.ForeignKey(CampaignGroup, on_delete=models.CASCADE, related_name='campaigns')
    description = models.TextField(default='', blank=True, help_text='Notes (optional)')
    is_automated = models.BooleanField(
        default=False, help_text='Normal campaigns are sent by hand; automated ones enrol new contacts themselves.',
    )
    segment = models.ForeignKey(
        'Segment', on_delete=models.SET_NULL, null=True, blank=True, related_name='campaigns',
        help_text='Default audience — pre-filled on every send; optional.',
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'campaigns'
        ordering = ['name']

    def __str__(self):
        return f'{self.name} ({self.group.name})'


class TouchpointTemplate(models.Model):
    campaign = models.ForeignKey(
        Campaign, on_delete=models.CASCADE, null=True, blank=True, related_name='touchpoints',
    )
    touchpoint_number = models.IntegerField()
    name = models.CharField(
        max_length=200, default='', blank=True,
        help_text='Optional custom label shown instead of "Touchpoint N".',
    )
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
    signature_image_height = models.IntegerField(
        default=90, help_text='Rendered height in px (0 = auto, keeps proportions).',
    )
    signature_image_width = models.IntegerField(
        default=0, help_text='Rendered width in px (0 = auto, keeps proportions).',
    )
    days_after_previous = models.IntegerField(default=7)
    # Fine-grained wait (Beacon-style): minutes before this step sends, plus an
    # optional pinned clock time. days_after_previous stays in sync for
    # backwards compatibility (intdiv(wait_minutes, 1440)).
    wait_minutes = models.IntegerField(null=True, blank=True)
    send_time = models.TimeField(
        null=True, blank=True,
        help_text='Pins the clock time it sends at — e.g. wait 1 week, then at 9:00 AM.',
    )
    scheduled_date = models.DateField(null=True, blank=True)
    daily_send_limit = models.IntegerField(
        default=0, help_text='Max emails to send per day (0 = send all at once)'
    )
    # Goodbye emails: an optional farewell sent when someone opts out after a
    # given touchpoint. Stored as touchpoints with touchpoint_number = 1000000+N
    # (keeps the unique key clear) and excluded from normal touchpoint queries.
    is_goodbye = models.BooleanField(default=False)
    goodbye_for = models.IntegerField(
        null=True, blank=True,
        help_text='Touchpoint number this goodbye belongs to; null = campaign-wide fallback.',
    )
    updated_at = models.DateTimeField(auto_now=True)

    GOODBYE_OFFSET = 1000000

    class Meta:
        db_table = 'touchpoint_templates'
        ordering = ['touchpoint_number']
        unique_together = ('campaign', 'touchpoint_number')

    WAIT_UNITS = [('months', 43200), ('weeks', 10080), ('days', 1440), ('hours', 60), ('minutes', 1)]

    def wait_in_minutes(self):
        """Effective wait before this step, in minutes."""
        if self.wait_minutes is not None:
            return max(0, self.wait_minutes)
        return max(0, self.days_after_previous) * 1440

    @classmethod
    def compose_wait(cls, parts):
        """{'months': 0, 'weeks': 1, ...} -> total minutes."""
        total = 0
        for unit, factor in cls.WAIT_UNITS:
            try:
                total += max(0, int(parts.get(unit) or 0)) * factor
            except (TypeError, ValueError):
                pass
        return total

    @classmethod
    def decompose_wait(cls, minutes):
        """Total minutes -> {'months': .., 'weeks': .., ...} greedy breakdown."""
        minutes = max(0, int(minutes or 0))
        out = {}
        for unit, factor in cls.WAIT_UNITS:
            out[unit], minutes = divmod(minutes, factor)
        return out

    @classmethod
    def human_wait(cls, minutes):
        """'1 week and 3 days' / 'No wait' — Beacon's wording."""
        minutes = max(0, int(minutes or 0))
        if minutes == 0:
            return 'No wait'
        parts = []
        for unit, factor in cls.WAIT_UNITS:
            qty, minutes = divmod(minutes, factor)
            if qty:
                parts.append(f'{qty} {unit[:-1] if qty == 1 else unit}')
        if len(parts) == 1:
            return parts[0].capitalize()
        return (' and '.join([', '.join(parts[:-1]), parts[-1]])).capitalize()

    def __str__(self):
        if self.is_goodbye:
            return f'Goodbye for TP{self.goodbye_for}' if self.goodbye_for else 'Campaign goodbye'
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


class CustomField(models.Model):
    """Registry of user-defined contact columns. Values live in Contact.custom_data."""
    name = models.CharField(max_length=100, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'custom_fields'
        ordering = ['name']

    def __str__(self):
        return self.name


class Tag(models.Model):
    """A freeform label contacts carry — applied to a whole upload at import
    time (\"Tag this upload\") and usable as a reporting filter."""
    name = models.CharField(max_length=100, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'tags'
        ordering = ['name']

    def __str__(self):
        return self.name


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
    custom_data = models.JSONField(
        default=dict, blank=True,
        help_text='Values for user-defined columns, keyed by CustomField name.',
    )
    last_touchpoint = models.IntegerField(default=0, help_text='Last touchpoint number sent')
    last_campaign = models.ForeignKey(
        'Campaign', on_delete=models.SET_NULL, null=True, blank=True, related_name='journey_contacts',
        help_text='The campaign whose journey this contact is on.',
    )
    import_group = models.ForeignKey(
        ImportGroup, on_delete=models.SET_NULL, null=True, blank=True, related_name='contacts',
    )
    segment = models.ForeignKey(
        'Segment', on_delete=models.SET_NULL, null=True, blank=True, related_name='contacts',
    )
    tags = models.ManyToManyField('Tag', blank=True, related_name='contacts')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'contacts'
        ordering = ['org_name', 'contact_name']

    def __str__(self):
        return f'{self.contact_name} ({self.org_name}) <{self.email}>'


class ReactivationRequest(models.Model):
    """An import row that tried to touch an opted-out contact.

    Imports can never overwrite or reactivate an opted-out contact — the row
    lands here as Pending approval instead. Approving applies the payload and
    reactivates the contact; 'Keep opted out' leaves the list unchanged.
    Decided rows form the Reactivation history.
    """
    STATUS_CHOICES = [
        ('pending', 'Pending approval'),
        ('approved', 'Approved'),
        ('kept_opted_out', 'Kept opted out'),
    ]
    contact = models.ForeignKey(Contact, on_delete=models.CASCADE, related_name='reactivation_requests')
    source = models.CharField(max_length=300, default='', help_text='Where the attempt came from, e.g. "Import: contacts.xlsx"')
    payload = models.JSONField(default=dict, blank=True, help_text='The incoming row data that was blocked')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending')
    created_at = models.DateTimeField(auto_now_add=True)
    decided_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True)
    decided_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = 'reactivation_requests'
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.contact.email} ({self.status})'


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
    touchpoint = models.ForeignKey(
        TouchpointTemplate, on_delete=models.SET_NULL, null=True, blank=True, related_name='send_jobs',
        help_text='Null when the touchpoint was later deleted — past sends keep their history.',
    )
    template = models.ForeignKey(
        'EmailTemplate', on_delete=models.SET_NULL, null=True, blank=True, related_name='send_jobs',
        help_text='Optional reusable template whose content overrides the touchpoint for this send.',
    )
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending')
    total_recipients = models.IntegerField(default=0)
    sent_count = models.IntegerField(default=0)
    failed_count = models.IntegerField(default=0)
    skipped_count = models.IntegerField(default=0)
    target_summary = models.CharField(
        max_length=300, default='', blank=True,
        help_text="Human summary of who this run targeted, e.g. 'South African Data · Gauteng'.",
    )
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


class FlowTemplate(models.Model):
    """A saved snapshot of the whole campaign flow (touchpoints, waits, goodbyes)
    that can be reapplied later to reproduce the journey."""
    name = models.CharField(max_length=300)
    data = models.JSONField(default=dict, blank=True, help_text='Serialized flow: touchpoints with waits and goodbye content.')
    created_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = 'flow_templates'
        ordering = ['-created_at']

    def __str__(self):
        return self.name


class ScheduledSend(models.Model):
    """A planned touchpoint send ('Coming up' card): run at a set time with a
    target and cap. Editing replaces the batch; it can be run now or cancelled."""
    STATUS_CHOICES = [
        ('scheduled', 'Scheduled'),
        ('sent', 'Sent'),
        ('cancelled', 'Cancelled'),
    ]
    touchpoint = models.ForeignKey(TouchpointTemplate, on_delete=models.CASCADE, related_name='scheduled_sends')
    template = models.ForeignKey(
        'EmailTemplate', on_delete=models.SET_NULL, null=True, blank=True,
        help_text='Optional library template whose content overrides the touchpoint.',
    )
    import_group = models.ForeignKey(ImportGroup, on_delete=models.SET_NULL, null=True, blank=True)
    segment = models.ForeignKey(Segment, on_delete=models.SET_NULL, null=True, blank=True)
    limit = models.IntegerField(default=0, help_text='Max recipients for this run (0 = all eligible)')
    scheduled_for = models.DateTimeField()
    batch_key = models.CharField(
        max_length=40, default='', blank=True,
        help_text='Rows scheduled together (one campaign flow) share a key — shown as one card.',
    )
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='scheduled')
    send_job = models.ForeignKey('SendJob', on_delete=models.SET_NULL, null=True, blank=True, related_name='scheduled_send')
    created_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = 'scheduled_sends'
        ordering = ['scheduled_for']

    def __str__(self):
        return f'TP{self.touchpoint.touchpoint_number} at {self.scheduled_for:%Y-%m-%d %H:%M} ({self.status})'


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
