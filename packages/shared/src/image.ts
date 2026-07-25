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
			//
			// Cap the scan at SOF_SCAN_LIMIT to bound CPU on untrusted inputs
			// (avatar/player puzzle uploads up to MAX_FILE_SIZE/AVATAR_MAX_BYTES).
			// A crafted JPEG of millions of tiny marker segments (RST0-RST7,
			// TEM, fill bytes) could otherwise exhaust the Workers CPU budget
			// before reaching SOF/EOI/EOF. 2 MiB is generous — the largest
			// legitimate APP segments (ICC profiles, full EXIF) are well under
			// 64 KiB each, and JPEG segLen is a 16-bit field (max 65535), so
			// reaching 2 MiB requires ~30 max-length APP segments before SOF,
			// which no real encoder produces. Bail to null (callers reject)
			// rather than throwing so the untrusted route returns 400, not 500.
			const SOF_SCAN_LIMIT = 2 * 1024 * 1024;
			// Secondary cap on iteration count. The byte cap bounds data scanned
			// but not loop iterations: a crafted stream of 2-byte standalone
			// markers (FF D0 RST0 … FF D7 RST7, FF 01 TEM) advances only 2 bytes
			// per loop turn, so 2 MiB permits ~1M iterations of mostly-sync
			// work — enough to exhaust a Workers CPU budget even though the data
			// fits the byte cap. Legitimate JPEGs reach SOF in well under 500
			// iterations even with large ICC/EXIF segments (~30 max-length APP
			// segments is the extreme), so 10_000 is ~20x headroom and still
			// only a few ms of CPU.
			const SOF_ITERATION_LIMIT = 10_000;
			const CHUNK_SIZE = 64 * 1024;
			let pos = 2; // absolute file offset, skip FF D8 SOI
			let bufStart = 0;
			let iterations = 0;
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
				// Bail beyond the scan cap — see SOF_SCAN_LIMIT rationale above.
				if (pos > SOF_SCAN_LIMIT) return null;
				// Secondary defense: cap iterations so a tiny-marker flood
				// can't spin ~1M times within the byte cap. See
				// SOF_ITERATION_LIMIT rationale above.
				if (++iterations > SOF_ITERATION_LIMIT) return null;
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
// format's end marker AND that it contains actual image data (not just a
// header + trailer). parseImageDimensions only validates the header bytes;
// without the image-data check a file with a valid header prefix but no
// body (e.g. a PNG with an IHDR and IEND but no IDAT, or a JPEG with SOF
// and EOI but no SOS) would pass validation, be stored, and then fail in
// the decoder/generator — producing a 500 after R2 upload and metadata
// creation.
//
// The primary validation is a bounded decode via the runtime's native
// image decoder (Bun.Image in Bun; createImageBitmap in runtimes that
// expose it, e.g. browsers; @cf-wasm/photon in Cloudflare Workers). A
// successful decode proves the image is complete and valid — stronger
// than structural marker checks, which only verify marker presence
// without validating payload boundaries, CRC correctness, or
// decodability. The structural scanners are retained as a fallback for
// environments where no native decoder is available.
//
// Format-specific structural checks (fallback):
// - PNG: must end with an IEND chunk AND contain at least one IDAT chunk
//   (image data) before IEND.
// - JPEG: must contain an EOI marker (FF D9) near the end (allow trailing
//   fill bytes) AND contain an SOS marker (start of scan) before EOI.
// - WebP: RIFF file size at offset 4-7 must not exceed the actual file
//   size AND the file must contain a VP8, VP8L, or ANMF chunk (actual
//   image frame data), not just a VP8X container header.

// Cap structural scans at 2 MiB to bound CPU on untrusted inputs. A crafted
// file with millions of tiny chunks/markers could otherwise exhaust the
// Workers CPU budget before reaching image data. Legitimate images place
// IDAT/SOS/VP8 well within the first 2 MiB.
const STRUCTURAL_SCAN_LIMIT = 2 * 1024 * 1024;

// Cap structural scanner iterations. The byte cap (STRUCTURAL_SCAN_LIMIT)
// bounds data scanned but not loop iterations: a crafted stream of
// zero-length chunks (12 bytes each for PNG, 8 bytes each for WebP) can
// produce ~174k (PNG) or ~262k (WebP) iterations within 2 MiB — each
// performing a separate async slice().arrayBuffer() — enough to exhaust
// a Workers CPU budget. Legitimate images have well under 1,000 chunks.
// 10,000 is ~10x headroom and matches the JPEG scanner's existing cap.
const STRUCTURAL_ITERATION_LIMIT = 10_000;

