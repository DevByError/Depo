---
title: Accessibility to WCAG 2.2 AA
summary: The success criteria that fail most often, semantic HTML, forms, focus, dialogs, live regions, motion, and how to test with axe, keyboard and NVDA.
agents: frontend, ui-ux-design, project-management, testing, coder
triggers: accessibility, accessible, a11y, wcag, screen reader, keyboard, aria, contrast, nvda, voiceover, focus
---
# Accessibility to WCAG 2.2 AA

## Criteria that fail most often
| Criterion | Requirement | Typical fix |
|---|---|---|
| 1.1.1 Non-text content | Images and icons have text alternatives | `alt` describing purpose; `alt=""` for decoration; `aria-label` on icon-only buttons |
| 1.3.1 Info and relationships | Structure is in the markup | headings in order, lists, `<table>` with `<th scope>`, labels tied to inputs |
| 1.3.5 Identify input purpose | Common fields declare purpose | `autocomplete="email"`, `"name"`, `"current-password"`, `"new-password"` |
| 1.4.3 / 1.4.11 Contrast | Text 4.5:1 (large 3:1); UI parts and focus 3:1 | adjust tokens, test both themes |
| 1.4.10 Reflow | Usable at 320 CSS px wide / 400% zoom | responsive layout, no fixed widths, wrap long words |
| 2.1.1 Keyboard | Everything works with the keyboard | real `<button>` and `<a href>`, no click-only divs |
| 2.4.3 Focus order / 2.4.7 Focus visible | Logical order, always visible | DOM order matches visual order; `:focus-visible` ring |
| 2.4.11 Focus not obscured (new in 2.2) | Focused element not hidden by sticky bars | `scroll-padding-top` equal to the sticky header height |
| 2.5.7 Dragging (new) | Drag actions have a single-pointer alternative | buttons to move items, not drag only |
| 2.5.8 Target size (new) | Targets at least 24 by 24 CSS px (or spaced) | min height and width on small controls |
| 3.3.1 / 3.3.3 Errors | Errors identified in text with a suggestion | message next to the field, linked with `aria-describedby` |
| 3.3.7 Redundant entry (new) | Do not ask for the same data twice in a flow | prefill or offer "same as above" |
| 3.3.8 Accessible authentication (new) | No memory or puzzle tests to sign in | allow paste and password managers, offer email links or passkeys |
| 4.1.2 Name, role, value | Custom widgets expose them | prefer native elements; otherwise correct ARIA roles and states |

## Semantic structure
```html
<html lang="en">
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header>…<nav aria-label="Main">…</nav></header>
  <main id="main" tabindex="-1"><h1>Your bookings</h1>…</main>
  <footer>…</footer>
</body>
```
One `h1` per page, then `h2`, `h3` without skipping. Landmarks let screen reader users jump around. Use native elements first; ARIA only fills gaps ("no ARIA is better than bad ARIA").

## Forms
```html
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required
       aria-invalid="true" aria-describedby="email-hint email-error">
<p id="email-hint">We send the confirmation here.</p>
<p id="email-error">Enter an email address like name@example.com.</p>
```
Visible labels (placeholders disappear and fail contrast), group radios with `<fieldset><legend>`, mark required fields in text, on submit with errors move focus to an error summary or the first invalid field, never clear what the user typed.

## Focus, dialogs and dynamic content
- Dialogs: use `<dialog>` with `showModal()` or a tested primitive (Radix, React Aria, Headless UI): focus moves into the dialog, Tab stays inside, Escape closes, focus returns to the trigger, the dialog has an accessible name (`aria-labelledby` on the title).
- After client-side navigation move focus to the new page's `h1` (or main) and update `document.title`.
- Announce async results without moving focus: `<div role="status" aria-live="polite">Booking saved</div>`; use `role="alert"` only for urgent errors.
- Loading: `aria-busy="true"` on the region; skeletons are hidden from screen readers (`aria-hidden`) with a visually hidden "Loading bookings" text.
- Menus, tabs and comboboxes need arrow-key support: use a library that implements the ARIA Authoring Practices.

## Motion, color and media
Respect `prefers-reduced-motion` (disable parallax, large transitions, autoplay). Never use color alone for meaning. Captions for video, transcripts for audio. Nothing flashes more than three times per second.

## Testing
1. Automated: axe-core in unit or end-to-end tests (`@axe-core/playwright`, `vitest-axe`, `jest-axe`) on every page and state; Lighthouse accessibility 90+ is a floor, not proof.
2. Keyboard only: Tab through every page; can you reach, see and operate everything? Can you escape every dialog and menu?
3. Screen reader smoke test: NVDA (free, Windows) with Firefox or Chrome, or Narrator; on macOS and iOS, VoiceOver; on Android, TalkBack. Check page title, headings list, form labels, error announcements and status messages.
4. Zoom to 200% and 400%, and narrow to 320 px: no lost content or horizontal scrolling.
Record failures with the criterion number, the element and the fix.
