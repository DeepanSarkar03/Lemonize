/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  env: { node: true, es2022: true, browser: true },
  ignorePatterns: ['dist', '.next', 'node_modules', '*.config.*', 'coverage', '.fuse_hidden*'],
  rules: {
    // TypeScript performs undefined-variable analysis; no-undef is redundant and
    // misfires on TS/JSX globals, so it is disabled per common TS ESLint guidance.
    'no-undef': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-console': 'off',
  },
};
