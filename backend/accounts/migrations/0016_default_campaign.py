from django.db import migrations


def create_default_campaign(apps, schema_editor):
    """Existing touchpoints predate the group -> campaign hierarchy; attach
    them (and any journey contacts) to a default campaign so nothing is lost."""
    CampaignGroup = apps.get_model('accounts', 'CampaignGroup')
    Campaign = apps.get_model('accounts', 'Campaign')
    TouchpointTemplate = apps.get_model('accounts', 'TouchpointTemplate')
    Contact = apps.get_model('accounts', 'Contact')

    if not TouchpointTemplate.objects.filter(campaign__isnull=True).exists():
        return

    group = CampaignGroup.objects.create(name='My Campaigns')
    campaign = Campaign.objects.create(name='Campaign 1', group=group)
    TouchpointTemplate.objects.filter(campaign__isnull=True).update(campaign=campaign)
    Contact.objects.filter(last_touchpoint__gt=0, last_campaign__isnull=True).update(last_campaign=campaign)


def noop(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0015_campaign_campaigngroup_and_more'),
    ]

    operations = [
        migrations.RunPython(create_default_campaign, noop),
    ]
