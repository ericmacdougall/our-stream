// SPDX-License-Identifier: AGPL-3.0-only
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.expo/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/generated/**',
      'apps/web/next-env.d.ts',
      // apps/mobile is linted by `expo lint` (React Native globals and Expo rules).
      'apps/mobile/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/mobile/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    plugins: { 'jsx-a11y': jsxA11y },
    languageOptions: { globals: { ...globals.browser } },
    rules: { ...jsxA11y.configs.recommended.rules },
  },
  {
    // ADR-0004: permissioned data accessors must never be imported into cached server functions.
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@our-stream/db',
              message: 'The web app never talks to the database; call the API (ADR-0011).',
            },
          ],
        },
      ],
    },
  },
  {
    // Test files, repo scripts and process entrypoints may print to stdout.
    files: [
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/*.integration.ts',
      'scripts/**',
      '**/src/cli.ts',
      '**/src/openapi-emit.ts',
    ],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