/**
 * Scan PNG chunks from offset 8 (after the 8-byte signature) and return true
 * if at least one IDAT chunk is found before IEND. Each PNG chunk is:
 *   4-byte big-endian length + 4-byte type + length bytes data + 4-byte CRC
 * Total chunk size = length + 12. Returns false if IEND is reached without
 * IDAT, or if the chunk chain is malformed/truncated.
 */
async function pngHasIDAT(file: BlobLike): Promise<boolean> {
	const size = file.size;
	let pos = 8; // Skip PNG signature
	const scanEnd = Math.min(size, STRUCTURAL_SCAN_LIMIT);
	let iterations = 0;
	while (pos + 8 <= scanEnd) {
		if (++iterations > STRUCTURAL_ITERATION_LIMIT) return false;
		const header = new Uint8Array(await file.slice(pos, pos + 8).arrayBuffer());
		if (header.byteLength < 8) return false;
		const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
		const length = dv.getUint32(0);
		const type = String.fromCharCode(header[4], header[5], header[6], header[7]);
		if (type === 'IDAT') return true;
		if (type === 'IEND') return false;
		// Advance past this chunk: length(data) + 4(length) + 4(type) + 4(CRC)
		const next = pos + length + 12;
		// Guard against overflow / malformed length that would loop forever
		if (next <= pos || next > size) return false;
		pos = next;
	}
	return false;
}

/**
 * Scan JPEG markers from offset 2 (after SOI FF D8) and return true if an
 * SOS marker (FF DA, start of scan) is found before EOI (FF D9). Without
 * SOS, the JPEG has no compressed image data — just headers. Reuses the
 * same marker-walking logic as parseImageDimensions (fill byte handling,
 * standalone markers, segment skipping) but looks for SOS instead of SOF.
 */
async function jpegHasSOS(file: BlobLike): Promise<boolean> {
	const CHUNK_SIZE = 64 * 1024;
	let pos = 2; // Skip SOI (FF D8)
	let bufStart = 0;
	let iterations = 0;
	let buf = new Uint8Array(await file.slice(0, Math.min(file.size, CHUNK_SIZE)).arrayBuffer());

	async function refill(): Promise<boolean> {
		if (bufStart + buf.length >= file.size) return false;
		bufStart = pos;
		const end = Math.min(file.size, pos + CHUNK_SIZE);
		buf = new Uint8Array(await file.slice(pos, end).arrayBuffer());
		return buf.length > 0;
	}

	async function ensure(need: number): Promise<boolean> {
		if (pos - bufStart + need <= buf.length) return true;
		if (!(await refill())) return false;
		return pos - bufStart + need <= buf.length;
	}

	while (true) {
		if (pos > STRUCTURAL_SCAN_LIMIT) return false;
		if (++iterations > 10_000) return false;
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

		// SOS (FF DA) — start of scan, image data follows
		if (marker === 0xda) return true;
		// EOI (FF D9) — end of image, reached without SOS
		if (marker === 0xd9) return false;
		// Standalone markers (no payload): RST0-RST7, TEM
		if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;

		// Skip this marker segment: read 2-byte segLen, advance by segLen.
		if (!(await ensure(2))) break;
		const i = pos - bufStart;
		const segLen = (buf[i] << 8) | buf[i + 1];
		if (segLen < 2) return false;
		pos += segLen;
	}
	return false;
}

/**
 * Scan WebP chunks from offset 12 (after RIFF + size + WEBP) and return true
 * if a VP8, VP8L, or ANMF chunk is found. A VP8X (extended container) chunk
 * alone is not sufficient — it carries only canvas dimensions and flags, not
 * image data. Each WebP chunk is: 4-byte fourCC + 4-byte little-endian
 * chunkSize + chunkSize bytes data (padded to even size).
 */
