// Sniff image MIME from magic bytes so the served Content-Type is correct
// regardless of the (extension-less) avatar path. Mirrors R2 httpMetadata.
// Never trust the client-supplied Content-Type — validate the bytes instead.
//
// Shared by the Bun and Worker player routes, the puzzle upload path
// (detectImageType), and the CLI seed upload script.

// Minimal structural type for blob-like objects (File, Blob, Bun.BunFile).
// Avoids relying on the DOM/Worker `Blob` global, which is unavailable under
// tsconfigs with lib: ["ES2022"] (e.g. the scripts tsconfig).
export interface BlobLike {
	readonly size: number;
	slice(start?: number, end?: number): { arrayBuffer(): Promise<ArrayBuffer> };
	arrayBuffer(): Promise<ArrayBuffer>;
}

export function sniffImageType(bytes: Uint8Array): string | null {
	// Minimum 3 bytes — enough for the JPEG signature (FF D8 FF). PNG and WebP
	// have their own inline `bytes.length >= 8` / `>= 12` guards below, so the
	// old blanket `< 12` check was unnecessarily strict for JPEG. Lowered from
	// 12 to 3 in commit 744c961; boundary behavior is pinned in image.test.ts.
	if (bytes.length < 3) return null;
	// JPEG: FF D8 FF (3 magic bytes)
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	// PNG: 89 50 4E 47 0D 0A 1A 0A (8 magic bytes)
	if (
		bytes.length >= 8 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47 &&
		bytes[4] === 0x0d &&
		bytes[5] === 0x0a &&
		bytes[6] === 0x1a &&
		bytes[7] === 0x0a
	)
		return 'image/png';
	// WebP: RIFF....WEBP (12 magic bytes)
	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	)
		return 'image/webp';
	return null;
}

// Detect image MIME type from a File/Blob by reading its first 12 magic bytes.
// Delegates to sniffImageType for the byte-level logic. Works with File (DOM),
// Blob, and Bun.BunFile — all expose slice()/arrayBuffer() structurally.
export async function detectImageType(file: BlobLike): Promise<string | null> {
	try {
		const header = await file.slice(0, 12).arrayBuffer();
		return sniffImageType(new Uint8Array(header));
	} catch (error) {
		console.error('Failed to detect image type from file bytes:', error);
		return null;
	}
}

// Parse image width/height from binary headers without decoding the full image.
// Supports JPEG (SOF marker scan), PNG (IHDR at offset 16), and WebP
// (VP8/VP8L/VP8X chunk headers). Returns null if the format is unrecognized
// or the header is truncated — callers should proceed with fallback dimensions.
export async function parseImageDimensions(
	file: BlobLike,
	mimeType: string
): Promise<{ width: number; height: number } | null> {
	try {
		if (mimeType === 'image/png') {
			// PNG: width/height are 4-byte big-endian at offset 16–23
			const header = await file.slice(16, 24).arrayBuffer();
			if (header.byteLength < 8) return null;
			const view = new DataView(header);
			return { width: view.getUint32(0), height: view.getUint32(4) };
		}

		if (mimeType === 'image/jpeg') {
			// JPEG: scan SOF markers (FF C0..FF C3, FF C5..FF C7, FF C9..FF CB, FF CD..FF CF)
			// Height/width are at offset+5/offset+7 within each marker segment
			const buf = await file.slice(0, Math.min(file.size, 256 * 1024)).arrayBuffer();
			const bytes = new Uint8Array(buf);
			let offset = 2; // skip FF D8 SOI
			while (offset < bytes.length - 8) {
				if (bytes[offset] !== 0xff) break;
				const marker = bytes[offset + 1];
				// SOS (FF DA) or EOI (FF D9) — stop scanning
				if (marker === 0xda || marker === 0xd9) break;
				// Standalone markers (no payload)
				if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
					offset += 2;
					continue;
				}
				// SOF markers carry dimensions
				if (
					(marker >= 0xc0 && marker <= 0xc3) ||
					(marker >= 0xc5 && marker <= 0xc7) ||
					(marker >= 0xc9 && marker <= 0xcb) ||
					(marker >= 0xcd && marker <= 0xcf)
				) {
					const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
					if (segLen < 9 || offset + 9 > bytes.length) return null;
					const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
					const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
					return { width, height };
				}
				// Skip this marker segment
				if (offset + 4 > bytes.length) break;
				const segLen = (bytes[offset + 2] << 8) | bytes[offset + 3];
				offset += 2 + segLen;
			}
			return null;
		}

		if (mimeType === 'image/webp') {
			// WebP: check for VP8/VP8L/VP8X chunk
			// slice(12, 34) gives us up to 22 bytes: 4-byte fourCC + 4-byte chunk size +
			// up to 14 bytes of chunk data (enough for all three VP8 variants)
			const header = await file.slice(12, 34).arrayBuffer();
			if (header.byteLength < 8) return null;
			const decoder = new TextDecoder();
			const fourCC = decoder.decode(new Uint8Array(header, 0, 4));
			if (fourCC === 'VP8 ') {
				// Lossy: frame_tag(3) + sync(3) + width(2) + height(2) = 10 bytes
				// Relative to header start: 4(fourCC) + 4(chunkSize) + 6 = offset 14
				if (header.byteLength < 18) return null;
				const view = new DataView(header);
				const w = view.getUint16(14, true) & 0x3fff;
				const h = view.getUint16(16, true) & 0x3fff;
				return { width: w, height: h };
			}
			if (fourCC === 'VP8L') {
				// Lossless: 1-byte signature + 4-byte image-size packed as 28 bits
				// Relative to header: 4 + 4 + 1 = offset 9
				if (header.byteLength < 13) return null;
				const b = new DataView(header).getUint32(9, true);
				const w = (b & 0x3fff) + 1;
				const h = ((b >> 14) & 0x3fff) + 1;
				return { width: w, height: h };
			}
			if (fourCC === 'VP8X') {
				// Extended: 1-byte flags + 3-byte reserved + 3-byte canvas-width-1 + 3-byte canvas-height-1
				// Relative to header: 4(fourCC) + 4(chunkSize) + 1(flags) + 3(reserved) = offset 12 for width, offset 15 for height
				if (header.byteLength < 18) return null;
				const bytes = new Uint8Array(header);
				const w = (bytes[12] | (bytes[13] << 8) | (bytes[14] << 16)) + 1;
				const h = (bytes[15] | (bytes[16] << 8) | (bytes[17] << 16)) + 1;
				return { width: w, height: h };
			}
			return null;
		}

		return null;
	} catch (error) {
		console.error('Failed to parse image dimensions:', error);
		return null;
	}
}
