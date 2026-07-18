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
	// Minimum 3 bytes for the initial length check. Each format has its own
	// inline guard below. JPEG requires 4 bytes (SOI FF D8 + FF + at least one
	// marker code byte) — the 3-byte signature FF D8 FF alone is a truncated
	// header, not a valid image. PNG needs 8 bytes, WebP needs 12.
	if (bytes.length < 3) return null;
	// JPEG: FF D8 FF + marker code (minimum 4 bytes — the 3-byte SOI prefix
	// alone is truncated and dimension parsing would return null, leaving
	// callers to proceed with malformed bytes instead of rejecting them).
	// The fourth byte must not be 0x00 (byte-stuffing, only valid inside
	// entropy-coded segments — never at the marker level after SOI). 0xFF is
	// a valid fill byte (consumed individually before the real marker); any
	// other non-zero value is a marker code. Rejecting 0x00 prevents
	// malformed uploads like FF D8 FF 00 from being labeled JPEG and stored.
	if (
		bytes.length >= 4 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff &&
		bytes[3] !== 0x00
	)
		return 'image/jpeg';
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
// or the header is truncated. Returns raw dimensions (including zero/negative)
// so callers that check for null (e.g. avatar routes) can distinguish
// "unparseable" from "parsed but invalid" — callers that use aspectRatiosMatch
// get zero/negative dims rejected by that function's own guard.
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
			// Height/width are at offset+5/offset+7 within each marker segment.
			// Read in chunks to handle JPEGs with large APP segments (EXIF, ICC
			// profiles) that push the SOF marker beyond any fixed read limit.
			// Fill bytes (0xFF 0xFF…) are consumed individually per the JPEG spec:
			// multiple 0xFF bytes can precede a marker, each is a fill byte, not
			// a marker pair.
			const CHUNK_SIZE = 64 * 1024;
			let pos = 2; // absolute file offset, skip FF D8 SOI
			let bufStart = 0;
			let buf = new Uint8Array(await file.slice(0, Math.min(file.size, CHUNK_SIZE)).arrayBuffer());

			// Refill buf so that pos is within the buffer; returns false at EOF.
			async function refill(): Promise<boolean> {
				if (bufStart + buf.length >= file.size) return false;
				bufStart = pos;
				const end = Math.min(file.size, pos + CHUNK_SIZE);
				buf = new Uint8Array(await file.slice(pos, end).arrayBuffer());
				return buf.length > 0;
			}

			// Ensure `need` bytes are available from pos in buf; refill if needed.
			async function ensure(need: number): Promise<boolean> {
				if (pos - bufStart + need <= buf.length) return true;
				if (!(await refill())) return false;
				return pos - bufStart + need <= buf.length;
			}

			while (true) {
				// Expect 0xFF marker prefix
				if (!(await ensure(1))) break;
				if (buf[pos - bufStart] !== 0xff) break;
				pos += 1;

				// Consume 0xFF fill bytes individually
				while ((await ensure(1)) && buf[pos - bufStart] === 0xff) {
					pos += 1;
				}
				if (!(await ensure(1))) break;
				const marker = buf[pos - bufStart];
				pos += 1;

				// SOS (FF DA) or EOI (FF D9) — stop scanning
				if (marker === 0xda || marker === 0xd9) break;
				// Standalone markers (no payload): RST0-RST7, TEM
				if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;

				// SOF markers carry dimensions
				if (
					(marker >= 0xc0 && marker <= 0xc3) ||
					(marker >= 0xc5 && marker <= 0xc7) ||
					(marker >= 0xc9 && marker <= 0xcb) ||
					(marker >= 0xcd && marker <= 0xcf)
				) {
					// Need 7 bytes: segLen(2) + precision(1) + height(2) + width(2)
					if (!(await ensure(7))) return null;
					const i = pos - bufStart;
					const segLen = (buf[i] << 8) | buf[i + 1];
					// SOF minimum: Lf(2) + P(1) + Y(2) + X(2) + Nf(1) + 3*Nf
					// with Nf >= 1 → Lf >= 11. Reject anything shorter.
					if (segLen < 11) return null;
					// Reject truncated SOF: the full declared segment must be present
					// in the file. `ensure(7)` only guarantees the dimension fields;
					// a larger segLen with EOF mid-segment would still return dims.
					if (pos + segLen > file.size) return null;
					const height = (buf[i + 3] << 8) | buf[i + 4];
					const width = (buf[i + 5] << 8) | buf[i + 6];
					return { width, height };
				}

				// Skip this marker segment: read 2-byte segLen, advance by segLen.
				// Per the JPEG spec, segLen includes the 2-byte length field itself,
				// so the minimum valid value is 2. Reject anything smaller — a
				// segLen of 0 or 1 is malformed and would advance pos by less than
				// the length field width, leaving the parser misaligned.
				if (!(await ensure(2))) break;
				const i = pos - bufStart;
				const segLen = (buf[i] << 8) | buf[i + 1];
				if (segLen < 2) return null;
				pos += segLen;
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
				// Encoded as (width-1)/(height-1), so decoded values are always ≥ 1.
				if (header.byteLength < 13) return null;
				const b = new DataView(header).getUint32(9, true);
				const w = (b & 0x3fff) + 1;
				const h = ((b >>> 14) & 0x3fff) + 1;
				return { width: w, height: h };
			}
			if (fourCC === 'VP8X') {
				// Extended: 1-byte flags + 3-byte reserved + 3-byte canvas-width-1 + 3-byte canvas-height-1
				// Relative to header: 4(fourCC) + 4(chunkSize) + 1(flags) + 3(reserved) = offset 12 for width, offset 15 for height
				// Encoded as (width-1)/(height-1), so decoded values are always ≥ 1.
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

// Validate that the image file is structurally complete by checking for the
// format's end marker. parseImageDimensions only validates the header bytes;
// without this check a file with a valid header prefix but missing body/trailer
// (e.g. a PNG with an IHDR but no IDAT or IEND) would pass validation and be
// stored as a corrupt avatar that renders broken for the player.
//
// Format-specific checks:
// - PNG: must end with an IEND chunk (12 bytes: 4-byte zero length + "IEND" + CRC AE 42 60 82)
// - JPEG: must contain an EOI marker (FF D9) near the end (allow trailing fill bytes)
// - WebP: RIFF file size at offset 4-7 must not exceed the actual file size
export async function validateImageEndMarker(file: BlobLike, mimeType: string): Promise<boolean> {
	try {
		const size = file.size;

		if (mimeType === 'image/png') {
			// PNG must end with an IEND chunk: 00 00 00 00 49 45 4E 44 AE 42 60 82
			if (size < 12) return false;
			const tail = new Uint8Array(await file.slice(size - 12, size).arrayBuffer());
			return (
				tail[4] === 0x49 && // I
				tail[5] === 0x45 && // E
				tail[6] === 0x4e && // N
				tail[7] === 0x44 && // D
				tail[8] === 0xae &&
				tail[9] === 0x42 &&
				tail[10] === 0x60 &&
				tail[11] === 0x82
			);
		}

		if (mimeType === 'image/jpeg') {
			// JPEG must end with EOI marker (FF D9). Some encoders append
			// trailing fill/padding bytes after EOI, so search the last 1KB
			// backwards for the marker instead of requiring it at the exact
			// last 2 bytes.
			if (size < 4) return false;
			const tailLen = Math.min(size, 1024);
			const tail = new Uint8Array(await file.slice(size - tailLen, size).arrayBuffer());
			for (let i = tail.length - 2; i >= 0; i--) {
				if (tail[i] === 0xff && tail[i + 1] === 0xd9) return true;
			}
			return false;
		}

		if (mimeType === 'image/webp') {
			// RIFF file: bytes 4-7 (little-endian uint32) = file size minus 8.
			// The actual file must be at least that large; a truncated file
			// would have fewer bytes than declared.
			if (size < 12) return false;
			const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
			const riffSize = (header[4] | (header[5] << 8) | (header[6] << 16) | (header[7] << 24)) + 8;
			return size >= riffSize;
		}

		// Unknown format — fail safe (reject) rather than allow potentially
		// corrupt data through.
		return false;
	} catch (error) {
		console.error('Failed to validate image end marker:', error);
		return false;
	}
}
