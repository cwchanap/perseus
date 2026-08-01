import prettier from 'eslint-config-prettier';
import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

const gitignorePath = fileURLToPath(new URL('./.gitignore', import.meta.url));
const tsconfigRootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node },
			parserOptions: {
				tsconfigRootDir
			}
		},

		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
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
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],

		languageOptions: {
			parserOptions: {
				tsconfigRootDir,
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				svelteConfig
			}
		}
	},
	// Universal guardrail: the virtual gameplay override module may only be
	// imported by `src/lib/services/gameplay/runtime.ts`. This config is placed
	// before the production-source config below so the latter can override it
	// (flat config: last matching config wins for a given rule) and add the
	// concrete-reader restrictions for production files without losing this one.
	{
		files: ['**/*.{js,ts,svelte}'],
		ignores: ['src/lib/services/gameplay/runtime.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					paths: [
						{
							name: 'virtual:perseus-gameplay-runtime-override',
							message:
								'Only src/lib/services/gameplay/runtime.ts may import the virtual gameplay override module'
						}
					]
				}
			]
		}
	},
	// Production-source guardrail: keep the concrete E2E reader and any runtime
	// override module out of the production bundle. Overrides the universal
	// config above for production files (it re-declares the virtual restriction
	// so prod source keeps both blocks). Testing files are exempt so they may
	// import the concrete reader; runtime.ts is exempt for the virtual import.
	{
		files: ['src/**'],
		ignores: ['src/lib/testing/**', 'src/lib/services/gameplay/runtime.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					paths: [
						{
							name: 'virtual:perseus-gameplay-runtime-override',
							message:
								'Only src/lib/services/gameplay/runtime.ts may import the virtual gameplay override module'
						}
					],
					patterns: [
						{
							group: ['**/e2e-gameplay-runtime'],
							message: 'E2E gameplay runtime reader must not be imported from production source'
						},
						{
							group: ['**/*runtime-override*'],
							message: 'Runtime override modules must not be imported from production source'
						}
					]
				}
			]
		}
	}
);
