import net from 'node:net';

export async function assertPortFree(host: string, port: number): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const socket = net.connect({ host, port });
		socket.setTimeout(1_000);

		socket.once('connect', () => {
			socket.destroy();
			reject(
				new Error(
					`${host}:${port} is already occupied. Stop the owning process in its own workspace before re-running.`
				)
			);
		});

		socket.once('error', (error: NodeJS.ErrnoException) => {
			socket.destroy();
			if (error.code === 'ECONNREFUSED') {
				resolve();
				return;
			}
			reject(new Error(`Could not check ${host}:${port}: ${error.message}`));
		});

		socket.once('timeout', () => {
			socket.destroy();
			reject(new Error(`Timed out checking ${host}:${port}; treating the port as unavailable.`));
		});
	});
}
