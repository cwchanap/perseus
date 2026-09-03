const webpack = require('@nativescript/webpack');

const apiBase = process.env.PERSEUS_MOBILE_API_BASE ?? 'http://localhost:4690';

// Bearer tokens travel in the Authorization header, so the API base must be
// HTTPS in production. HTTP is permitted only for explicit local development
// (localhost / 127.0.0.1 / 0.0.0.0). A non-local HTTP base in a release build
// is a build-time error, not a silent cleartext leak.
function validateApiBase(url, isProduction) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`PERSEUS_MOBILE_API_BASE is not a valid URL: ${url}`);
	}
	if (parsed.protocol === 'https:') return;
	if (parsed.protocol !== 'http:') {
		throw new Error(`PERSEUS_MOBILE_API_BASE must be http or https, got ${parsed.protocol}`);
	}
	const localhostHosts = ['localhost', '127.0.0.1', '0.0.0.0'];
	if (localhostHosts.includes(parsed.hostname)) return;
	if (isProduction) {
		throw new Error(
			`PERSEUS_MOBILE_API_BASE must be HTTPS in release builds (got ${url}). ` +
				'Use http://localhost:4690 for local development.'
		);
	}
	console.warn(
		`[perseus] PERSEUS_MOBILE_API_BASE is HTTP for non-localhost host (${url}). ` +
			'Bearer tokens will be sent in cleartext.'
	);
}

module.exports = (env) => {
	validateApiBase(apiBase, env?.production === true);
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
