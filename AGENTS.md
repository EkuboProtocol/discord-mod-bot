# AGENTS.md

## Runtime
- The bot is TypeScript run directly by [Bun](https://bun.sh) — there is no build
  step and no emitted JavaScript. `bun run src/index.ts` is the whole story.
- `.env` is loaded by Bun itself, so there is no `dotenv` dependency.
- Run `bun run typecheck` (`tsc --noEmit`) as well as `bun run lint`. Bun strips
  types without checking them, so the typecheck is the only thing standing
  between you and a type error reaching production.

## Deployment
- DigitalOcean picks the Bun buildpack from `bun.lock` and runs `bun install`
  itself. Do not add a custom `build_command` — that command runs inside the Bun
  buildpack, which has no npm on PATH.
- That buildpack nonetheless insists on *some* build step, so `build` is wired to
  `tsc --noEmit`. There is nothing to compile; the value is that code which does
  not typecheck cannot deploy.
- The live App Platform spec is the source of truth, not `.do/app.yaml`.
  `deploy_on_push` rebuilds source only and never re-reads that file, so the two
  drift. Change the live spec via `doctl apps spec get` → edit → `doctl apps
  update`; starting from the fetched spec preserves the encrypted secrets, which
  applying `.do/app.yaml` verbatim would wipe.

## Tests
- `bun test` (built into Bun, no test framework dependency). Tests live in `test/`.
- `test/setup.ts` is preloaded via `bunfig.toml` to supply placeholder credentials,
  because `src/config.ts` validates and throws at import time.
- Coverage is the pure helpers only: the presence formatters and aggregation in
  `src/presence.ts`, the OpenAI model-family detection in `src/ai.ts`, and the role
  and delete helpers in `src/discord.ts`. The moderation decision logic inside the
  two big handlers is still untested — it cannot be reached without extracting it
  into pure functions first.

## Complexity Policy
- Run `bun run lint` before considering a change done. CI runs it, and the
  typecheck, on every push and pull request.
- The only lint rule is ESLint's `complexity`, capped at 10 per function.
- Three functions are over the limit today and recorded in
  `eslint-suppressions.json`: the two message handlers in `src/discord.ts` (46 and
  37) and `checkMessage` in `src/ai.ts` (15). They are recorded rather than
  refactored because this repo has no tests, and restructuring an untested handler
  for a lint rule is a worse trade than carrying the debt visibly.
- The file is a ratchet, not an amnesty: ESLint stores a per-file count, so a new
  function over the limit fails the build even in a file that already has entries.
  Do not raise a count to make the build pass — split the function. If you simplify
  a recorded one, run `bun run lint:prune` and commit the tightened file.
