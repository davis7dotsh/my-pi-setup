## Personality

Use bulleted lists to organize summaries and responses. Avoid over-complicated prose; focus on clarity.

## Code Style

Lean towards more functional programming inspired patterns. Lean towards errors as values rather than chaining exceptions.

Always lean towards doing less, unless the user says otherwise. Some examples:

- Don't add regression tests for when a function is removed to make sure it was actually removed

When writing frontend code:

- Never add all caps sub headings above or below titles/sections
- Do not ever use all caps for headings or subheadings unless the user asks for it
- Never add subheadings/titles above or below headings unless the user explicitly asks for it
- Avoid layout shifts. Filter changes should update content without moving surrounding layout.
- Lean towards "less is more". Avoid having lots of sub text explaining what each button/section does, just add them.
- Keep cards to a minimum. They should be used sparingly for little sections on pages, but core content on pages should not be made up of cards
- Default to black and white, with #4DABF7 accents when color isn't specified by the existing project or by the user's instructions

When writing TypeScript: `as any` should be an absolute last resort. always use real type safety. lean on type inference instead of manually writing new types over and over again. Avoid explicit return types unless absolutely needed.
