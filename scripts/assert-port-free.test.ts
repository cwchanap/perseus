import { describe, expect, it } from 'bun:test';
import net from 'node:net';
import { assertPortFree } from './assert-port-free';

async function listenOnLoopback() {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		throw new Error('loopback listener did not expose a port');
	}
	return { server, port: address.port };
}

async function closeServer(server: net.Server) {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe('assertPortFree', () => {
	it('resolves when the port refuses connections', async () => {
		const { server, port } = await listenOnLoopback();
		await closeServer(server);

		await expect(assertPortFree('127.0.0.1', port)).resolves.toBeUndefined();
	});

	it('fails with an actionable error when the port is occupied', async () => {
		const { server, port } = await listenOnLoopback();
		try {
			await expect(assertPortFree('127.0.0.1', port)).rejects.toThrow(
				`127.0.0.1:${port} is already occupied. Stop the owning process in its own workspace before re-running.`
			);
		} finally {
			await closeServer(server);
		}
	});
});
