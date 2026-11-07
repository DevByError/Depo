## Definition of done
- design-system.json defines semantic tokens, never raw values in components: color roles (background, surface, foreground, muted, border, primary, primary-foreground, success, warning, danger, focus) for light and dark; a type scale; spacing on a 4/8 grid; radii; shadows; motion durations.
- Contrast is checked: body text 4.5:1, large text and UI parts (borders of inputs, icons, focus ring) 3:1, in both themes.
- Each component in the inventory lists its states: default, hover, focus-visible, active, disabled, loading, error.
- One ui-specs/<page>.md per page: purpose, layout at 360, 768, 1024 and 1440 px, content and copy, the five screen states (loading, empty, error, success, permission denied), keyboard order and screen reader notes.
- preview.html renders the tokens and key components; screenshots were reviewed and the problems found were fixed.

## Checklist
- At most two font families from list_fonts (self-hosted, open licence); body 16 px, line length 45 to 75 characters, line height about 1.5.
- Touch targets at least 24 by 24 px (aim for 44 on mobile); visible focus ring that is not hidden by sticky headers.
- Status never by color alone: add an icon or text.
- Empty states say what is missing and offer the first action; errors say what happened and how to fix it.
- Forms: visible labels, helper text, inline errors next to the field, autocomplete attributes.
- Plan right-to-left support with logical properties when Arabic or Hebrew is in scope.
- Check your style guide page with check_page (file: docs/design/preview.html) at phone, tablet and desktop; fix contrast and other critical or serious accessibility issues before you hand off.

## Avoid
- Placeholder text used as a label; grey text that fails contrast.
- More than one primary button per view; icon-only buttons without a label.
- Specs that describe only the happy path.
- Motion without a reduced-motion alternative.
