// Rune-compiled mock of kit 3's `$app/state` `page` object (kit's real one is
// a $state-backed getter facade, so store-style mocks no longer drive it).
// The instance is carried on globalThis so it survives vi.resetModules().
type MockUrl = { pathname: string } & Record<string, unknown>;

class MockPageState {
	data = $state.raw({} as Record<string, unknown>);
	form = $state.raw(null);
	error = $state.raw(null);
	params = $state.raw({} as Record<string, string>);
	route = $state.raw({ id: null as string | null });
	status = $state.raw(200);
	url = $state.raw({ pathname: '/' } as MockUrl);
}

function createMockPage() {
	const state = new MockPageState();

	return {
		get data() {
			return state.data;
		},
		get form() {
			return state.form;
		},
		get error() {
			return state.error;
		},
		get params() {
			return state.params;
		},
		get route() {
			return state.route;
		},
		get status() {
			return state.status;
		},
		get url() {
			return state.url;
		},
		/** Patch the page state (assigns, like kit's own update_page). */
		set(patch: Record<string, unknown>) {
			Object.assign(state, patch);
		}
	};
}

type MockPage = ReturnType<typeof createMockPage>;

const carrier = globalThis as typeof globalThis & { __perseusMockPage?: MockPage };

export const mockPage: MockPage = (carrier.__perseusMockPage ??= createMockPage());
