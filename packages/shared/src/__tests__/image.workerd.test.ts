// Miniflare test covering the complete Worker image-validation path.
//
// In workerd, neither Bun.Image nor createImageBitmap is available, so
// boundedDecode falls through to the @cf-wasm/photon path. This test
// bundles a minimal worker (via esbuild) that imports validateImageEndMarker
// from the shared package and runs it inside a real workerd instance via
// Miniflare. It verifies:
//   1. A valid PNG decodes successfully via Photon (requireFullDecode: true
//      returns true).
//   2. Non-image bytes are rejected via Photon decode failure
//      (requireFullDecode: true returns false).
//   3. A valid PNG returns true without requireFullDecode (the structural
//      fallback is not needed when Photon decodes successfully).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Miniflare } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// A real 1x1 red PNG (valid, decodable).
const REAL_PNG = new Uint8Array(
	Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
		'base64'
	)
);

let mf: Miniflare;

beforeAll(async () => {
	// Bundle a minimal worker that imports validateImageEndMarker from the
	// shared package source. esbuild resolves @cf-wasm/photon's workerd
	// export. The WASM module is kept as an external import and provided to
	// Miniflare as a CompiledWasm module (workerd disallows the
	// WebAssembly.Module constructor in JS — WASM must be imported as a
	// module binding).
	const photonPkgPath = require.resolve('@cf-wasm/photon/package.json');
	const photonDir = dirname(photonPkgPath);
	const wasmPath = join(photonDir, 'dist/lib/photon_rs_bg.wasm');
	const wasmBytes = readFileSync(wasmPath);

	const entry = `
		import { validateImageEndMarker } from '${join(__dirname, '../image.ts')}';

		export default {
			async fetch(request) {
				const body = await request.arrayBuffer();
				const mimeType = request.headers.get('X-Mime-Type') || 'image/png';
				const requireFullDecode = request.headers.get('X-Require-Full-Decode') === 'true';
				const blob = new Blob([body], { type: mimeType });
				try {
					const result = await validateImageEndMarker(blob, mimeType, { requireFullDecode });
					return Response.json({ result });
				} catch (err) {
					return Response.json({ result: false, error: String(err), stack: err?.stack }, { status: 500 });
				}
			}
		};
	`;

	const bundle = await build({
		stdin: {
			contents: entry,
			resolveDir: __dirname,
			loader: 'ts'
		},
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		target: 'esnext',
		conditions: ['workerd'],
		write: false,
		plugins: [
			{
				name: 'wasm-external',
				setup(b) {
					// Rewrite .wasm imports to a fixed module path that we
					// provide to Miniflare as a CompiledWasm module.
					b.onResolve({ filter: /photon_rs_bg\.wasm$/ }, () => ({
						path: 'photon_rs_bg.wasm',
						external: true
					}));
				}
			}
		]
	});

	const workerCode = bundle.outputFiles[0].text;

	mf = new Miniflare({
		modules: [
			{ type: 'ESModule', path: 'index.js', contents: workerCode },
			{ type: 'CompiledWasm', path: 'photon_rs_bg.wasm', contents: wasmBytes }
		],
		compatibilityDate: '2024-12-30'
	});
}, 60_000);

afterAll(async () => {
	await mf?.dispose();
});

async function dispatch(
	body: Uint8Array,
	mimeType: string,
	requireFullDecode: boolean
): Promise<boolean> {
	// Cast through a broader type to avoid the Blob conflict between
	// @cloudflare/workers-types and @types/bun (both define BodyInit
	// with incompatible Blob types in the shared tsconfig).
	const res = await mf.dispatchFetch('http://localhost/', {
		method: 'POST',
		body: body as unknown as never,
		headers: {
			'X-Mime-Type': mimeType,
			'X-Require-Full-Decode': requireFullDecode ? 'true' : 'false'
		}
	});
	const json = (await res.json()) as { result: boolean; error?: string; stack?: string };
	if (json.error) {
		console.error('Worker error:', json.error, '\n', json.stack);
	}
	return json.result;
}

describe('validateImageEndMarker – workerd/Photon path (Miniflare)', () => {
	it('decodes a valid PNG via Photon and returns true with requireFullDecode', async () => {
		const result = await dispatch(REAL_PNG, 'image/png', true);
		expect(result).toBe(true);
	});

	it('rejects non-image bytes via Photon decode failure with requireFullDecode', async () => {
		// Random bytes — Photon will throw on decode, boundedDecode returns
		// false, validateImageEndMarker returns false.
		const garbage = new Uint8Array(256);
		for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37) & 0xff;
		const result = await dispatch(garbage, 'image/png', true);
		expect(result).toBe(false);
	});

	it('returns true for a valid PNG without requireFullDecode (structural fallback not needed)', async () => {
		// When Photon is available, both requireFullDecode:true and false
		// use the decode path. This confirms the option doesn't break the
		// happy path when false.
		const result = await dispatch(REAL_PNG, 'image/png', false);
		expect(result).toBe(true);
	});
});
