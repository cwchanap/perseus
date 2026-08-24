import { NativeScriptConfig } from '@nativescript/core';

export default {
	id: 'org.perseus.mobile',
	appPath: 'app',
	appResourcesPath: 'App_Resources',
	// bun (the repo PM) resolves apps/mobile deps into its isolated node_modules
	// layout, which NS's bundler cannot consume with --preserve-symlinks. NS skips
	// that flag for pnpm, so ns install steps run through pnpm locally.
	cli: {
		packageManager: 'pnpm'
	},
	android: {
		v8Flags: '--expose_gc',
		markingMode: 'none'
	}
} as NativeScriptConfig;
