import { defineEnvVars } from '@sveltejs/kit/env';

// Kit 3 requires environment variables to be declared here instead of being
// picked up implicitly from PUBLIC_* process env.
export const variables = defineEnvVars({
	// Base URL of the API worker. Same-origin ('') by default for the Workers
	// deployment; set PUBLIC_API_BASE before building or developing to target
	// a different API (e.g. 'http://localhost:4690' for local wrangler dev).
	PUBLIC_API_BASE: {
		public: true,
		static: true,
		schema: (value) => value ?? ''
	}
});
