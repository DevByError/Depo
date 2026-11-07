---
title: Django and Django REST Framework
summary: Custom user model, models with constraints, serializers, viewsets, permissions, pagination, settings from env, OpenAPI, tests.
agents: backend, database, testing, security, coder
triggers: django, drf, django rest framework, djangorestframework, manage.py, wagtail
---
# Django and Django REST Framework

## Start right
- Create a custom user model before the first migration, even if it adds nothing yet: `class User(AbstractUser): pass` and `AUTH_USER_MODEL = "accounts.User"`. Changing it later is painful.
- One app per bounded area (`accounts`, `bookings`, `billing`); thin views, logic in `services.py`, queries in model managers or `selectors.py`.
- Settings from the environment (django-environ or os.environ with defaults for development only): `SECRET_KEY`, `DEBUG`, `ALLOWED_HOSTS`, `DATABASE_URL`. `DEBUG=False` outside development.
- Password hashing with Argon2: install `argon2-cffi` and put `"django.contrib.auth.hashers.Argon2PasswordHasher"` first in `PASSWORD_HASHERS`.

## Models with real constraints
```python
from django.db import models
from django.db.models import Q, UniqueConstraint, CheckConstraint

class Booking(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending"; CONFIRMED = "confirmed"; CANCELLED = "cancelled"

    user = models.ForeignKey("accounts.User", on_delete=models.CASCADE, related_name="bookings")
    doctor = models.ForeignKey("clinic.Doctor", on_delete=models.PROTECT, related_name="bookings")
    starts_at = models.DateTimeField(db_index=True)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.PENDING)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-starts_at", "-id"]
        constraints = [
            UniqueConstraint(fields=["doctor", "starts_at"], condition=~Q(status="cancelled"), name="uniq_active_slot"),
            CheckConstraint(condition=Q(status__in=["pending", "confirmed", "cancelled"]), name="booking_status_valid"),
        ]
        indexes = [models.Index(fields=["user", "-starts_at"])]
```
(`CheckConstraint(condition=...)` is the Django 5.1+ name; older versions use `check=`.) Set `USE_TZ = True` so datetimes are stored in UTC. Run `python manage.py makemigrations` then `python manage.py migrate`, and read the generated migration.

## Serializers and validation
```python
from rest_framework import serializers

class BookingSerializer(serializers.ModelSerializer):
    class Meta:
        model = Booking
        fields = ["id", "doctor", "starts_at", "status", "created_at"]
        read_only_fields = ["id", "status", "created_at"]   # clients cannot set these

    def validate_starts_at(self, value):
        if value <= timezone.now():
            raise serializers.ValidationError("Choose a time in the future.")
        return value
```
Explicit `fields` lists prevent mass assignment; never use `fields = "__all__"` on models with sensitive columns.

## Views, routers, permissions
```python
from rest_framework import permissions, viewsets

class IsOwner(permissions.BasePermission):
    def has_object_permission(self, request, view, obj):
        return obj.user_id == request.user.id

class BookingViewSet(viewsets.ModelViewSet):
    serializer_class = BookingSerializer
    permission_classes = [permissions.IsAuthenticated, IsOwner]

    def get_queryset(self):
        # scope by owner here: object permissions are not applied to list views
        return Booking.objects.filter(user=self.request.user).select_related("doctor")

    def perform_create(self, serializer):
        serializer.save(user=self.request.user)
```
`router = DefaultRouter(); router.register("bookings", BookingViewSet, basename="booking")`. Role checks: Django groups and permissions (`user.has_perm("bookings.change_booking")`) or a custom permission class that reads your role model. Catch `IntegrityError` from the unique constraint and return 409 (raise a custom `APIException` with `status_code = 409`).

## Settings for DRF
```python
REST_FRAMEWORK = {
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],   # deny by default
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.LimitOffsetPagination",
    "PAGE_SIZE": 20,
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "DEFAULT_THROTTLE_CLASSES": ["rest_framework.throttling.AnonRateThrottle", "rest_framework.throttling.UserRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {"anon": "30/min", "user": "300/min"},
}
```
Set `max_limit` on a LimitOffsetPagination subclass to cap page size. OpenAPI with drf-spectacular: `path("api/schema/", SpectacularAPIView.as_view())`, `path("api/docs/", SpectacularSwaggerView.as_view(url_name="schema"))`.

## Auth
Same-origin SPA: Django session auth with CSRF (send the `csrftoken` cookie value in `X-CSRFToken`). Separate frontend or mobile: djangorestframework-simplejwt with short access lifetimes, `ROTATE_REFRESH_TOKENS = True` and `BLACKLIST_AFTER_ROTATION = True` (add the token_blacklist app). Use `django-cors-headers` with an explicit `CORS_ALLOWED_ORIGINS` list.

## Performance
`select_related` for foreign keys, `prefetch_related` for reverse and many-to-many; `only()` for wide tables; check query counts in tests with `django_assert_num_queries` (pytest-django) or `assertNumQueries`.

## Tests
```python
import pytest
from rest_framework.test import APIClient

@pytest.mark.django_db
def test_user_cannot_see_others_bookings(user_factory, booking_factory):
    me, other = user_factory(), user_factory()
    booking_factory(user=other)
    client = APIClient(); client.force_authenticate(me)
    r = client.get("/api/bookings/")
    assert r.status_code == 200 and r.json()["count"] == 0
```
Use pytest-django and factory_boy; run `python manage.py check --deploy` before release.
