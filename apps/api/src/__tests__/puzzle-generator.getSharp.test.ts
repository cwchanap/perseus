import { describe, it, expect, beforeEach } from 'vitest';
import {
	__getImageToolingForTests,
	__resetImageToolingForTests
} from '../services/puzzle-generator';

describe('getImageTooling (lazy loader)', () => {
	beforeEach(() => {
		__resetImageToolingForTests();
	});

	it('resolves modules with required exports', async () => {
		const photon = {
			PhotonImage: class FakePhotonImage {},
			resize: () => undefined,
			crop: () => undefined,
			SamplingFilter: { Lanczos3: 1 }
		};
		const resvg = {
			Resvg: class FakeResvg {}
		};

		const resolved = (await __getImageToolingForTests(
			async () => photon,
			async () => resvg
		)) as unknown as { PhotonImage: unknown; Resvg: unknown };

		expect(resolved.PhotonImage).toBe(photon.PhotonImage);
		expect(resolved.Resvg).toBe(resvg.Resvg);
	});

	it('caches the resolved modules', async () => {
		const photon = {
			PhotonImage: class FakePhotonImage {},
			resize: () => undefined,
			crop: () => undefined,
			SamplingFilter: { Lanczos3: 1 }
		};
		const resvg = {
			Resvg: class FakeResvg {}
		};
		const photonAlt = {
			PhotonImage: class FakePhotonImageAlt {},
			resize: () => undefined,
			crop: () => undefined,
			SamplingFilter: { Lanczos3: 1 }
		};
		const resvgAlt = {
			Resvg: class FakeResvgAlt {}
		};

		let calls = 0;
		const loader1 = async () => {
			calls++;
			return photon;
		};
		const loader2 = async () => {
			calls++;
			return photonAlt;
		};

		const resolved1 = (await __getImageToolingForTests(loader1, async () => resvg)) as unknown as {
			PhotonImage: unknown;
			Resvg: unknown;
		};
		const resolved2 = (await __getImageToolingForTests(
			loader2,
			async () => resvgAlt
		)) as unknown as { PhotonImage: unknown; Resvg: unknown };

		expect(resolved1.PhotonImage).toBe(photon.PhotonImage);
		expect(resolved2.PhotonImage).toBe(photon.PhotonImage);
		expect(resolved2.Resvg).toBe(resvg.Resvg);
		expect(calls).toBe(1);
	});

	it('throws a helpful error when modules are unavailable', async () => {
		await expect(
			__getImageToolingForTests(
				async () => ({}),
				async () => ({})
			)
		).rejects.toMatchObject({
			message: expect.stringContaining('not available'),
			cause: expect.objectContaining({
				message: expect.stringContaining('Missing exports from image processing modules')
			})
		});
	});

	it('lists all missing symbols in the error message', async () => {
		await expect(
			__getImageToolingForTests(
				async () => ({}),
				async () => ({})
			)
		).rejects.toMatchObject({
			cause: expect.objectContaining({
				message: expect.stringContaining('photon.PhotonImage')
			})
		});

		__resetImageToolingForTests();

		await expect(
			__getImageToolingForTests(
				async () => ({
					PhotonImage: class {},
					resize: () => undefined,
					crop: () => undefined,
					SamplingFilter: { Lanczos3: 1 }
				}),
				async () => ({})
			)
		).rejects.toMatchObject({
			cause: expect.objectContaining({
				message: expect.stringContaining('resvg.Resvg')
			})
		});
	});
});
