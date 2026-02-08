import js from '@eslint/js';
import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

const gitignorePath = fileURLToPath(new URL('../../.gitignore', import.meta.url));
const tsconfigRootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	...ts.configs.recommended,
	prettier,
	{
		languageOptions: {
			globals: { ...globals.node },
			parserOptions: {
				tsconfigRootDir
			}
		},
		rules: {
			'no-undef': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_'
				}
			]
		}
	}
);
