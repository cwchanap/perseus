import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://svelte.dev/docs/kit/integrations
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	// Static hosting SPA fallback.
	// Some static hosts (e.g. Surge) expect a `200.html` fallback for client-side routing.
	kit: { adapter: adapter({ fallback: '200.html' }) }
};

export default config;
