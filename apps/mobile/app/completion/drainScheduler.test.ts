import { describe, expect, it, vi } from 'vitest';
import { createDrainScheduler } from './drainScheduler';

function deferred(): {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: unknown) => void;
} {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

describe('createDrainScheduler', () => {
	it('shares one in-flight pass across overlapping triggers', async () => {
		const gate = deferred();
		const startPass = vi.fn(() => gate.promise);
		const scheduler = createDrainScheduler({
			startPass,
			currentEpoch: () => 0,
			onError: () => undefined
		});

		const first = scheduler.trigger();
		const second = scheduler.trigger();

		expect(startPass).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
		gate.resolve();
		await first;
	});

	it('runs exactly one follow-up pass for triggers arriving during a pass', async () => {
		const gate = deferred();
		const startPass = vi
			.fn<(epoch: number) => Promise<void>>()
			.mockImplementationOnce(() => gate.promise)
			.mockImplementation(() => Promise.resolve());
		const scheduler = createDrainScheduler({
			startPass,
			currentEpoch: () => 0,
			onError: () => undefined
		});

		void scheduler.trigger();
		void scheduler.trigger();
		void scheduler.trigger();
		gate.resolve();
		await gate.promise;
		await vi.waitFor(() => expect(startPass).toHaveBeenCalledTimes(2));

		// The follow-up settles on its own; the flag never stacks a third pass.
		await vi.waitFor(() => expect(startPass).toHaveBeenCalledTimes(2));
	});

	it('does not queue a follow-up pass when no trigger arrives during the pass', async () => {
		const startPass = vi.fn(() => Promise.resolve());
		const scheduler = createDrainScheduler({
			startPass,
			currentEpoch: () => 0,
			onError: () => undefined
		});

		await scheduler.trigger();

		expect(startPass).toHaveBeenCalledTimes(1);
	});

	it('captures the epoch at each pass start, including the requeued pass', async () => {
		const gate = deferred();
		let epoch = 0;
		const epochs: number[] = [];
		const startPass = vi.fn((captured: number) => {
			epochs.push(captured);
			return epochs.length === 1 ? gate.promise : Promise.resolve();
		});
		const scheduler = createDrainScheduler({
			startPass,
			currentEpoch: () => epoch,
			onError: () => undefined
		});

		void scheduler.trigger();
		void scheduler.trigger();
		epoch = 7; // e.g. a sign-out/sign-in between the two passes
		gate.resolve();
		await gate.promise;
		await vi.waitFor(() => expect(startPass).toHaveBeenCalledTimes(2));

		expect(epochs).toEqual([0, 7]);
	});

	it('still runs the follow-up pass when the first pass fails', async () => {
		const gate = deferred();
		const onError = vi.fn();
		const startPass = vi
			.fn<(epoch: number) => Promise<void>>()
			.mockImplementationOnce(() => gate.promise)
			.mockImplementation(() => Promise.resolve());
		const scheduler = createDrainScheduler({
			startPass,
			currentEpoch: () => 0,
			onError
		});

		void scheduler.trigger();
		void scheduler.trigger();
		gate.reject(new Error('drain_boom'));
		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(startPass).toHaveBeenCalledTimes(2));

		expect(onError).toHaveBeenCalledWith(expect.any(Error));
	});
});
