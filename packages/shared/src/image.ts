// Sniff image MIME from magic bytes so the served Content-Type is correct
// regardless of the (extension-less) avatar path. Mirrors R2 httpMetadata.
// Never trust the client-supplied Content-Type — validate the bytes instead.
//
// Shared by the Bun and Worker player routes (and the puzzle upload path's
// detectImageType is a separate async helper that reads a File/Blob).
export function sniffImageType(bytes: Uint8Array): string | null {
	if (bytes.length < 12) return null;
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (
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
	if (
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
