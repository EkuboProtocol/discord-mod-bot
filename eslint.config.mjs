// Complexity gate only. This is deliberately not a general-purpose lint setup:
// the single rule here is a guardrail against functions growing unreviewably
// branchy, and keeping the config to one rule means a failure is always
// actionable and never a style argument.
const rules = { complexity: ["error", 10] };

export default [
  {
    ignores: ["node_modules/**"],
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        process: "readonly",
        console: "readonly",
        __dirname: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
      },
    },
    rules,
  },
];
