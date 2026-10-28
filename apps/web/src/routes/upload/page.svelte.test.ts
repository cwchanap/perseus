import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import UploadPage from './+page.svelte';
import { ApiError, createPlayerPuzzle, getGoogleLoginUrl } from '$lib/services/api';
import { normalizePuzzleImageFile } from '$lib/services/puzzleImage';

const mockPlayerAuth = vi.hoisted(() => {
	const subscribers = new Set<(value: unknown) => void>();
	let value: unknown = {
		status: 'anonymous',
		user: null,
		error: null
	};

	return {
		subscribe(fn: (value: unknown) => void) {
			fn(value);
			subscribers.add(fn);
			return () => subscribers.delete(fn);
		},
		set(nextValue: unknown) {
			value = nextValue;
			subscribers.forEach((fn) => fn(value));
		},
		refresh: vi.fn()
	};
});

vi.mock('$lib/stores/playerAuth', () => ({
	playerAuth: mockPlayerAuth
}));

vi.mock('$lib/services/api', () => ({
	createPlayerPuzzle: vi.fn(),
	getGoogleLoginUrl: vi.fn(() => '/api/auth/google/start?returnTo=%2Fupload'),
	ApiError: class MockApiError extends Error {
		constructor(
			public status: number,
			public error: string,
			message: string
		) {
			super(message);
			this.name = 'ApiError';
		}
	}
}));

vi.mock('$lib/services/puzzleImage', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/services/puzzleImage')>();
	return { ...actual, normalizePuzzleImageFile: vi.fn() };
});

vi.mock('$app/paths', () => ({
	resolve: (path: string, params?: Record<string, string>) =>
		params ? path.replace(/\[(\w+)\]/g, (_, key) => params[key] ?? '') : path
}));

function setAuthState(state: unknown) {
	mockPlayerAuth.set(state);
}

const THUMBNAIL_DATA_URL = 'data:image/webp;base64,cHJldmlldw==';

const makeBitmap = (width = 800, height = 600) => ({
	width,
	height,
	close: vi.fn()
});

const stubCanvasPreview = () => {
	const drawImage = vi.fn();
	vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
		drawImage
	} as unknown as CanvasRenderingContext2D);
	const toDataURL = vi
		.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
		.mockReturnValue(THUMBNAIL_DATA_URL);
	return { drawImage, toDataURL };
};

function setAuthenticatedPlayer() {
	setAuthState({
		status: 'authenticated',
		user: {
			id: 'player-1',
			email: 'player@example.com',
			createdAt: 1,
			lastLoginAt: 2
		},
		error: null
	});
}

async function uploadTestImage() {
	await page
		.getByLabelText('CLICK TO UPLOAD')
		.upload(new File(['data'], 'test.jpg', { type: 'image/jpeg' }));
	// Submit is gated on the decode probe; the preview appearing is the signal
	// it settled.
	await expect.element(page.getByAltText('Preview')).toBeVisible();
}

