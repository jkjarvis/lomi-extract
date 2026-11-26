// Shared flat ESLint config for every workspace package.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export function config({ browser = false } = {}) {
  return tseslint.config(
    { ignores: ['dist/**', 'coverage/**', 'node_modules/**', '**/*.d.ts'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      languageOptions: {
        globals: browser ? { ...globals.browser } : { ...globals.node },
      },
      rules: {
        '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        '@typescript-eslint/consistent-type-imports': 'error',
        'no-console': 'off',
        eqeqeq: ['error', 'smart'],
      },
    },
  );
}

export default config();
