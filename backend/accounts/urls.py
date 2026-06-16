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
    path("contacts/export/", views.contacts_export_csv, name="contacts_export"),
    path("segments/create/", views.segments_create, name="segments_create"),
    path("segments/update/", views.segments_update, name="segments_update"),

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

    # Bulk send / progress
    path("send/start/", views.send_bulk_start, name="send_bulk_start"),
    path("send/eligible-count/", views.send_eligible_count, name="send_eligible_count"),
    path("send/progress/", views.send_job_progress, name="send_job_progress"),
    path("send/cancel/", views.send_job_cancel, name="send_job_cancel"),
    path("send/check-bounces/", views.check_bounces, name="check_bounces"),

    # SES bounce/complaint webhook (called by AWS SNS)
    path("ses/webhook/", views.ses_bounce_webhook, name="ses_bounce_webhook"),
]
