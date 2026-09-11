import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // 约定：以 `_` 开头的形参/变量表示「有意不使用」（如 textOn(_hex) 统一白色后不再读入参），
    // 交给规则忽略，避免用无意义的 void 语句压制告警
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
  {
    ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "backups/**"],
  },
];

export default eslintConfig;
