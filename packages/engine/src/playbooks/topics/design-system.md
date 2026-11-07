---
title: Design systems and page specifications
summary: design-system.json structure, color roles and contrast, type scale, spacing, components with states, page spec template, content rules, RTL.
agents: ui-ux-design, frontend, project-management, coder
triggers: design system, design, ui, ux, tokens, style guide, branding, theme, figma, wireframe, layout, mockup
---
# Design systems and page specifications

## design-system.json
```json
{
  "name": "Clinic",
  "color": {
    "light": { "background": "#FFFFFF", "surface": "#F6F7F9", "foreground": "#161A23", "muted": "#5B6474",
               "border": "#D9DDE3", "primary": "#0F766E", "primaryForeground": "#FFFFFF",
               "success": "#15803D", "warning": "#B45309", "danger": "#B91C1C", "focus": "#0F766E" },
    "dark":  { "background": "#11151C", "surface": "#181D26", "foreground": "#EEF1F5", "muted": "#A3ACBA",
               "border": "#2B3240", "primary": "#2DD4BF", "primaryForeground": "#0B1416",
               "success": "#4ADE80", "warning": "#FBBF24", "danger": "#F87171", "focus": "#2DD4BF" }
  },
  "typography": {
    "fontFamilies": { "sans": "Inter", "mono": "JetBrains Mono" },
    "scale": { "xs": 12, "sm": 14, "base": 16, "lg": 20, "xl": 25, "2xl": 31, "3xl": 39 },
    "lineHeight": { "tight": 1.25, "normal": 1.5 },
    "weights": { "regular": 400, "medium": 500, "semibold": 600 }
  },
  "spacing": [0, 4, 8, 12, 16, 24, 32, 48, 64],
  "radius": { "sm": 4, "md": 8, "lg": 12, "full": 9999 },
  "shadow": { "sm": "0 1px 2px rgba(0,0,0,.06)", "md": "0 4px 12px rgba(0,0,0,.08)" },
  "motion": { "fast": "120ms", "normal": "200ms", "easing": "cubic-bezier(.2,.8,.2,1)" },
  "breakpoints": { "sm": 360, "md": 768, "lg": 1024, "xl": 1440 },
  "components": ["Button", "IconButton", "Input", "Select", "Checkbox", "DatePicker", "Table", "Pagination",
                 "Card", "Dialog", "Toast", "Tabs", "Badge", "Avatar", "EmptyState", "ErrorState", "Skeleton", "Nav"]
}
```
The type scale above is a 1.25 ratio from 16 px. Spacing follows the 4 and 8 point grid.

## Color rules
- Roles, not hues: components ask for `primary`, `danger`, `muted`; the theme decides the hex.
- Contrast (WCAG 2.2 AA): normal text 4.5:1, large text (24 px, or 18.66 px bold) 3:1, UI parts and focus indicators 3:1 against neighbours. Check foreground on background, muted on background, primaryForeground on primary, and every status color on surface, in both themes.
- One accent color for primary actions; status colors only for status.
- Never color alone: errors get an icon and text, chart series get labels or patterns.

## Components and states
For each component write: anatomy, sizes, variants, and states: default, hover, focus-visible, active, disabled, loading, error, selected where relevant. Specify keyboard behaviour (Tab, Enter, Space, Escape, arrow keys for menus and tabs) and the accessible name. Example: "IconButton: always has aria-label; 40 px square; focus ring 2 px focus color with 2 px offset".

## Page specification template (ui-specs/<page>.md)
```
# Bookings list
Purpose: patients see and manage their upcoming bookings.
Who: patient (own bookings), reception (all bookings for today).
Layout:
- 360: single column, cards, sticky "New booking" button at the bottom.
- 768: two-column cards; filters in a sheet.
- 1024+: table with columns Date, Doctor, Status, Actions; filters in a left rail.
- 1440: max content width 1200 px, centered.
Content: title "Your bookings"; columns...; actions Cancel (confirm dialog), Reschedule.
States:
- Loading: 5 skeleton rows.
- Empty: "No bookings yet" + "Book an appointment" button.
- Error: "We could not load your bookings." + Retry.
- Success: toast "Booking cancelled".
- Permission denied: "You do not have access to this page." + link home.
Accessibility: h1 "Your bookings"; table has caption; status uses text + icon; focus returns to the row after closing the dialog.
```

## Content rules
Plain words, sentence case, verbs on buttons ("Save booking", not "Submit"). Errors say what happened and what to do ("This time is already booked. Pick another time."). Confirmations name the object and the consequence. Avoid jargon, exclamation marks and blame.

## Typography and layout
At most two families (one sans, optionally one mono or display), self-hosted with an open licence (Inter, IBM Plex Sans, Source Sans 3, Noto Sans; Noto Sans Arabic or IBM Plex Sans Arabic for Arabic). Body 16 px, line length 45 to 75 characters, clear hierarchy with size and weight rather than color. Align to a grid; group related controls; one primary action per view.

## Right-to-left
When Arabic, Hebrew or Persian is in scope: `dir="rtl"` on the root, logical CSS properties (`margin-inline-start`, `padding-inline`, `text-align: start`), mirrored directional icons (arrows, chevrons) but not logos or media controls, numbers and dates localised with `Intl`.

## Reviewing designs
Render preview.html and key pages at 360, 768, 1024 and 1440 px, then check: hierarchy obvious in 5 seconds, contrast passes, focus visible, touch targets at least 24 px (44 on mobile), nothing overflows, every state exists.
