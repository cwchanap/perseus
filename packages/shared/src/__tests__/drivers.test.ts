import { describe, it, expect } from 'vitest';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBunDb } from '../drivers/bun';
import { getPlayerSummary } from '../repositories';

describe('createBunDb', () => {
	it('creates a migrated db and serves repositories', async () => {
		const dir = join(tmpdir(), `perseus-bun-driver-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const db = createBunDb(dir);
		const summary = await getPlayerSummary(db, 'p1');
		expect(summary.puzzlesUploaded).toBe(0);
		rmSync(dir, { recursive: true, force: true });
	});
});
