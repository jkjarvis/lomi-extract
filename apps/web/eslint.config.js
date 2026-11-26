import reactHooks from 'eslint-plugin-react-hooks';
import { config } from '@lomi/config/eslint';

export default [
  ...config({ browser: true }),
  {
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
];
