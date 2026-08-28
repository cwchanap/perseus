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

vi.mock('$lib/services/puzzleImage', () => ({
	normalizePuzzleImageFile: vi.fn()
}));

vi.mock('$app/paths', () => ({
	resolve: (path: string) => path
}));

function setAuthState(state: unknown) {
	mockPlayerAuth.set(state);
}

class FailingFileReader {
	error = new Error('Preview failed');
	onerror: (() => void) | null = null;
	readAsDataURL() {
		this.onerror?.();
	}
}

class AbortingFileReader {
	onabort: (() => void) | null = null;
	readAsDataURL() {
		this.onabort?.();
	}
}

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
}

describe('Upload Page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setAuthState({ status: 'anonymous', user: null, error: null });
		vi.mocked(getGoogleLoginUrl).mockReturnValue('/api/auth/google/start?returnTo=%2Fupload');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
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
				225,
				normalized,
				undefined,
				'1:1'
			);
		});
	});

	it('shows validation error for an invalid piece count selection', async () => {
		setAuthenticatedPlayer();
		render(UploadPage);

		const pieceSelect = page.getByLabelText(/piece count/i).element() as HTMLSelectElement;
		pieceSelect.value = '0';
		pieceSelect.dispatchEvent(new Event('change', { bubbles: true }));

		await page.getByPlaceholder('Enter puzzle name').fill('Invalid Pieces');
		await uploadTestImage();
		await page.getByRole('button', { name: /upload puzzle/i }).click();

		await expect.element(page.getByText('Choose a valid 1:1 piece count')).toBeVisible();
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
			expect(normalizePuzzleImageFile).toHaveBeenCalled();
			expect(createPlayerPuzzle).toHaveBeenCalledWith(
				'My Player Puzzle',
				225,
				normalized,
				undefined,
				'1:1'
			);
		});
		await expect.element(page.getByText(/Puzzle uploaded/)).toBeVisible();
	});

	it('submits selected aspect ratio, piece count, and category', async () => {
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
					pieceCount: 192
				})
			);
			expect(createPlayerPuzzle).toHaveBeenCalledWith(
				'Portrait Puzzle',
				192,
				normalized,
				'Art',
				'3:4'
			);
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

	it('shows an error when image preview reading fails', async () => {
		setAuthenticatedPlayer();
		vi.stubGlobal('FileReader', FailingFileReader);

		render(UploadPage);

		const input = page.getByLabelText('CLICK TO UPLOAD').element() as HTMLInputElement;
		Object.defineProperty(input, 'files', {
			value: [new File(['data'], 'test.jpg', { type: 'image/jpeg' })],
			configurable: true
		});
		input.dispatchEvent(new Event('change', { bubbles: true }));

		await expect.element(page.getByText('Failed to load image preview')).toBeVisible();
		expect(page.getByLabelText('CLICK TO UPLOAD').query()).not.toBeNull();
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

	it('shows an error when image preview reading is aborted', async () => {
		setAuthenticatedPlayer();
		vi.stubGlobal('FileReader', AbortingFileReader);

		render(UploadPage);

		const input = page.getByLabelText('CLICK TO UPLOAD').element() as HTMLInputElement;
		Object.defineProperty(input, 'files', {
			value: [new File(['data'], 'test.jpg', { type: 'image/jpeg' })],
			configurable: true
		});
		input.dispatchEvent(new Event('change', { bubbles: true }));

		await expect.element(page.getByText('Image preview was aborted')).toBeVisible();
	});

	it('clears the previous success timeout before starting a new upload', async () => {
		setAuthenticatedPlayer();
		const normalized = new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' });
		vi.mocked(normalizePuzzleImageFile).mockResolvedValue(normalized);
		vi.mocked(createPlayerPuzzle).mockResolvedValue({} as never);

		render(UploadPage);

		await page.getByPlaceholder('Enter puzzle name').fill('First Upload');
		await uploadTestImage();
		await page.getByRole('button', { name: /upload puzzle/i }).click();

		await vi.waitFor(() => {
			expect(createPlayerPuzzle).toHaveBeenCalledWith(
				'First Upload',
				225,
				normalized,
				undefined,
				'1:1'
			);
		});
		await expect.element(page.getByText(/Puzzle uploaded/)).toBeVisible();

		// Trigger a second upload while the success message is still visible
		vi.mocked(createPlayerPuzzle).mockClear();
		await page.getByPlaceholder('Enter puzzle name').fill('Second Upload');
		await uploadTestImage();
		await page.getByRole('button', { name: /upload puzzle/i }).click();

		await vi.waitFor(() => {
			expect(createPlayerPuzzle).toHaveBeenCalledWith(
				'Second Upload',
				225,
				normalized,
				undefined,
				'1:1'
			);
		});
	});

	it('auto-dismisses the success message after the timeout', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		setAuthenticatedPlayer();
		const normalized = new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' });
		vi.mocked(normalizePuzzleImageFile).mockResolvedValue(normalized);
		vi.mocked(createPlayerPuzzle).mockResolvedValue({} as never);

		render(UploadPage);

		await page.getByPlaceholder('Enter puzzle name').fill('Timed Upload');
		await uploadTestImage();
		await page.getByRole('button', { name: /upload puzzle/i }).click();

		await vi.waitFor(() => {
			expect(createPlayerPuzzle).toHaveBeenCalled();
		});
		await expect.element(page.getByText(/Puzzle uploaded/)).toBeVisible();

		await vi.advanceTimersByTimeAsync(3000);

		await expect.poll(() => page.getByText(/Puzzle uploaded/).query()).toBeNull();
		vi.useRealTimers();
	});
});
