from django.urls import path

from . import views

urlpatterns = [
    # Auth
    path("login/", views.login_view, name="login"),
    path("logout/", views.logout_view, name="logout"),
    path("health/", views.health_check, name="health"),

    # Auth - OTP & password
    path("auth/verify-otp/", views.verify_otp, name="verify_otp"),
    path("auth/resend-otp/", views.resend_otp, name="resend_otp"),
    path("auth/forgot-password/", views.forgot_password, name="forgot_password"),
    path("auth/reset-password/", views.reset_password, name="reset_password"),
    path("auth/set-password/", views.set_password, name="set_password"),
    path("auth/me/", views.me, name="me"),

    # User management (admin only)
    path("users/", views.users_list, name="users_list"),
    path("users/create/", views.users_create, name="users_create"),
    path("users/update/", views.users_update, name="users_update"),
    path("users/delete/", views.users_delete, name="users_delete"),
    path("users/resend-setup/", views.resend_setup_otp, name="resend_setup_otp"),

    # Email templates
    path("email-templates/", views.email_templates_list, name="email_templates"),
    path("email-templates/save/", views.email_template_save, name="email_template_save"),
    path("email-templates/send-test/", views.send_test_email, name="send_test_email"),
    path("email-templates/test-emails/", views.saved_test_emails_list, name="saved_test_emails"),
    path("email-templates/test-emails/save/", views.saved_test_emails_save, name="saved_test_emails_save"),
    path("email-templates/set-schedule/", views.set_touchpoint_schedule, name="set_touchpoint_schedule"),
    path("email-templates/get-schedules/", views.get_touchpoint_schedules, name="get_touchpoint_schedules"),

    # Contacts / database
    # Public opt-out (unsubscribe) link target — no auth
    path("optout/<str:token>/", views.optout_confirm, name="optout_confirm"),

    path("contacts/", views.contacts_list, name="contacts_list"),
    path("contacts/create/", views.contacts_create, name="contacts_create"),
    path("contacts/update/", views.contacts_update, name="contacts_update"),
    path("contacts/bulk-update/", views.contacts_bulk_update, name="contacts_bulk_update"),
    path("contacts/delete/", views.contacts_delete, name="contacts_delete"),
    path("contacts/import/", views.contacts_import_csv, name="contacts_import"),
    path("contacts/import/preview/", views.contacts_import_preview, name="contacts_import_preview"),
    path("contacts/export/", views.contacts_export_csv, name="contacts_export"),
    path("segments/create/", views.segments_create, name="segments_create"),
    path("segments/update/", views.segments_update, name="segments_update"),

    # Opt-out pending approvals + reactivation history
    path("contacts/pending-approvals/", views.pending_approvals_list, name="pending_approvals_list"),
    path("contacts/pending-approvals/count/", views.pending_approvals_count, name="pending_approvals_count"),
    path("contacts/pending-approvals/decide/", views.pending_approvals_decide, name="pending_approvals_decide"),
    path("contacts/reactivation-history/", views.reactivation_history, name="reactivation_history"),

    # Custom contact fields
    path("contacts/custom-fields/", views.custom_fields_list, name="custom_fields_list"),
    path("contacts/custom-fields/create/", views.custom_fields_create, name="custom_fields_create"),
    path("contacts/custom-fields/delete/", views.custom_fields_delete, name="custom_fields_delete"),

    # Campaign groups & campaigns (group → campaign → flow)
    path("campaign-groups/", views.campaign_groups_list, name="campaign_groups_list"),
    path("campaign-groups/create/", views.campaign_groups_create, name="campaign_groups_create"),
    path("campaign-groups/update/", views.campaign_groups_update, name="campaign_groups_update"),
    path("campaign-groups/delete/", views.campaign_groups_delete, name="campaign_groups_delete"),
    path("campaigns/", views.campaigns_list, name="campaigns_list"),
    path("campaigns/detail/", views.campaigns_detail, name="campaigns_detail"),
    path("campaigns/create/", views.campaigns_create, name="campaigns_create"),
    path("campaigns/update/", views.campaigns_update, name="campaigns_update"),
    path("campaigns/delete/", views.campaigns_delete, name="campaigns_delete"),

    # Campaign flow board, goodbyes, flow templates
    path("flow/board/", views.flow_board, name="flow_board"),
    path("flow/wait/save/", views.flow_wait_save, name="flow_wait_save"),
    path("flow/touchpoint/clear/", views.flow_touchpoint_clear, name="flow_touchpoint_clear"),
    path("flow/touchpoint/add/", views.flow_touchpoint_add, name="flow_touchpoint_add"),
    path("flow/touchpoint/delete/", views.flow_touchpoint_delete, name="flow_touchpoint_delete"),
    path("flow/goodbye/", views.goodbye_get, name="goodbye_get"),
    path("flow/goodbye/save/", views.goodbye_save, name="goodbye_save"),
    path("flow/goodbye/delete/", views.goodbye_delete, name="goodbye_delete"),
    path("flow/templates/", views.flow_templates_list, name="flow_templates_list"),
    path("flow/templates/save/", views.flow_templates_save, name="flow_templates_save"),
    path("flow/templates/apply/", views.flow_templates_apply, name="flow_templates_apply"),
    path("flow/templates/delete/", views.flow_templates_delete, name="flow_templates_delete"),

    # Scheduled sends ('Coming up')
    path("schedules/", views.schedules_list, name="schedules_list"),
    path("schedules/schedule-campaign/", views.schedules_schedule_campaign, name="schedules_schedule_campaign"),
    path("schedules/batch/run-now/", views.schedules_batch_run_now, name="schedules_batch_run_now"),
    path("schedules/batch/edit/", views.schedules_batch_edit, name="schedules_batch_edit"),
    path("schedules/batch/cancel/", views.schedules_batch_cancel, name="schedules_batch_cancel"),
    path("schedules/create/", views.schedules_create, name="schedules_create"),
    path("schedules/update/", views.schedules_update, name="schedules_update"),
    path("schedules/cancel/", views.schedules_cancel, name="schedules_cancel"),
    path("schedules/run-now/", views.schedules_run_now, name="schedules_run_now"),

    # Reusable template library
    path("templates-library/", views.templates_library_list, name="templates_library_list"),
    path("templates-library/save/", views.templates_library_save, name="templates_library_save"),
    path("templates-library/delete/", views.templates_library_delete, name="templates_library_delete"),
    path("templates-library/send-test/", views.templates_library_send_test, name="templates_library_send_test"),

    # User stats (admin)
    path("users/stats/", views.user_stats, name="user_stats"),

    # Reporting
    path("reporting/stats/", views.reporting_stats, name="reporting_stats"),
    path("reporting/drilldown/", views.reporting_drilldown, name="reporting_drilldown"),
    path("reporting/touchpoint/", views.reporting_touchpoint, name="reporting_touchpoint"),

    # Bulk send / progress
    path("send/start/", views.send_bulk_start, name="send_bulk_start"),
    path("send/eligible-count/", views.send_eligible_count, name="send_eligible_count"),
    path("send/progress/", views.send_job_progress, name="send_job_progress"),
    path("send/report/", views.send_job_report, name="send_job_report"),
    path("send/cancel/", views.send_job_cancel, name="send_job_cancel"),
    path("send/check-bounces/", views.check_bounces, name="check_bounces"),

    # SES bounce/complaint webhook (called by AWS SNS)
    path("ses/webhook/", views.ses_bounce_webhook, name="ses_bounce_webhook"),
]