async function webpHasImageChunk(file: BlobLike, riffBoundary: number): Promise<boolean> {
	const size = file.size;
	let pos = 12; // Skip RIFF + size + WEBP
	// Stop at the declared RIFF boundary, not file.size — trailing bytes
	// beyond the RIFF container are not valid WebP chunks and could cause
	// the scanner to misinterpret arbitrary data as chunk headers.
	const scanEnd = Math.min(riffBoundary, STRUCTURAL_SCAN_LIMIT);
	let iterations = 0;
	while (pos + 8 <= scanEnd) {
		if (++iterations > STRUCTURAL_ITERATION_LIMIT) return false;
		const header = new Uint8Array(await file.slice(pos, pos + 8).arrayBuffer());
		if (header.byteLength < 8) return false;
		const fourCC = String.fromCharCode(header[0], header[1], header[2], header[3]);
		if (fourCC === 'VP8 ' || fourCC === 'VP8L' || fourCC === 'ANMF') return true;
		const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
		const chunkSize = dv.getUint32(4, true);
		// Advance past chunk header (8) + data (chunkSize) + padding to even
		const padded = chunkSize + (chunkSize % 2);
		const next = pos + 8 + padded;
		if (next <= pos || next > size) return false;
		pos = next;
	}
	return false;
}

/**
 * Attempt a bounded decode of the image using the runtime's native decoder.
 * A successful decode proves the image is complete and valid — stronger than
 * structural marker checks. Returns:
 *   true  — decode succeeded (image is valid)
 *   false — decode failed (image is corrupt)
 *   null  — no native decoder available (caller should fall back to structural)
 *
 * Decoder selection order:
 * 1. createImageBitmap — browsers and runtimes that expose the Web
 *    ImageBitmap API. As of this writing Cloudflare Workers does NOT expose
 *    createImageBitmap.
 * 2. Bun.Image — Bun runtime. Uses a terminal call (bytes()) to force a
 *    full decode; metadata() only reads the header.
 * 3. @cf-wasm/photon — WebAssembly image decoder that works in Cloudflare
 *    Workers. Loaded via dynamic import so the WASM module is only bundled
 *    by apps that actually call this code path. If the package is not
 *    installed the import fails and we fall through to structural validation.
 * The decode is bounded by the caller's MAX_FILE_SIZE check (already
 * performed before this function is called) and the runtime's CPU limit.
 */
async function boundedDecode(file: BlobLike, mimeType: string): Promise<boolean | null> {
	let bytes: ArrayBuffer;
	try {
		bytes = await file.arrayBuffer();
	} catch {
		return false;
	}

	// createImageBitmap path: available in browsers and any runtime that
	// exposes the Web ImageBitmap API. The spec requires a Blob (or other
	// ImageBitmapSource), NOT a raw ArrayBuffer — passing ArrayBuffer is
	// rejected by spec-compliant implementations. Wrap in a Blob with the
	// sniffed MIME type so the decoder selects the right codec. Throws on
	// corrupt/truncated input. Close the bitmap to release memory promptly.
	type ImageBitmapLike = { close(): void };
	const createImageBitmapFn = (
		globalThis as { createImageBitmap?: (input: Blob) => Promise<ImageBitmapLike> }
	).createImageBitmap;
	if (typeof createImageBitmapFn === 'function') {
		const blob = new Blob([bytes], { type: mimeType });
		try {
			const bitmap = await createImageBitmapFn(blob);
			try {
				return true;
			} finally {
				bitmap.close();
			}
		} catch {
			return false;
		}
	}

	// Bun path: Bun.Image decodes lazily — a terminal call (bytes()) forces
	// a full decode. metadata() only reads the header, so it is insufficient.
	const BunGlobal = (
		globalThis as { Bun?: { Image?: new (input: ArrayBuffer) => { bytes(): Promise<Uint8Array> } } }
	).Bun;
	if (BunGlobal && typeof BunGlobal.Image === 'function') {
		try {
			const img = new BunGlobal.Image(bytes);
			await img.bytes();
			return true;
		} catch {
			return false;
		}
	}

	// @cf-wasm/photon path: a WebAssembly image decoder that works in
	// Cloudflare Workers (where neither createImageBitmap nor Bun.Image is
	// available). PhotonImage.new_from_byteslice() calls image::load_from_memory
	// under the hood, which fully decodes the image into a pixel buffer —
	// proving the image is complete and valid. Throws on corrupt/truncated
	// input. The dynamic import resolves from the consuming app's node_modules;
	// if the package is not installed the import rejects and we fall through
	// to structural validation (return null). The WASM module is ~1.6 MB
	// uncompressed but is only bundled by apps that reach this code path.
	type PhotonImageLike = { get_width(): number; free(): void };
	type PhotonModuleLike = {
		PhotonImage: { new_from_byteslice(vec: Uint8Array): PhotonImageLike };
	};
	try {
		const photon = (await import('@cf-wasm/photon')) as PhotonModuleLike;
		if (photon?.PhotonImage) {
			try {
				const image = photon.PhotonImage.new_from_byteslice(new Uint8Array(bytes));
				try {
					// get_width() forces the decode to complete and confirms
					// the image has valid dimensions.
					const w = image.get_width();
					return w > 0;
				} finally {
					image.free();
				}
			} catch {
				return false;
			}
		}
	} catch {
		// @cf-wasm/photon not installed — fall through to structural validation
	}

	return null;
}

