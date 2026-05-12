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
		await expect.element(page.getByText(/between 4 and 100/i)).toBeInTheDocument();
	});

	it('calls onSubmit with file + pieceCount + name', async () => {
		const onSubmit = vi.fn();
		render(QuickPuzzleUploader, { onSubmit });
		const file = makeFile('forest.jpg', 'image/jpeg');
		const fileInput = await page.getByLabelText(/image/i).element();
		(fileInput as HTMLInputElement).files = makeFileList([file]);
		(fileInput as HTMLInputElement).dispatchEvent(new Event('change', { bubbles: true }));

		const submit = page.getByRole('button', { name: /create puzzle/i });
		await submit.click();
		expect(onSubmit).toHaveBeenCalledWith({
			file,
			pieceCount: 24,
			name: 'forest'
		});
	});
});
