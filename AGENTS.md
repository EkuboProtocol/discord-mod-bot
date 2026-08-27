# AGENTS.md

## Complexity Policy
- Run `npm run lint` before considering a change done. CI runs it on every push and
  pull request.
- The only rule is ESLint's `complexity`, capped at 10 per function.
- Three functions are over the limit today and recorded in
  `eslint-suppressions.json`: the two message handlers in `src/discord.js` (45 and
  26) and `checkMessage` in `src/ai.js` (12). They are recorded rather than
  refactored because this repo has no tests, and restructuring an untested handler
  for a lint rule is a worse trade than carrying the debt visibly.
- The file is a ratchet, not an amnesty: ESLint stores a per-file count, so a new
  function over the limit fails the build even in a file that already has entries.
  Do not raise a count to make the build pass — split the function. If you simplify
  a recorded one, run `npm run lint:prune` and commit the tightened file.
