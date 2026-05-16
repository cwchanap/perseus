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
		(pieceInput as HTMLInputElement).dispatchEvent(new Event('input', { bubbles: true }));

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
});
