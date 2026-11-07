---
title: Product briefs, user stories, UX audits and decks
summary: Brief structure, personas, user stories with Given/When/Then, MVP scoping, measurable metrics, Nielsen heuristics checks, pitch deck outline.
agents: project-management, thinking, manager, reasoning, coder
triggers: brief, business, user stories, stories, persona, personas, mvp, scope, requirements, kpi, kpis, roadmap, pitch, deck, ux audit, usability, competitors, market
---
# Product briefs, user stories, UX audits and decks

## brief.md outline
```
# <Product>: brief
## Problem       who suffers, how often, what it costs today
## Users         personas: name, role, goal, frustration, skill level, device
## Value         what changes for each persona; why now
## MVP scope     In: ... Out (later): ...
## User stories  grouped by persona, each with acceptance criteria
## Rules         business rules and constraints (conflicts, limits, privacy, retention)
## Metrics       measurable success signals with targets
## Risks         risk, likelihood, impact, mitigation
## Open questions
```

## Personas that drive features
Always consider: the main end user, the operator (staff, reception, support), the administrator (users, roles, settings), and sometimes an auditor or manager who only reads reports. Each role becomes permissions, screens and stories.

## User stories
```
As a patient I want to book an appointment with a chosen doctor so that I do not have to call the clinic.
Acceptance criteria:
- Given I am signed in, when I pick a free slot and confirm, then the booking appears in "Your bookings" with status Pending.
- Given the slot was taken a moment ago, when I confirm, then I see "This time is already booked" and the slot list refreshes.
- Given I am not signed in, when I try to book, then I am asked to sign in and returned to the booking afterwards.
```
INVEST: independent, negotiable, valuable, estimable, small, testable. Every story has at least one failure or edge case criterion. Stories that hide several features ("manage bookings") get split (create, reschedule, cancel, list and filter).

Stories production systems usually need and briefs often forget: first-run empty state, invite or sign-up, password reset, profile and preferences, admin user and role management, audit history of sensitive changes, export (CSV), notifications, account deletion or data export for privacy, error recovery (what if the network fails mid-action).

## MVP scoping
Keep the smallest set that completes the main loop for each persona end to end. Cut breadth (fewer entities, fewer report types), not quality (auth, validation, tests, accessibility stay). List what is out and why, so it is a decision, not an omission.

## Metrics
Measurable, with a target and a way to measure: "median time to book under 60 s (measured in the end-to-end test)", "0 double bookings (database constraint plus test)", "Lighthouse accessibility 95+ on booking pages", "support calls about bookings down 30% after 3 months". Avoid "users love it".

## UX audit with Nielsen's ten heuristics
Look at real screens (render_screenshot) for the main flows, then score 1 to 5 with evidence and a fix:
1. Visibility of system status: loading indicators, saved confirmations, progress in multi-step flows.
2. Match with the real world: the users' words, not database terms; sensible order of fields.
3. User control and freedom: cancel, back, undo, confirm before destructive actions.
4. Consistency and standards: same component and wording for the same action everywhere.
5. Error prevention: constraints in inputs (date pickers, disabled taken slots), confirmations.
6. Recognition rather than recall: visible options, recent items, helpful defaults.
7. Flexibility and efficiency: keyboard shortcuts, filters, bulk actions for staff.
8. Aesthetic and minimalist design: one primary action per screen, no clutter.
9. Help users recover from errors: plain messages that say what to do; inputs kept.
10. Help and documentation: empty states that teach, short hints, a help link.
Also check accessibility basics (contrast, focus, labels) and the five screen states. Block the release when a main flow cannot be completed or a serious accessibility issue exists.

## Pitch or progress deck (6 to 12 slides)
Title and one-line promise; problem (with a number); who it is for; the solution (real screenshot); how it works (3 steps); what is built (features, status); quality (tests, security score, UX score); roadmap (next 3 items); ask or next decision. One message per slide, real screenshots, no walls of text.
