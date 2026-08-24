const webpack = require('@nativescript/webpack');

module.exports = (env) => {
	webpack.init(env);

	// Learn how to customize:
	// https://docs.nativescript.org/webpack
	webpack.mergeWebpack({
		resolve: {
			conditionNames: ['svelte', 'require', 'node'],
			alias: {
				tslib: require.resolve('tslib/tslib.es6.mjs'),
				// @nativescript/canvas/svelte still imports the pre-rename `svelte-native`
				// package; this template ships the renamed @nativescript-community/svelte-native.
				'svelte-native': '@nativescript-community/svelte-native'
			}
		}
	});

	return webpack.resolveConfig();
};
