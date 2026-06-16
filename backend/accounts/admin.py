from django.contrib import admin

from .models import TouchpointTemplate, UserProfile, OTP, ImportGroup, Contact, SendJob, SendLog, SavedTestEmail


@admin.register(TouchpointTemplate)
class TouchpointTemplateAdmin(admin.ModelAdmin):
    list_display = ('touchpoint_number', 'subject', 'updated_at')
    ordering = ('touchpoint_number',)


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ('user', 'role', 'created_at')
    list_filter = ('role',)


@admin.register(OTP)
class OTPAdmin(admin.ModelAdmin):
    list_display = ('user', 'code', 'purpose', 'is_used', 'created_at', 'expires_at')
    list_filter = ('purpose', 'is_used')


@admin.register(ImportGroup)
class ImportGroupAdmin(admin.ModelAdmin):
    list_display = ('name', 'created_at')


@admin.register(Contact)
class ContactAdmin(admin.ModelAdmin):
    list_display = ('org_name', 'contact_name', 'email', 'status', 'last_touchpoint', 'import_group')
    list_filter = ('status', 'import_group')
    search_fields = ('org_name', 'contact_name', 'email')


@admin.register(SendJob)
class SendJobAdmin(admin.ModelAdmin):
    list_display = ('id', 'touchpoint', 'status', 'total_recipients', 'sent_count', 'failed_count', 'created_at')
    list_filter = ('status',)


@admin.register(SendLog)
class SendLogAdmin(admin.ModelAdmin):
    list_display = ('contact', 'job', 'status', 'sent_at')
    list_filter = ('status',)


@admin.register(SavedTestEmail)
class SavedTestEmailAdmin(admin.ModelAdmin):
    list_display = ('email', 'added_by', 'created_at')
