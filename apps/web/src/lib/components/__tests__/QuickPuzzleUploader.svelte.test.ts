import { describe, it, expect, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import QuickPuzzleUploader from '../QuickPuzzleUploader.svelte';

function makeFile(name: string, type: string, sizeBytes = 100): File {
	return new File([new Uint8Array(sizeBytes)], name, { type });
}

function makeFileList(files: File[]): FileList {
	const dt = new DataTransfer();
	for (const f of files) dt.items.add(f);
	return dt.files;
}

describe('QuickPuzzleUploader', () => {
	it('disables submit until a file is selected', async () => {
		render(QuickPuzzleUploader, { onSubmit: vi.fn() });
		const submit = page.getByRole('button', { name: /create puzzle/i });
		await expect.element(submit).toBeDisabled();
	});

	it('auto-fills name from filename', async () => {
		render(QuickPuzzleUploader, { onSubmit: vi.fn() });
		const fileInput = await page.getByLabelText(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([makeFile('beach.jpg', 'image/jpeg')]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));

		const nameInput = page.getByLabelText(/name/i);
		await expect.element(nameInput).toHaveValue('beach');
	});

	it('shows inline error for unsupported MIME', async () => {
		render(QuickPuzzleUploader, { onSubmit: vi.fn() });
		const fileInput = await page.getByLabelText(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([makeFile('a.gif', 'image/gif')]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
		await expect.element(page.getByText(/JPEG, PNG, or WebP/)).toBeInTheDocument();
	});

	it('shows inline error for files > 20 MB', async () => {
		render(QuickPuzzleUploader, { onSubmit: vi.fn() });
		const fileInput = await page.getByLabelText(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([
			makeFile('big.jpg', 'image/jpeg', 21 * 1024 * 1024)
		]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
		await expect.element(page.getByText(/max 20 MB/i)).toBeInTheDocument();
	});

	it('rejects piece counts outside 4–100', async () => {
		const onSubmit = vi.fn();
		render(QuickPuzzleUploader, { onSubmit });
		const fileInput = await page.getByLabelText(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([makeFile('a.jpg', 'image/jpeg')]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));

		const pieceInput = await page.getByLabelText(/pieces/i).element();
		(pieceInput as HTMLInputElement).value = '3';
		(pieceInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));

		const submit = page.getByRole('button', { name: /create puzzle/i });
		await submit.click();
		expect(onSubmit).not.toHaveBeenCalled();
		await expect.element(page.getByText(/valid 1:1 piece count/i)).toBeInTheDocument();
	});

	it('limits piece choices to the selected aspect ratio', async () => {
		render(QuickPuzzleUploader, { onSubmit: vi.fn() });

		const aspectSelect = await page.getByLabelText(/aspect ratio/i).element();
		(aspectSelect as HTMLSelectElement).value = '4:3';
		(aspectSelect as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }));

		const pieceSelect = await page.getByLabelText(/pieces/i).element();
		const values = Array.from((pieceSelect as HTMLSelectElement).options).map(
			(option) => option.value
		);

		expect(values).toEqual(['12', '48']);
		expect((pieceSelect as HTMLSelectElement).value).toBe('48');
	});

	it('calls onSubmit with file + aspectRatio + pieceCount + name', async () => {
		const onSubmit = vi.fn();
		render(QuickPuzzleUploader, { onSubmit });
		const file = makeFile('forest.jpg', 'image/jpeg');
		const fileInput = await page.getByLabelText(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([file]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));

		const aspectSelect = await page.getByLabelText(/aspect ratio/i).element();
		(aspectSelect as HTMLSelectElement).value = '3:4';
		(aspectSelect as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }));

		const submit = page.getByRole('button', { name: /create puzzle/i });
		await submit.click();
		expect(onSubmit).toHaveBeenCalledWith({
			file,
			aspectRatio: '3:4',
			pieceCount: 48,
			name: 'forest'
		});
	});

	it('clears file when no file selected in change event', async () => {
		const onSubmit = vi.fn();
		render(QuickPuzzleUploader, { onSubmit });
		const fileInput = await page.getByLabelText(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([makeFile('a.jpg', 'image/jpeg')]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
		const submit = page.getByRole('button', { name: /create puzzle/i });
		await expect.element(submit).toBeEnabled();
		(fileInput as HTMLInputElement).files = makeFileList([]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
		await expect.element(submit).toBeDisabled();
	});

	it('derives name from filename without extension', async () => {
		render(QuickPuzzleUploader, { onSubmit: vi.fn() });
		const fileInput = await page.getByLabelText(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([makeFile('nodot', 'image/jpeg')]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
		await expect.element(page.getByLabelText(/name/i)).toHaveValue('nodot');
	});

	it('uses derived name when name field is empty on submit', async () => {
		const onSubmit = vi.fn();
		render(QuickPuzzleUploader, { onSubmit });
		const file = makeFile('forest.jpg', 'image/jpeg');
		const fileInput = await page.getByLabelText(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([file]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
		await page.getByLabelText(/name/i).fill('');
		const submit = page.getByRole('button', { name: /create puzzle/i });
		await submit.click();
		expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: 'forest' }));
	});

	it('does not change aspect ratio for invalid value', async () => {
		render(QuickPuzzleUploader, { onSubmit: vi.fn() });
		const aspectSelect = await page.getByLabelText(/aspect ratio/i).element();
		(aspectSelect as HTMLSelectElement).value = '16:9';
		(aspectSelect as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }));
		const pieceSelect = await page.getByLabelText(/pieces/i).element();
		const values = Array.from((pieceSelect as HTMLSelectElement).options).map(
			(option) => option.value
		);
		expect(values).toContain('16');
	});

	it('shows progress bar when busy and progress provided', async () => {
		render(QuickPuzzleUploader, {
			onSubmit: vi.fn(),
			busy: true,
			progress: { done: 2, total: 4 }
		});
		await expect.element(page.getByText(/Generating piece 2\/4/)).toBeInTheDocument();
	});

	it('shows generating text when busy', async () => {
		render(QuickPuzzleUploader, { onSubmit: vi.fn(), busy: true });
		await expect.element(page.getByRole('button', { name: /generating/i })).toBeInTheDocument();
	});

	it('resets piece count to default when switching aspect ratio', async () => {
		const onSubmit = vi.fn();
		render(QuickPuzzleUploader, { onSubmit });
		const file = makeFile('test.jpg', 'image/jpeg');
		const fileInput = await page.getByLabelText(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([file]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
		const aspectSelect = await page.getByLabelText(/aspect ratio/i).element();
		(aspectSelect as HTMLSelectElement).value = '4:3';
		(aspectSelect as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }));
		const submit = page.getByRole('button', { name: /create puzzle/i });
		await submit.click();
		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({ pieceCount: 48, aspectRatio: '4:3' })
		);
	});

	it('hides error after selecting a valid file', async () => {
		render(QuickPuzzleUploader, { onSubmit: vi.fn() });
		const fileInput = await page.getByLabelText(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([makeFile('a.gif', 'image/gif')]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
		await expect.element(page.getByText(/JPEG, PNG, or WebP/)).toBeInTheDocument();
		(fileInput as HTMLInputElement).files = makeFileList([makeFile('b.jpg', 'image/jpeg')]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));
		await expect.element(page.getByText(/JPEG, PNG, or WebP/)).not.toBeInTheDocument();
	});

	it('hides progress bar when busy without progress data', async () => {
		render(QuickPuzzleUploader, { onSubmit: vi.fn(), busy: true });
		await expect.element(page.getByRole('button', { name: /generating/i })).toBeInTheDocument();
		await expect.element(page.getByTestId('quick-uploader-progress')).not.toBeInTheDocument();
	});

	it('shows progress section when total is zero', async () => {
		render(QuickPuzzleUploader, {
			onSubmit: vi.fn(),
			busy: true,
			progress: { done: 0, total: 0 }
		});
		await expect.element(page.getByTestId('quick-uploader-progress')).toBeVisible();
		await expect.element(page.getByText(/Generating piece 0\/0/)).toBeInTheDocument();
	});
});
