/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import AdminPage from './+page.svelte';
import type { PuzzleSummary } from '$lib/types/puzzle';
import { fetchAdminPuzzles, logout, ApiError, createPuzzle, deletePuzzle } from '$lib/services/api';
import { normalizePuzzleImageFile } from '$lib/services/puzzleImage';
import { goto } from '$app/navigation';

vi.mock('$lib/services/api', () => {
	class MockApiError extends Error {
		status: number;
		error: string;
		constructor(status: number, error: string, message: string) {
			super(message);
			this.name = 'ApiError';
			this.status = status;
			this.error = error;
		}
	}
	return {
		logout: vi.fn(),
		createPuzzle: vi.fn(),
		deletePuzzle: vi.fn(),
		fetchAdminPuzzles: vi.fn().mockResolvedValue([]),
		getThumbnailUrl: vi.fn((id: string) => `/api/puzzles/${id}/thumbnail`),
		ApiError: MockApiError
	};
});

vi.mock('$lib/services/progress', () => ({
	clearProgress: vi.fn()
}));

vi.mock('$app/navigation', () => ({
	goto: vi.fn()
}));

vi.mock('$app/paths', () => ({
	resolve: (p: string) => p
}));

vi.mock('$lib/services/puzzleImage', () => ({
	normalizePuzzleImageFile: vi.fn()
}));

const mockPuzzles: PuzzleSummary[] = [
	{ id: 'p1', name: 'Forest Scene', pieceCount: 225, status: 'ready' },
	{
		id: 'p2',
		name: 'City Lights',
		pieceCount: 225,
		status: 'processing',
		progress: { generatedPieces: 10, totalPieces: 225, updatedAt: 0 }
	},
	{ id: 'p3', name: 'Broken Puzzle', pieceCount: 225, status: 'failed' }
];

