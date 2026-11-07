---
title: Production baseline for new systems
summary: What a real system needs beyond the happy path, derived from user stories, with testable criteria.
agents: manager, thinking, project-management, reasoning, backend, frontend, coder
triggers: system, app, application, platform, portal, dashboard, saas, mvp, full system, production, booking, management system, crm, erp, marketplace, store, shop
when: new
---
# Production baseline for new systems

A demo shows the happy path. A production system survives real users: wrong input, two people at once, forgotten passwords, admins who need control, and a developer who must run it tomorrow. Plan and build the baseline below unless the user explicitly asks for less.

## Derive features from the stories
Read each user story and ask, for every noun (entity) and every role:

- **Entities**: create, read, update, delete; list with pagination, search, filters and sorting; validation rules; who owns a record; what happens on delete (cascade, restrict, soft delete); which fields are unique.
- **Roles**: how a user gets an account (sign-up, invite, admin creates it); sign in and out; password reset; profile; what each role may see and change.
- **Rules**: conflicts (double booking, overselling), limits (max per day), state machines (pending, confirmed, cancelled), time zones, money.
- **Admins**: if the words admin, staff, manager, moderator, owner, role or permission appear, the system needs roles and permissions, an admin screen to manage users and roles, and an audit log of sensitive changes.

## The baseline checklist
| Area | Required | Testable criterion example |
|---|---|---|
| Auth (when users exist) | Register or invite, login, logout, refresh or session expiry, password reset, Argon2id hashing, login rate limit | "POST /auth/login with a wrong password returns 401 with a generic message; the 6th attempt in a minute returns 429" |
| Roles (when admins exist) | Roles and permissions, deny by default, admin UI, audit of permission changes | "A member calling DELETE /users/{id} gets 403; an admin gets 204 and an audit row is written" |
| Validation | Schema at every input, field-level errors in one format | "POST /bookings without a date returns 422 listing the date field" |
| Errors | One error format, no stack traces, 404 and 409 used correctly | "Booking an already booked slot returns 409" |
| Lists | Pagination with a capped limit, filters, sorting, stable order | "GET /bookings?limit=500 returns at most 100 items and a total" |
| Data | Constraints in the database, indexes for filters, migrations, seed data | "alembic upgrade head on an empty database succeeds; seed creates 1 admin and 20 bookings" |
| API docs | OpenAPI 3.1 served by the app | "GET /openapi.json lists every route" |
| UI | Loading, empty, error, success and permission-denied states; responsive 360 to 1440 px; keyboard and screen reader friendly | "With no bookings the list shows an empty state with a New booking button" |
| Tests | Unit for rules, API tests per route, one end-to-end test per main story | "pytest passes with tests for login, booking conflict and admin-only routes" |
| Run | README, .env.example, run.cmd and run.sh that start everything | "run.cmd on a fresh clone starts the API and UI" |
| Ops | Health endpoint, structured logs without secrets, config from environment | "GET /health returns 200 with the database status" |

## Basic versus advanced: an example
Request: "a clinic booking system with an admin".

- Basic (not acceptable): a bookings table, a form, a list of all bookings, no login.
- Advanced (the bar): patients register and sign in; doctors have weekly availability; the database prevents overlapping appointments for a doctor (exclusion constraint or a unique slot key) and the API returns 409 on conflict; patients see only their own bookings; reception staff see the day calendar; admins manage doctors, staff accounts and roles; cancelling records who and when; times are stored in UTC and shown in the clinic's zone; lists are paginated and filterable by doctor and date; seed data includes demo doctors, a demo admin and a week of bookings; tests cover login, conflict, ownership and admin-only routes; README and run.cmd start it with one command.

## Writing criteria
Good criteria name an observable result: a command that passes, an endpoint and status code, a file and its content, a screen state. Five sharp criteria beat fifteen vague ones. Avoid "works correctly", "is secure", "looks good".

## Suggested extras (offer, do not force)
CSV export, email notifications (local SMTP catcher in development), search, soft delete and restore, activity history, dark mode, two-factor sign-in, API keys for integrations. Rank them by value for the stories and effort.
