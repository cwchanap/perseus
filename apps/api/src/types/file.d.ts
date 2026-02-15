// Type declarations for File/Blob methods missing from @cloudflare/workers-types
// These are available at runtime in the Workers environment

interface File extends Blob {
	slice(start?: number, end?: number, contentType?: string): Blob;
}

interface Blob {
	slice(start?: number, end?: number, contentType?: string): Blob;
}