describe('Admin Page', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('renders the admin control panel heading', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		render(AdminPage);
		await expect.element(page.getByRole('heading', { name: /CONTROL PANEL/i })).toBeVisible();
	});

	it('shows CREATE MISSION form panel', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		render(AdminPage);
		// The panel header uses a <span> with this exact text
		await expect.element(page.getByText('CREATE MISSION', { exact: true }).first()).toBeVisible();
	});

	it('shows empty state when no puzzles exist', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		render(AdminPage);
		await expect.element(page.getByText(/No missions found/i)).toBeVisible();
	});

	// Tests rendering mockPuzzles (which includes a 'processing' puzzle that triggers
	// setInterval polling) use fake timers so the interval never fires during the test.
	describe('puzzle list rendering', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('renders list of puzzles after loading', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
			render(AdminPage);

			await expect.element(page.getByText('Forest Scene')).toBeVisible();
			await expect.element(page.getByText('City Lights')).toBeVisible();
			await expect.element(page.getByText('Broken Puzzle')).toBeVisible();
		});

		it.each(['PROCESSING', 'FAILED', 'READY'])(
			'shows %s badge for the matching puzzle status',
			async (badge) => {
				vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
				render(AdminPage);

				await expect.element(page.getByText(badge)).toBeVisible();
			}
		);

		it('shows puzzle count in mission database panel', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
			render(AdminPage);

			// "3 TOTAL" should appear once puzzles are loaded
			await expect.element(page.getByText('3 TOTAL')).toBeVisible();
		});
	});

	it('shows error state when fetching puzzles fails', async () => {
		vi.mocked(fetchAdminPuzzles).mockRejectedValue(new Error('Network error'));
		render(AdminPage);

		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.element(page.getByText(/Failed to load puzzles/i)).toBeVisible();
	});

	it('shows ApiError message when puzzle fetch fails with ApiError', async () => {
		vi.mocked(fetchAdminPuzzles).mockRejectedValue(
			new ApiError(503, 'service_unavailable', 'Service temporarily unavailable')
		);
		render(AdminPage);

		await expect.element(page.getByText('Service temporarily unavailable')).toBeVisible();
	});

	it('disables the submit button when name and image are empty', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		render(AdminPage);

		const submitBtn = page.getByRole('button', { name: /CREATE MISSION/i });
		await expect.element(submitBtn).toBeDisabled();
	});

	it('navigates to /admin/login after successful logout', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		vi.mocked(logout).mockResolvedValue(undefined);
		render(AdminPage);

		await page.getByRole('button', { name: /LOGOUT/i }).click();

		await vi.waitFor(() => {
			expect(goto).toHaveBeenCalledWith('/admin/login');
		});
	});

	it('shows logout error when logout fails', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		vi.mocked(logout).mockRejectedValue(new Error('Logout failed'));
		render(AdminPage);

		await page.getByRole('button', { name: /LOGOUT/i }).click();

		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.element(page.getByText('Failed to logout')).toBeVisible();
	});

	describe('handleSubmit', () => {
		it('shows error when name is empty', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
			render(AdminPage);

			const fileInput = page.getByLabelText('CLICK TO UPLOAD');
			const file = new File(['data'], 'test.jpg', { type: 'image/jpeg' });
			await fileInput.upload(file);

			const formEl = document.querySelector('form')!;
			formEl.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

			await expect.element(page.getByText('Please enter a puzzle name')).toBeVisible();
		});

		it('shows error when no image is selected', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
			render(AdminPage);

			const nameInput = page.getByPlaceholder('Enter puzzle name');
			await nameInput.fill('Test Puzzle');

			const formEl = document.querySelector('form')!;
			formEl.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

			await expect.element(page.getByText('Please select an image')).toBeVisible();
		});

		it('shows error for invalid piece count', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
			render(AdminPage);

			const nameInput = page.getByPlaceholder('Enter puzzle name');
			await nameInput.fill('Test Puzzle');
			const fileInput = page.getByLabelText('CLICK TO UPLOAD');
			const file = new File(['data'], 'test.jpg', { type: 'image/jpeg' });
			await fileInput.upload(file);

			const selects = document.querySelectorAll('form select');
			const pieceSelectEl = selects[1] as HTMLSelectElement;
			const nativeInputValue = Object.getOwnPropertyDescriptor(
				HTMLSelectElement.prototype,
				'value'
			);
			nativeInputValue!.set!.call(pieceSelectEl, '0');
			pieceSelectEl.dispatchEvent(new Event('change', { bubbles: true }));

			const formEl = document.querySelector('form')!;
			formEl.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

			await expect.element(page.getByText(/Choose a valid.*piece count/)).toBeVisible();
		});

		it('creates puzzle successfully with normalized image', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
			vi.mocked(normalizePuzzleImageFile).mockResolvedValue(
				new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' })
			);
			vi.mocked(createPuzzle).mockResolvedValue({} as any);
			render(AdminPage);

			const nameInput = page.getByPlaceholder('Enter puzzle name');
			await nameInput.fill('My Puzzle');
			const fileInput = page.getByLabelText('CLICK TO UPLOAD');
			const file = new File(['data'], 'test.jpg', { type: 'image/jpeg' });
			await fileInput.upload(file);

			await page.getByRole('button', { name: /CREATE MISSION/i }).click();

			await vi.waitFor(() => {
				expect(normalizePuzzleImageFile).toHaveBeenCalled();
				expect(createPuzzle).toHaveBeenCalledWith(
					'My Puzzle',
					225,
					expect.any(File),
					undefined,
					'1:1'
				);
			});

			await expect.element(page.getByText(/Puzzle creation started/)).toBeVisible();
		});

		it('auto-clears success message after timeout', async () => {
			vi.useFakeTimers();
			vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
			vi.mocked(normalizePuzzleImageFile).mockResolvedValue(
				new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' })
			);
			vi.mocked(createPuzzle).mockResolvedValue({} as any);
			render(AdminPage);

			const nameInput = page.getByPlaceholder('Enter puzzle name');
			await nameInput.fill('My Puzzle');
			const fileInput = page.getByLabelText('CLICK TO UPLOAD');
			const file = new File(['data'], 'test.jpg', { type: 'image/jpeg' });
			await fileInput.upload(file);

			await page.getByRole('button', { name: /CREATE MISSION/i }).click();
			await vi.waitFor(() => {
				expect(createPuzzle).toHaveBeenCalled();
			});

			await expect.element(page.getByText(/Puzzle creation started/)).toBeVisible();

			await vi.advanceTimersByTimeAsync(3000);
			await expect.element(page.getByText(/Puzzle creation started/)).not.toBeInTheDocument();
			vi.useRealTimers();
		});

		it('shows ApiError message on submit failure', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
			vi.mocked(normalizePuzzleImageFile).mockResolvedValue(
				new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' })
			);
			vi.mocked(createPuzzle).mockRejectedValue(
				new ApiError(400, 'bad_request', 'Invalid image format')
			);
			render(AdminPage);

			const nameInput = page.getByPlaceholder('Enter puzzle name');
			await nameInput.fill('My Puzzle');
			const fileInput = page.getByLabelText('CLICK TO UPLOAD');
			const file = new File(['data'], 'test.jpg', { type: 'image/jpeg' });
			await fileInput.upload(file);

			await page.getByRole('button', { name: /CREATE MISSION/i }).click();

			await expect.element(page.getByText('Invalid image format')).toBeVisible();
		});

		it('shows generic Error message on submit failure', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
			vi.mocked(normalizePuzzleImageFile).mockResolvedValue(
				new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' })
			);
			vi.mocked(createPuzzle).mockRejectedValue(new Error('Network failure'));
			render(AdminPage);

			const nameInput = page.getByPlaceholder('Enter puzzle name');
			await nameInput.fill('My Puzzle');
			const fileInput = page.getByLabelText('CLICK TO UPLOAD');
			const file = new File(['data'], 'test.jpg', { type: 'image/jpeg' });
			await fileInput.upload(file);

			await page.getByRole('button', { name: /CREATE MISSION/i }).click();

			await expect.element(page.getByText('Network failure')).toBeVisible();
		});

		it('shows fallback error when non-Error is thrown', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
			vi.mocked(normalizePuzzleImageFile).mockResolvedValue(
				new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' })
			);
			vi.mocked(createPuzzle).mockRejectedValue('string error');
			render(AdminPage);

			const nameInput = page.getByPlaceholder('Enter puzzle name');
			await nameInput.fill('My Puzzle');
			const fileInput = page.getByLabelText('CLICK TO UPLOAD');
			const file = new File(['data'], 'test.jpg', { type: 'image/jpeg' });
			await fileInput.upload(file);

			await page.getByRole('button', { name: /CREATE MISSION/i }).click();

			await expect.element(page.getByText('Failed to create puzzle')).toBeVisible();
		});
	});

	describe('handleImageSelect', () => {
		it('sets image preview on valid file selection', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
			render(AdminPage);

			const fileInput = page.getByLabelText('CLICK TO UPLOAD');
			const file = new File(['data'], 'test.jpg', { type: 'image/jpeg' });
			await fileInput.upload(file);

			await expect.element(page.getByAltText('Preview')).toBeVisible();
		});
	});

	describe('handleDelete', () => {
		it('does not delete when user cancels confirmation', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
			vi.spyOn(window, 'confirm').mockReturnValue(false);
			render(AdminPage);

			await vi.waitFor(() => {
				expect(page.getByText('Forest Scene')).toBeVisible();
			});

			await page.getByRole('button', { name: 'DELETE' }).first().click();

			expect(deletePuzzle).not.toHaveBeenCalled();
		});

		it('deletes successfully and reloads puzzles', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValueOnce(mockPuzzles).mockResolvedValueOnce([]);
			vi.spyOn(window, 'confirm').mockReturnValue(true);
			vi.mocked(deletePuzzle).mockResolvedValue(null);
			render(AdminPage);

			await vi.waitFor(() => {
				expect(page.getByText('Forest Scene')).toBeVisible();
			});

			await page.getByRole('button', { name: 'DELETE' }).first().click();

			await vi.waitFor(() => {
				expect(deletePuzzle).toHaveBeenCalledWith('p1', { force: false });
			});
		});

		it('shows warning message for partial success delete', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValueOnce(mockPuzzles).mockResolvedValueOnce([]);
			vi.spyOn(window, 'confirm').mockReturnValue(true);
			vi.mocked(deletePuzzle).mockResolvedValue({
				success: false,
				partialSuccess: true,
				warning: 'Some assets could not be deleted',
				failedAssets: ['img1']
			} as any);
			render(AdminPage);

			await vi.waitFor(() => {
				expect(page.getByText('Forest Scene')).toBeVisible();
			});

			await page.getByRole('button', { name: 'DELETE' }).first().click();

			await expect.element(page.getByText('Some assets could not be deleted')).toBeVisible();
		});

		it('shows alert on delete failure', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
			vi.spyOn(window, 'confirm').mockReturnValue(true);
			vi.mocked(deletePuzzle).mockRejectedValue(new Error('Delete failed'));
			const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
			render(AdminPage);

			await vi.waitFor(() => {
				expect(page.getByText('Forest Scene')).toBeVisible();
			});

			await page.getByRole('button', { name: 'DELETE' }).first().click();

			await vi.waitFor(() => {
				expect(alertSpy).toHaveBeenCalledWith('Failed to delete puzzle');
			});
		});

		it('shows ApiError message in alert on delete failure', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
			vi.spyOn(window, 'confirm').mockReturnValue(true);
			vi.mocked(deletePuzzle).mockRejectedValue(
				new ApiError(500, 'internal_error', 'Server error occurred')
			);
			const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
			render(AdminPage);

			await vi.waitFor(() => {
				expect(page.getByText('Forest Scene')).toBeVisible();
			});

			await page.getByRole('button', { name: 'DELETE' }).first().click();

			await vi.waitFor(() => {
				expect(alertSpy).toHaveBeenCalledWith('Server error occurred');
			});
		});

		it('sends force flag for processing puzzle delete', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValueOnce(mockPuzzles).mockResolvedValueOnce([]);
			vi.spyOn(window, 'confirm').mockReturnValue(true);
			vi.mocked(deletePuzzle).mockResolvedValue(null);
			render(AdminPage);

			await vi.waitFor(() => {
				expect(page.getByText('City Lights')).toBeVisible();
			});

			await page.getByRole('button', { name: 'FORCE DEL' }).click();

			await vi.waitFor(() => {
				expect(deletePuzzle).toHaveBeenCalledWith('p2', { force: true });
			});
		});
	});

	describe('handleAspectChange', () => {
		it('changes aspect ratio and resets piece count when current is invalid', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
			render(AdminPage);

			const selects = document.querySelectorAll('form select');
			const aspectSelectEl = selects[0] as HTMLSelectElement;
			const nativeInputValue = Object.getOwnPropertyDescriptor(
				HTMLSelectElement.prototype,
				'value'
			);
			nativeInputValue!.set!.call(aspectSelectEl, '4:3');
			aspectSelectEl.dispatchEvent(new Event('change', { bubbles: true }));

			await vi.waitFor(() => {
				const pieceSelectEl = document.querySelectorAll('form select')[1] as HTMLSelectElement;
				expect(pieceSelectEl.value).toBe('192');
			});
		});
	});

	describe('handlePieceCountChange', () => {
		it('updates piece count on selection change', async () => {
			vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
			render(AdminPage);

			const selects = document.querySelectorAll('form select');
			const pieceSelectEl = selects[1] as HTMLSelectElement;
			const nativeInputValue = Object.getOwnPropertyDescriptor(
				HTMLSelectElement.prototype,
				'value'
			);
			nativeInputValue!.set!.call(pieceSelectEl, '100');
			pieceSelectEl.dispatchEvent(new Event('change', { bubbles: true }));

			await vi.waitFor(() => {
				expect(pieceSelectEl.value).toBe('100');
			});
		});
	});

	describe('startPollingIfNeeded', () => {
		it('starts polling when processing puzzles exist and stops when done', async () => {
			const processingPuzzles: PuzzleSummary[] = [
				{
					id: 'p1',
					name: 'Processing One',
					pieceCount: 100,
					status: 'processing',
					progress: { generatedPieces: 10, totalPieces: 100, updatedAt: 0 }
				}
			];
			const readyPuzzles: PuzzleSummary[] = [
				{
					id: 'p1',
					name: 'Ready One',
					pieceCount: 100,
					status: 'ready'
				}
			];
			vi.mocked(fetchAdminPuzzles)
				.mockResolvedValueOnce(processingPuzzles)
				.mockResolvedValue(readyPuzzles);

			vi.useFakeTimers();
			render(AdminPage);

			await vi.waitFor(() => {
				expect(fetchAdminPuzzles).toHaveBeenCalledTimes(1);
			});

			await vi.advanceTimersByTimeAsync(3000);

			await vi.waitFor(() => {
				expect(fetchAdminPuzzles).toHaveBeenCalledTimes(2);
			});

			await vi.advanceTimersByTimeAsync(3000);

			expect(fetchAdminPuzzles).toHaveBeenCalledTimes(2);

			vi.useRealTimers();
		});
	});

	it('shows LOGGING OUT... text while logout is in progress', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		let resolveLogout!: () => void;
		vi.mocked(logout).mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					resolveLogout = resolve;
				})
		);
		render(AdminPage);
		await page.getByRole('button', { name: /LOGOUT/i }).click();
		await expect.element(page.getByRole('button', { name: /LOGGING OUT/i })).toBeVisible();
		await expect.element(page.getByRole('button', { name: /LOGGING OUT/i })).toBeDisabled();
		resolveLogout();
	});

	it('shows INITIALIZING... spinner while creating puzzle', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([]);
		vi.mocked(normalizePuzzleImageFile).mockImplementation(
			() =>
				new Promise<File>((resolve) => {
					resolve(new File(['normalized'], 'norm.jpg', { type: 'image/jpeg' }));
				})
		);
		vi.mocked(createPuzzle).mockImplementation(() => new Promise(() => {}));
		render(AdminPage);
		const nameInput = page.getByPlaceholder('Enter puzzle name');
		await nameInput.fill('My Puzzle');
		const fileInput = page.getByLabelText('CLICK TO UPLOAD');
		const file = new File(['data'], 'test.jpg', { type: 'image/jpeg' });
		await fileInput.upload(file);
		await page.getByRole('button', { name: /CREATE MISSION/i }).click();
		await expect.element(page.getByText(/INITIALIZING/)).toBeVisible();
	});

	it('shows ... on delete button while deletion is in progress', async () => {
		vi.mocked(fetchAdminPuzzles).mockResolvedValue(mockPuzzles);
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		let resolveDelete!: (value: any) => void;
		vi.mocked(deletePuzzle).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveDelete = resolve;
				})
		);
		render(AdminPage);
		await vi.waitFor(() => {
			expect(page.getByText('Forest Scene')).toBeVisible();
		});
		await page.getByRole('button', { name: 'DELETE' }).first().click();
		await expect.element(page.getByText('...')).toBeVisible();
		resolveDelete(null);
	});

	it('hides progress count for processing puzzle without progress data', async () => {
		vi.useFakeTimers();
		vi.mocked(fetchAdminPuzzles).mockResolvedValue([
			{
				id: 'p-no-progress',
				name: 'Stuck Puzzle',
				pieceCount: 100,
				status: 'processing'
			}
		]);
		render(AdminPage);
		await expect.element(page.getByText('Stuck Puzzle')).toBeVisible();
		await expect.element(page.getByText('PROCESSING')).toBeVisible();
		await expect.element(page.getByText('100 pieces', { exact: true }).nth(1)).toBeVisible();
		await expect.element(page.getByText(/\(\d+\/\d+\)/)).not.toBeInTheDocument();
		vi.useRealTimers();
	});
});