/**
 * Structural validation fallback: check format-specific end markers and
 * image-data markers without fully decoding. Used when no native decoder
 * is available. Exported for direct testing of the fallback path.
 */
export async function validateImageStructural(file: BlobLike, mimeType: string): Promise<boolean> {
	try {
		const size = file.size;

		if (mimeType === 'image/png') {
			// PNG must end with an IEND chunk: 00 00 00 00 49 45 4E 44 AE 42 60 82
			if (size < 12) return false;
			const tail = new Uint8Array(await file.slice(size - 12, size).arrayBuffer());
			const hasIEND =
				tail[4] === 0x49 && // I
				tail[5] === 0x45 && // E
				tail[6] === 0x4e && // N
				tail[7] === 0x44 && // D
				tail[8] === 0xae &&
				tail[9] === 0x42 &&
				tail[10] === 0x60 &&
				tail[11] === 0x82;
			if (!hasIEND) return false;
			// Require at least one IDAT chunk (actual image data) before IEND.
			// A PNG with only IHDR + IEND has no image data and will fail in
			// the decoder — reject it at validation time rather than after
			// R2 upload and metadata creation.
			return await pngHasIDAT(file);
		}

		if (mimeType === 'image/jpeg') {
			// JPEG must end with EOI marker (FF D9). Some encoders append
			// trailing fill/padding bytes after EOI, so search the last 1KB
			// backwards for the marker instead of requiring it at the exact
			// last 2 bytes.
			if (size < 4) return false;
			const tailLen = Math.min(size, 1024);
			const tail = new Uint8Array(await file.slice(size - tailLen, size).arrayBuffer());
			let hasEOI = false;
			for (let i = tail.length - 2; i >= 0; i--) {
				if (tail[i] === 0xff && tail[i + 1] === 0xd9) {
					hasEOI = true;
					break;
				}
			}
			if (!hasEOI) return false;
			// Require an SOS marker (start of scan) before EOI. A JPEG with
			// only SOF + EOI has headers but no compressed image data and
			// will fail in the decoder.
			return await jpegHasSOS(file);
		}

		if (mimeType === 'image/webp') {
			// RIFF file: bytes 4-7 (little-endian uint32) = file size minus 8.
			// The actual file must be at least that large; a truncated file
			// would have fewer bytes than declared. Read the length via
			// DataView.getUint32 (unsigned) — assembling it with signed JS
			// bitwise operators (header[7] << 24) yields a negative number
			// when the high bit is set, and `size >= negative` is always
			// true, so a truncated WebP with a high-bit length byte would
			// bypass the check. Also reject a zero/nonsense declared length:
			// a valid WebP needs at least "RIFF" + size + "WEBP" (12 bytes),
			// so riffSize must be ≥ 12.
			if (size < 12) return false;
			const header = new Uint8Array(await file.slice(0, 8).arrayBuffer());
			const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
			const riffSize = dv.getUint32(4, true) + 8;
			if (!(riffSize >= 12 && size >= riffSize)) return false;
			// Require a VP8, VP8L, or ANMF chunk (actual image frame data).
			// A VP8X-only WebP (extended container header with canvas dims
			// but no frame) has no decodable image data. Scan only within
			// the declared RIFF boundary — trailing bytes beyond it are not
			// valid WebP chunks.
			return await webpHasImageChunk(file, riffSize);
		}

		// Unknown format — fail safe (reject) rather than allow potentially
		// corrupt data through.
		return false;
	} catch (error) {
		console.error('Failed to validate image end marker:', error);
		return false;
	}
}

export async function validateImageEndMarker(file: BlobLike, mimeType: string): Promise<boolean> {
	// Primary: bounded decode via the runtime's native decoder. A successful
	// decode proves the image is complete and valid — stronger than structural
	// marker checks, which only verify marker presence without validating
	// payload boundaries, CRC correctness, or decodability.
	const decoded = await boundedDecode(file, mimeType);
	if (decoded !== null) return decoded;
	// Fallback: structural validation when no native decoder is available.
	return validateImageStructural(file, mimeType);
}
