# AGENTS.md

## Runtime
- The bot is TypeScript run directly by [Bun](https://bun.sh) — there is no build
  step and no emitted JavaScript. `bun run src/index.ts` is the whole story.
- `.env` is loaded by Bun itself, so there is no `dotenv` dependency.
- Run `bun run typecheck` (TypeScript 7, `tsc -b` over every project in
  `tsconfig.json`) as well as `bun run lint` and `bun run format:check`. Bun
  strips types without checking them, so the typecheck is the only thing
  standing between you and a type error reaching production.
- `tsconfig.json` is a solution file: `tsconfig.app.json` covers `src/` and
  `test/`, and `tsconfig.scripts.json` covers `scripts/`. A new directory of
  TypeScript needs a project there, or neither the typecheck nor the type-aware
  lint rules see it correctly.

## Structure
The bot is written with [Effect](https://effect.website) **4.0.0-rc.112**, an
exact pin. The layout follows from one rule: *decisions are pure functions,
effects are the only things that touch the outside world.*

> Effect 4 is a release candidate, not a stable release; npm `latest` is still
> 3.x. The pin is exact on purpose — a caret range would not pick up later RCs
> anyway, and an exact version makes the upgrade to 4.0.0 final a deliberate,
> reviewable change. The v4 API differs substantially from v3, so do not copy
> patterns from v3 documentation or from an LLM's memory of Effect. The
> installed package ships its own guide at `node_modules/effect/AGENTS.md` with
> runnable examples under `node_modules/effect/ai-docs/src/` — read those.

Things that moved in v4 and are easy to get wrong here: services are
`Context.Service` with a static `layer` (not `Effect.Service`); errors are
`Schema.TaggedError` (not `Data.TaggedError`); `Effect.catchAll`/`catchAllCause`
are `Effect.catch`/`Effect.catchCause`; `zipRight` is `andThen`; `forkDaemon` is
`forkDetach`; `Layer.unwrapEffect` is `Layer.unwrap`; `Schema.Literal(a, b)` is
`Schema.Literals([a, b])` and `Schema.Union` likewise takes an array;
`Schema.decodeUnknown` is `Schema.decodeUnknownEffect`; `Either` is `Result`
(`Success`/`Failure`); `LogLevel` is a plain string union (`'Info'`, `'Warn'`).

- `src/moderation.ts` — the decision core. Severity → action, the skip rules,
  the notice and embed text, button-ID parsing. No Discord or OpenAI types, no
  I/O, fully covered by tests.
- `src/ai.ts` — the `Moderator` service. `buildRequest` is pure and tested;
  `check` wraps the OpenAI call and **cannot fail** (see Fail-open below).
- `src/discord.ts` — event handlers as Effects, plus `setupBot`, the single
  adapter between discord.js's callbacks and the Effect runtime. Each event
  calls `runtime.runFork`, where `runtime` is the `ManagedRuntime` built in
  `src/index.ts` — that is the documented v4 bridge to callback APIs.
- `src/presence.ts` — Ekubo stats published as the bot's status, on a repeating
  fiber. All API responses are `Schema`-decoded, never cast.
- `src/config.ts` — `Config` values resolved through a `ConfigProvider` that
  layers CLI flags over the environment over defaults.
- `src/logging.ts` — a `Layer` that routes Effect's logging into winston,
  preserving the documented `logs/` transports.
- `src/errors.ts` — the tagged errors every boundary produces.

### Fail-open is a load-bearing invariant
`Moderator.check` is typed `Effect<ModerationVerdict>` — no error channel. An
OpenAI outage, a timeout, or a malformed completion must all read as "not spam".
Do not "improve" this by letting the error escape: the failure mode is the bot
banning people because a third party was down. `applyAction` degrades the same
way, one rung at a time (ban → timeout → delete only), because a ban the bot
lacks the role hierarchy to perform must still leave an accurate audit trail.

### Shutdown
`ManagedRuntime.dispose()` is what closes the gateway: the client is acquired
with `Effect.acquireRelease`, so disposing the runtime runs the release step.
Do not add a `client.destroy()` to the signal handlers as well.

### Configuration precedence
CLI flag > environment variable > default, expressed once as a
`ConfigProvider.orElse` composition. Do **not** add a yargs `default:` to a
flag — a default makes the flag always present, so it shadows the environment
variable it is only supposed to override. Defaults belong on the `Config` value.

## Deployment
- DigitalOcean picks the Bun buildpack from `bun.lock` and runs `bun install`
  itself. Do not add a custom `build_command` — that command runs inside the Bun
  buildpack, which has no npm on PATH.
- That buildpack nonetheless insists on *some* build step, so `build` is wired to
  the typecheck. There is nothing to compile; the value is that code which does
  not typecheck cannot deploy.
- The live App Platform spec is the source of truth, not `.do/app.yaml`.
  `deploy_on_push` rebuilds source only and never re-reads that file, so the two
  drift. Change the live spec via `doctl apps spec get` → edit → `doctl apps
  update`; starting from the fetched spec preserves the encrypted secrets, which
  applying `.do/app.yaml` verbatim would wipe.

## Tests
- `bun test` (built into Bun, no test framework dependency). Tests live in `test/`.
- Coverage is the decision core and the pure helpers: everything in
  `src/moderation.ts`, request construction and model-family detection in
  `src/ai.ts`, the presence formatters and aggregation, configuration
  precedence, and the Discord helpers.
- `test/setup.ts` still supplies placeholder credentials, but nothing depends on
  it at *import* time any more — configuration resolves inside an Effect, so
  importing any module with an empty environment is safe.
- What is still untested is the glue: `setupBot`'s event wiring and the live
  Discord calls. Keep new logic out of there — if a rule is worth testing, it
  belongs in `src/moderation.ts`.

## Lint and format policy
- Run `bun run lint` and `bun run format:check` before considering a change
  done (`bun run format` fixes formatting). CI runs them, the typecheck and the
  tests on every push and pull request.
- Lint is [oxlint](https://oxc.rs) (`.oxlintrc.json`), run through
  `scripts/lint.ts`. It enforces `complexity`, capped at 10 per function, and
  the type-aware rules from typescript-eslint's recommended-type-checked set
  (such as `no-floating-promises` and `no-misused-promises`), which oxlint runs
  through `oxlint-tsgolint`. Warnings fail too.
- `lint-suppressions.json` records violations that existed when a rule was
  introduced, as file → rule → count. A new violation fails, so does a recorded
  count that is higher than the file needs. No `complexity` violation is
  recorded, and none should be: split the function instead.
- If you fix a recorded violation, run `bun run lint:prune` and commit the
  tightened file. Never raise a count to make the build pass.
- Formatting is [oxfmt](https://oxc.rs) (`.oxfmtrc.json`).
