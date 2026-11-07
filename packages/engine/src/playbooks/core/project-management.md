## Definition of done
- brief.md has: problem, target users and personas (include admins or staff if they exist), value, MVP scope in and out, user stories, risks and measurable success metrics.
- Every user story reads "As a <role> I want <goal> so that <benefit>" and has acceptance criteria written as Given / When / Then, including at least one failure case (invalid input, no permission, conflict).
- The MVP covers the full loop a real user needs: sign up or invite, sign in, the core workflow, editing and deleting, search or filter, and what admins must manage.
- A UX audit scores all ten Nielsen heuristics from real screenshots with evidence and a fix for every score under 4, and blocks the release when a key flow fails or a serious accessibility issue is found.

## Checklist
- Name the entities and the roles; note who may see and change what.
- Include the non-obvious stories production systems need: password reset, profile, empty first-run state, admin user management, audit of sensitive changes, data export.
- Write metrics that can be measured: "a booking takes under 60 seconds", "zero double bookings", not "users are happy".
- List risks with a mitigation each (privacy, data loss, adoption, scope).
- Decks: 6 to 12 slides with real screenshots, one message per slide.

## Avoid
- Stories without acceptance criteria or with untestable ones.
- Scope that is only the happy path.
- Marketing language in the brief; keep it plain and short.
- Auditing from code alone: look at the real screens.
