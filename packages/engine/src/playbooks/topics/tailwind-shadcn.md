---
title: Tailwind CSS and shadcn/ui with design tokens
summary: Semantic CSS variables, Tailwind v4 @theme, dark mode, shadcn/ui setup, cn() and variants, accessible components.
agents: frontend, ui-ux-design, coder
triggers: tailwind, tailwindcss, shadcn, shadcn/ui, radix, css variables, design tokens, utility css
---
# Tailwind CSS and shadcn/ui with design tokens

## Tokens as CSS variables
Components use semantic names, never raw colors. Define the values once (from design-system.json) and switch them for dark mode:

```css
/* src/index.css (Tailwind v4) */
@import "tailwindcss";

:root {
  --background: oklch(0.99 0 0);
  --foreground: oklch(0.21 0.02 260);
  --muted: oklch(0.96 0.01 260);
  --muted-foreground: oklch(0.50 0.02 260);   /* still 4.5:1 on background */
  --border: oklch(0.90 0.01 260);
  --primary: oklch(0.52 0.15 190);
  --primary-foreground: oklch(0.99 0 0);
  --danger: oklch(0.55 0.20 25);
  --ring: oklch(0.52 0.15 190);
  --radius: 0.5rem;
}
.dark {
  --background: oklch(0.18 0.02 260);
  --foreground: oklch(0.96 0.01 260);
  /* ...every token again, checked for contrast in dark */
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-border: var(--border);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-danger: var(--danger);
  --color-ring: var(--ring);
  --radius-md: var(--radius);
  --font-sans: "Inter Variable", system-ui, sans-serif;
}
@custom-variant dark (&:where(.dark, .dark *));
```
Now `bg-background text-foreground border-border bg-primary text-primary-foreground ring-ring` work as utilities. Tailwind v3 projects put the same mapping in `tailwind.config.js` under `theme.extend.colors` (`primary: "hsl(var(--primary))"` style) with `darkMode: "class"`. Check which major version package.json has before writing config.

## shadcn/ui
shadcn/ui copies component source into your project (it is not a dependency you update blindly):
```
npx shadcn@latest init          # writes components.json, the cn() helper and the CSS variables
npx shadcn@latest add button input label form dialog dropdown-menu table sonner
```
Components are built on Radix primitives (focus management, keyboard support, ARIA) and read the CSS variables above, so theming happens in one place. Edit the copied components to match the design system instead of overriding styles at every use.

## cn() and variants
```ts
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

import { cva, type VariantProps } from "class-variance-authority";
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
  "disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: { primary: "bg-primary text-primary-foreground hover:bg-primary/90",
                 outline: "border border-border bg-background hover:bg-muted",
                 danger: "bg-danger text-white hover:bg-danger/90",
                 ghost: "hover:bg-muted" },
      size: { sm: "h-8 px-3", md: "h-10 px-4", icon: "size-10" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);
```
`twMerge` lets callers override a class safely (`cn(buttonVariants(), className)`).

## Rules that keep it consistent
- Spacing from the scale only (`p-2 p-4 gap-6`), no arbitrary values like `p-[13px]` unless the spec explains why.
- Typography: a few text styles (`text-sm`, `text-base`, `text-lg font-semibold`, `text-2xl font-semibold`) mapped to the type scale; body at 16 px.
- Every interactive element gets `focus-visible:` styles; never remove outlines without a replacement.
- Respect `motion-reduce:` (for example `motion-reduce:transition-none`) for animations.
- Dark mode: toggle the `dark` class on `<html>` from a stored preference, defaulting to `prefers-color-scheme`.
- Right-to-left: use logical utilities (`ms-2`, `me-2`, `ps-4`, `text-start`) instead of `ml`, `mr`, `text-left`.
- Icons from one set (lucide-react) with `aria-hidden` when decorative and a label on icon-only buttons.

## Building screens
Compose pages from the design-system components: `Card`, `Table` with sortable headers, `Dialog` for confirmations ("Delete this booking? This cannot be undone." with the destructive button styled `danger`), `Sonner` toasts for success, inline `FormMessage` for field errors, `Skeleton` for loading. Keep each screen's empty, loading and error states as real components so they are tested and reused.
