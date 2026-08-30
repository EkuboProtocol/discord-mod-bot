// Complexity gate only. This is deliberately not a general-purpose lint setup:
// the single rule here is a guardrail against functions growing unreviewably
// branchy, and keeping the config to one rule means a failure is always
// actionable and never a style argument.
//
// Type errors are not this file's job — `bun run typecheck` (tsc --noEmit) is
// the gate for those, so the parser here is only used to read TypeScript syntax.
import tseslint from "typescript-eslint";

const rules = { complexity: ["error", 10] };

export default [
  {
    ignores: ["node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules,
  },
];
