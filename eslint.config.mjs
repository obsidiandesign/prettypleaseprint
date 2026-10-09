// ESLint, flat config. Run by `npm run lint` and the `guard` job in CI.
//
// `next/core-web-vitals` is the React/Next rule set (hooks, <img>, links) and
// `next/typescript` adds typescript-eslint's recommended rules. Typechecking
// itself stays with `tsc --noEmit`; this catches what the compiler accepts but
// is wrong: a hook called conditionally, an unused import, a stray `any`.
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const config = [
  {
    ignores: [".next/**", "node_modules/**", "Pretty Please Print/**", "public/**", "next-env.d.ts", "docs/**"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
