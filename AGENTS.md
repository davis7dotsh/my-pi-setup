When working in typescript:

- default to bun as the package manager, but respect what an existing project uses even if it's not bun
- when adding a package to a project add it with an install command, instead of manually editing the package json
- run check/format/lint commands when your done making a change. if they don't exist, suggest making them for the project you're in
- avoid explicit return types unless absolutely needed
- `as any` should be an absolute last resort. always use real type safety. lean on type inference instead of manually writing new types over and over again
- avoid running `dev` or `build` commands. if you really need to, ask first

When working in svelte(kit):

- use modern svelte practices, reference the svelte best practicies skill when writing .svelte file code

In general:

- when asking sets of questions, always include numbers so it's easy for me to clearly answer
