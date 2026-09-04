import { NativeScriptConfig } from '@nativescript/core';

export default {
	id: 'org.perseus.mobile',
	appPath: 'app',
	appResourcesPath: 'App_Resources',
	// Use the repo package manager directly. bun installs workspace deps as
	// hoisted symlinks under the root node_modules, which NS's webpack bundler
	// resolves fine. (NS only drops --preserve-symlinks for pnpm, but that flag
	// is harmless with bun's hoisted layout — symlinks resolve from node_modules
	// where the deps actually live.)
	// 'bun' is runtime-supported by the NS 9.1 CLI but not yet in the
	// @nativescript/core@9.1.1 IConfigCLI.packageManager union ('yarn' | 'pnpm'
	// | 'npm'), so cast through 'unknown' to bridge the type-definition lag.
	cli: {
		packageManager: 'bun'
	},
	android: {
		v8Flags: '--expose_gc',
		markingMode: 'none'
	}
} as unknown as NativeScriptConfig;