function selectFile(file: File) {
	const input = page.getByLabelText('CLICK TO UPLOAD').element() as HTMLInputElement;
	Object.defineProperty(input, 'files', { value: [file], configurable: true });
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('Upload Page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setAuthState({ status: 'anonymous', user: null, error: null });
		vi.mocked(getGoogleLoginUrl).mockReturnValue('/api/auth/google/start?returnTo=%2Fupload');
		// The selection fixtures are not decodable images; stub the decode probe so
		// selection reaches the thumbnail render, and stub the canvas calls the
		// thumbnail path makes. Tests override as needed.
		vi.stubGlobal(
			'createImageBitmap',
			vi.fn(async () => makeBitmap())
		);
		stubCanvasPreview();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it('shows a Google sign-in action when the player is anonymous', async () => {
		render(UploadPage);

		await expect.element(page.getByRole('heading', { name: /upload puzzle/i })).toBeVisible();
		await expect
			.element(page.getByRole('link', { name: /sign in with google/i }))
			.toHaveAttribute('href', '/api/auth/google/start?returnTo=%2Fupload');
		expect(getGoogleLoginUrl).toHaveBeenCalledWith('/upload');
	});

	it('shows a loading state while player auth is refreshing', async () => {
		setAuthState({ status: 'loading', user: null, error: null });

		render(UploadPage);

		await expect.element(page.getByText('VERIFYING PLAYER...')).toBeVisible();
	});

	it('shows validation error when submitting without an image', async () => {
		setAuthenticatedPlayer();
		render(UploadPage);

		await page.getByPlaceholder('Enter puzzle name').fill('Missing Image');
		document
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

		await expect.element(page.getByText('Please select an image')).toBeVisible();
	});

	it('shows validation error when submitting without a puzzle name', async () => {
		setAuthenticatedPlayer();
		render(UploadPage);

		await uploadTestImage();
		document
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

		await expect.element(page.getByText('Please enter a puzzle name')).toBeVisible();
	});

	it('keeps the current aspect ratio when an invalid aspect value is selected', async () => {
		setAuthenticatedPlayer();
		const normalized = new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' });
		vi.mocked(normalizePuzzleImageFile).mockResolvedValue(normalized);
		vi.mocked(createPlayerPuzzle).mockResolvedValue({} as never);

		render(UploadPage);

		const aspectSelect = page.getByLabelText(/aspect ratio/i).element() as HTMLSelectElement;
		aspectSelect.value = 'bad-aspect';
		aspectSelect.dispatchEvent(new Event('change', { bubbles: true }));

		await page.getByPlaceholder('Enter puzzle name').fill('Square Puzzle');
		await uploadTestImage();
		await page.getByRole('button', { name: /upload puzzle/i }).click();

		await vi.waitFor(() => {
			expect(createPlayerPuzzle).toHaveBeenCalledWith(
				'Square Puzzle',
				normalized,
				undefined,
				'1:1'
			);
		});
	});

	it('uploads a normalized puzzle for an authenticated player', async () => {
		setAuthenticatedPlayer();
		const normalized = new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' });
		vi.mocked(normalizePuzzleImageFile).mockResolvedValue(normalized);
		vi.mocked(createPlayerPuzzle).mockResolvedValue({} as never);

		render(UploadPage);

		await page.getByPlaceholder('Enter puzzle name').fill('My Player Puzzle');
		await uploadTestImage();
		await page.getByRole('button', { name: /upload puzzle/i }).click();

		await vi.waitFor(() => {
			expect(normalizePuzzleImageFile).toHaveBeenCalledWith(
				expect.any(File),
				expect.objectContaining({
					aspectRatio: '1:1',
					pieceCount: 100
				}),
				expect.objectContaining({ width: 800, height: 600 })
			);
			expect(createPlayerPuzzle).toHaveBeenCalledWith(
				'My Player Puzzle',
				normalized,
				undefined,
				'1:1'
			);
		});
		await expect.element(page.getByText(/Puzzle family uploaded/)).toBeVisible();
	});

	it('submits selected aspect ratio and category', async () => {
		setAuthenticatedPlayer();
		const normalized = new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' });
		vi.mocked(normalizePuzzleImageFile).mockResolvedValue(normalized);
		vi.mocked(createPlayerPuzzle).mockResolvedValue({} as never);

		render(UploadPage);

		const aspectSelect = page.getByLabelText(/aspect ratio/i).element() as HTMLSelectElement;
		const categorySelect = page.getByLabelText(/category/i).element() as HTMLSelectElement;
		aspectSelect.value = '3:4';
		aspectSelect.dispatchEvent(new Event('change', { bubbles: true }));
		categorySelect.value = 'Art';
		categorySelect.dispatchEvent(new Event('change', { bubbles: true }));

		await page.getByPlaceholder('Enter puzzle name').fill('Portrait Puzzle');
		await uploadTestImage();
		await page.getByRole('button', { name: /upload puzzle/i }).click();

		await vi.waitFor(() => {
			expect(normalizePuzzleImageFile).toHaveBeenCalledWith(
				expect.any(File),
				expect.objectContaining({
					aspectRatio: '3:4',
					pieceCount: 108
				}),
				expect.objectContaining({ width: 800, height: 600 })
			);
			expect(createPlayerPuzzle).toHaveBeenCalledWith('Portrait Puzzle', normalized, 'Art', '3:4');
		});
	});

	it('removes a selected image preview', async () => {
		setAuthenticatedPlayer();
		render(UploadPage);

		await uploadTestImage();
		await expect.element(page.getByAltText('Preview')).toBeVisible();
		await page.getByRole('button', { name: /remove image/i }).click();

		await expect.element(page.getByLabelText('CLICK TO UPLOAD')).toBeVisible();
	});

	it('keeps the file and shows a fallback row when the preview thumbnail cannot be rendered', async () => {
		setAuthenticatedPlayer();
		vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
			throw new Error('encode failed');
		});

		render(UploadPage);

		await page.getByPlaceholder('Enter puzzle name').fill('No Preview');
		const input = page.getByLabelText('CLICK TO UPLOAD').element() as HTMLInputElement;
		Object.defineProperty(input, 'files', {
			value: [new File(['data'], 'test.jpg', { type: 'image/jpeg' })],
			configurable: true
		});
		input.dispatchEvent(new Event('change', { bubbles: true }));

		// The file passed the decode probe; a cosmetic preview failure must not
		// discard it or surface a form error.
		await expect.element(page.getByText('test.jpg')).toBeVisible();
		await expect.element(page.getByText(/Preview unavailable/)).toBeVisible();
		expect(page.getByRole('alert').query()).toBeNull();
		expect(
			(page.getByRole('button', { name: /upload puzzle/i }).element() as HTMLButtonElement).disabled
		).toBe(false);
	});

	it('shows API errors from player upload', async () => {
		setAuthenticatedPlayer();
		vi.mocked(normalizePuzzleImageFile).mockResolvedValue(
			new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' })
		);
		vi.mocked(createPlayerPuzzle).mockRejectedValue(
			new ApiError(400, 'bad_request', 'Invalid image format')
		);

		render(UploadPage);

		await page.getByPlaceholder('Enter puzzle name').fill('Bad Puzzle');
		await uploadTestImage();
		await page.getByRole('button', { name: /upload puzzle/i }).click();

		await expect.element(page.getByText('Invalid image format')).toBeVisible();
	});

	it('shows regular errors from image normalization', async () => {
		setAuthenticatedPlayer();
		vi.mocked(normalizePuzzleImageFile).mockRejectedValue(new Error('Canvas unavailable'));

		render(UploadPage);

		await page.getByPlaceholder('Enter puzzle name').fill('Bad Image');
		await uploadTestImage();
		await page.getByRole('button', { name: /upload puzzle/i }).click();

		await expect.element(page.getByText('Canvas unavailable')).toBeVisible();
	});

	it('shows fallback error for unknown upload failures', async () => {
		setAuthenticatedPlayer();
		vi.mocked(normalizePuzzleImageFile).mockRejectedValue('unexpected');

		render(UploadPage);

		await page.getByPlaceholder('Enter puzzle name').fill('Unknown Failure');
		await uploadTestImage();
		await page.getByRole('button', { name: /upload puzzle/i }).click();

		await expect.element(page.getByText('Failed to upload puzzle')).toBeVisible();
	});

	it('starts a new upload while the success status is still visible', async () => {
		setAuthenticatedPlayer();
		const normalized = new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' });
		vi.mocked(normalizePuzzleImageFile).mockResolvedValue(normalized);
		vi.mocked(createPlayerPuzzle).mockResolvedValue({} as never);

		render(UploadPage);

		await page.getByPlaceholder('Enter puzzle name').fill('First Upload');
		await uploadTestImage();
		await page.getByRole('button', { name: /upload puzzle/i }).click();

		await vi.waitFor(() => {
			expect(createPlayerPuzzle).toHaveBeenCalledWith('First Upload', normalized, undefined, '1:1');
		});
		await expect.element(page.getByText(/Puzzle family uploaded/)).toBeVisible();

		// Trigger a second upload while the success message is still visible;
		// selecting a new file clears it so success and error can't coexist.
		vi.mocked(createPlayerPuzzle).mockClear();
		await page.getByPlaceholder('Enter puzzle name').fill('Second Upload');
		await uploadTestImage();
		expect(page.getByText(/Puzzle family uploaded/).query()).toBeNull();
		await page.getByRole('button', { name: /upload puzzle/i }).click();

		await vi.waitFor(() => {
			expect(createPlayerPuzzle).toHaveBeenCalledWith(
				'Second Upload',
				normalized,
				undefined,
				'1:1'
			);
		});
	});

	it('keeps the success status visible with a link to my puzzles', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		setAuthenticatedPlayer();
		const normalized = new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' });
		vi.mocked(normalizePuzzleImageFile).mockResolvedValue(normalized);
		vi.mocked(createPlayerPuzzle).mockResolvedValue({} as never);

		render(UploadPage);

		await page.getByPlaceholder('Enter puzzle name').fill('Persisted Upload');
		await uploadTestImage();
		await page.getByRole('button', { name: /upload puzzle/i }).click();

		await vi.waitFor(() => {
			expect(createPlayerPuzzle).toHaveBeenCalled();
		});
		await expect.element(page.getByText(/accepted for processing/i)).toBeVisible();
		await expect
			.element(page.getByRole('link', { name: /view my puzzles/i }))
			.toHaveAttribute('href', '/profile');

		// The success status persists; the old implementation auto-dismissed it after 3 seconds.
		await vi.advanceTimersByTimeAsync(3000);

		await expect.poll(() => page.getByText(/accepted for processing/i).query()).not.toBeNull();
	});

	it('lets the decode probe validate files regardless of declared type', async () => {
		setAuthenticatedPlayer();
		const probe = vi.fn(async () => makeBitmap());
		vi.stubGlobal('createImageBitmap', probe);

		render(UploadPage);

		// No declared-type allowlist: GIFs and files with an empty MIME type
		// reach the probe and preview like any other decodable image.
		selectFile(new File(['gif'], 'animation.gif', { type: 'image/gif' }));
		await expect.element(page.getByAltText('Preview')).toBeVisible();
		expect(probe).toHaveBeenCalledTimes(1);
		expect(page.getByRole('alert').query()).toBeNull();

		await page.getByRole('button', { name: /remove image/i }).click();
		selectFile(new File(['data'], 'no-extension-hint', { type: '' }));
		await expect.element(page.getByAltText('Preview')).toBeVisible();
		expect(probe).toHaveBeenCalledTimes(2);
		expect(page.getByRole('alert').query()).toBeNull();
	});

	it('allows large raw MIME-valid images through selection to decode', async () => {
		setAuthenticatedPlayer();
		render(UploadPage);

		// Larger than the 10 MB MAX_FILE_SIZE the server applies to the normalized image.
		const oversized = new File([new Uint8Array(11 * 1024 * 1024)], 'large.jpg', {
			type: 'image/jpeg'
		});
		selectFile(oversized);

		await expect.element(page.getByAltText('Preview')).toBeVisible();
		expect(page.getByText("Couldn't read this image").query()).toBeNull();
	});

	it('shows an alert without a preview when the image cannot be decoded', async () => {
		setAuthenticatedPlayer();
		vi.stubGlobal(
			'createImageBitmap',
			vi.fn(async () => {
				throw new Error('decode failed');
			})
		);

		render(UploadPage);
		await page
			.getByLabelText('CLICK TO UPLOAD')
			.upload(new File(['data'], 'test.jpg', { type: 'image/jpeg' }));

		await expect.element(page.getByText("Couldn't read this image")).toBeVisible();
		await expect.element(page.getByRole('alert')).toHaveTextContent("Couldn't read this image");
		expect(page.getByAltText('Preview').query()).toBeNull();
		await expect.element(page.getByLabelText('CLICK TO UPLOAD')).toBeVisible();
		// A failed decode clears the selected file, so submit stays disabled.
		expect(
			(page.getByRole('button', { name: /upload puzzle/i }).element() as HTMLButtonElement).disabled
		).toBe(true);
	});

	it('retains the decoded bitmap for submit and closes it when the selection clears', async () => {
		setAuthenticatedPlayer();
		const normalized = new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' });
		vi.mocked(normalizePuzzleImageFile).mockResolvedValue(normalized);
		vi.mocked(createPlayerPuzzle).mockResolvedValue({} as never);
		const close = vi.fn();
		const bitmap = { ...makeBitmap(), close };
		const probe = vi.fn(async () => bitmap);
		vi.stubGlobal('createImageBitmap', probe);

		render(UploadPage);
		await page.getByPlaceholder('Enter puzzle name').fill('Single Decode');
		await uploadTestImage();

		// The probe's decode survives for reuse — submit must not decode again.
		expect(close).not.toHaveBeenCalled();
		await page.getByRole('button', { name: /upload puzzle/i }).click();
		await vi.waitFor(() => {
			expect(normalizePuzzleImageFile).toHaveBeenCalledWith(
				expect.any(File),
				expect.objectContaining({ aspectRatio: '1:1' }),
				bitmap
			);
		});
		expect(probe).toHaveBeenCalledTimes(1);

		// Successful submit clears the form, which closes the retained bitmap.
		await expect.element(page.getByText(/Puzzle family uploaded/)).toBeVisible();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('ignores a stale bitmap probe after a newer selection', async () => {
		setAuthenticatedPlayer();
		let rejectFirst!: (reason?: unknown) => void;
		let firstCall = true;
		vi.stubGlobal(
			'createImageBitmap',
			vi.fn(() => {
				if (firstCall) {
					firstCall = false;
					return new Promise((_resolve, reject) => {
						rejectFirst = reject;
					});
				}
				return Promise.resolve(makeBitmap());
			})
		);

		render(UploadPage);

		selectFile(new File(['stale'], 'stale.jpg', { type: 'image/jpeg' }));
		selectFile(new File(['fresh'], 'fresh.jpg', { type: 'image/jpeg' }));

		await expect.element(page.getByAltText('Preview')).toBeVisible();

		// The stale probe must not surface an error or clear the fresh preview.
		rejectFirst(new Error('decode failed'));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(page.getByText("Couldn't read this image").query()).toBeNull();
		await expect.element(page.getByAltText('Preview')).toBeVisible();
	});

	it('ignores a stale probe resolution after a newer selection', async () => {
		setAuthenticatedPlayer();
		const staleBitmap = makeBitmap();
		let resolveFirst!: (bitmap: ReturnType<typeof makeBitmap>) => void;
		let firstCall = true;
		vi.stubGlobal(
			'createImageBitmap',
			vi.fn(() => {
				if (firstCall) {
					firstCall = false;
					return new Promise<ReturnType<typeof makeBitmap>>((resolve) => {
						resolveFirst = resolve;
					});
				}
				return Promise.resolve(makeBitmap());
			})
		);
		const toDataURL = vi.mocked(HTMLCanvasElement.prototype.toDataURL);

		render(UploadPage);

		selectFile(new File(['first'], 'first.jpg', { type: 'image/jpeg' }));
		selectFile(new File(['second'], 'second.jpg', { type: 'image/jpeg' }));
		await expect.element(page.getByAltText('Preview')).toBeVisible();

		// The stale bitmap resolving late must not render a second preview or
		// clear the fresh selection; its bitmap is still closed.
		resolveFirst(staleBitmap);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(toDataURL).toHaveBeenCalledTimes(1);
		expect(staleBitmap.close).toHaveBeenCalledTimes(1);
		await expect.element(page.getByAltText('Preview')).toBeVisible();
	});
});
