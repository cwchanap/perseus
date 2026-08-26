const webpack = require('@nativescript/webpack');

const apiBase = process.env.PERSEUS_MOBILE_API_BASE ?? 'http://localhost:4690';

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

	webpack.chainWebpack((config) => {
		config.plugin('DefinePlugin').tap((args) => {
			args[0].__PERSEUS_API_BASE__ = JSON.stringify(apiBase);
			return args;
		});
	});

	return webpack.resolveConfig();
};
