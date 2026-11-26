import { config } from '@lomi/config/eslint';

// Black-box tests poke at JSON responses; `any` keeps them readable.
export default [...config(), { rules: { '@typescript-eslint/no-explicit-any': 'off' } }];
