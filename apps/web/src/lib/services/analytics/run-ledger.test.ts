import { describe, expect, it } from 'vitest';
import {
	ANALYTICS_RUN_LEDGER_KEY,
	ANALYTICS_RUN_LEDGER_MAX_EVENTS_PER_RUN,
	ANALYTICS_RUN_LEDGER_MAX_RUNS,
	ANALYTICS_RUN_LEDGER_RETENTION_MS,
	ANALYTICS_RUN_LEDGER_SCHEMA_VERSION,
	createAnalyticsRunLedger
} from './run-ledger';

const runA = '11111111-1111-4111-8111-111111111111';
const runB = '22222222-2222-4222-8222-222222222222';

function makeStorage(initial: Record<string, string> = {}): Storage {
	const values = new Map(Object.entries(initial));
	return {
		get length() {
			return values.size;
		},
		clear() {
			values.clear();
		},
		getItem(key) {
			return values.get(key) ?? null;
		},
		key(index) {
			return [...values.keys()][index] ?? null;
		},
		removeItem(key) {
			values.delete(key);
		},
		setItem(key, value) {
			values.set(key, value);
		}
	};
}

function mark(
	ledger: ReturnType<typeof createAnalyticsRunLedger>,
	overrides: Partial<{
		eventSchemaVersion: 1;
		eventName:
			| 'puzzle_opened'
			| 'first_piece_placed'
			| 'hint_used'
			| 'reference_used'
			| 'puzzle_completed'
			| 'personal_best_beaten';
		runId: string;
		recordedAt: number;
	}> = {}
) {
	return ledger.markIfNew({
		eventSchemaVersion: 1,
		eventName: 'puzzle_opened',
		runId: runA,
		recordedAt: 1_000,
		...overrides
	});
}

function read(storage: Storage): unknown {
	return JSON.parse(storage.getItem(ANALYTICS_RUN_LEDGER_KEY) ?? 'null');
}

function runIdFor(index: number): string {
	return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

describe('analytics run ledger', () => {
	it('locks the grouped ledger constants', () => {
		expect(ANALYTICS_RUN_LEDGER_SCHEMA_VERSION).toBe(1);
		expect(ANALYTICS_RUN_LEDGER_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
		expect(ANALYTICS_RUN_LEDGER_MAX_RUNS).toBe(1_000);
		expect(ANALYTICS_RUN_LEDGER_MAX_EVENTS_PER_RUN).toBe(6);
	});

	it('records a first mark and rejects the same tuple after reload', () => {
		const storage = makeStorage();
		expect(mark(createAnalyticsRunLedger({ storage }))).toBe('recorded');
		expect(mark(createAnalyticsRunLedger({ storage }), { recordedAt: 2_000 })).toBe('duplicate');
		expect(read(storage)).toEqual({
			schemaVersion: 1,
			runs: [
				{
					runId: runA,
					lastRecordedAt: 1_000,
					events: [
						{
							eventSchemaVersion: 1,
							eventName: 'puzzle_opened',
							recordedAt: 1_000
						}
					]
				}
			]
		});
	});

	it('uses event schema version, name, and run ID as the dedup tuple', () => {
		const storage = makeStorage();
		const ledger = createAnalyticsRunLedger({ storage });
		expect(mark(ledger)).toBe('recorded');
		expect(mark(ledger, { eventName: 'hint_used', recordedAt: 1_100 })).toBe('recorded');
		expect(mark(ledger, { runId: runB, recordedAt: 1_200 })).toBe('recorded');
		expect(mark(ledger, { eventName: 'hint_used', recordedAt: 1_300 })).toBe('duplicate');
	});

	it('stores all six V1 marks in one grouped run record', () => {
		const storage = makeStorage();
		const ledger = createAnalyticsRunLedger({ storage });
		const names = [
			'puzzle_opened',
			'first_piece_placed',
			'hint_used',
			'reference_used',
			'puzzle_completed',
			'personal_best_beaten'
		] as const;
		for (const [index, eventName] of names.entries()) {
			expect(mark(ledger, { eventName, recordedAt: 1_000 + index })).toBe('recorded');
		}
		const stored = read(storage) as {
			runs: Array<{ lastRecordedAt: number; events: unknown[] }>;
		};
		expect(stored.runs).toHaveLength(1);
		expect(stored.runs[0].events).toHaveLength(6);
		expect(stored.runs[0].lastRecordedAt).toBe(1_005);
	});

	it('prunes runs older than the 90-day window on the next successful mark', () => {
		const oldTime = 1_000;
		const now = oldTime + ANALYTICS_RUN_LEDGER_RETENTION_MS + 1;
		const storage = makeStorage({
			[ANALYTICS_RUN_LEDGER_KEY]: JSON.stringify({
				schemaVersion: 1,
				runs: [
					{
						runId: runA,
						lastRecordedAt: oldTime,
						events: [
							{
								eventSchemaVersion: 1,
								eventName: 'puzzle_opened',
								recordedAt: oldTime
							}
						]
					}
				]
			})
		});
		const ledger = createAnalyticsRunLedger({ storage });
		expect(mark(ledger, { runId: runB, recordedAt: now })).toBe('recorded');
		expect((read(storage) as { runs: Array<{ runId: string }> }).runs).toEqual([
			expect.objectContaining({ runId: runB })
		]);
	});

	it('keeps a run exactly on the retention boundary', () => {
		const oldTime = 1_000;
		const now = oldTime + ANALYTICS_RUN_LEDGER_RETENTION_MS;
		const storage = makeStorage();
		const ledger = createAnalyticsRunLedger({ storage });
		expect(mark(ledger, { recordedAt: oldTime })).toBe('recorded');
		expect(mark(ledger, { runId: runB, recordedAt: now })).toBe('recorded');
		expect((read(storage) as { runs: unknown[] }).runs).toHaveLength(2);
	});

	it('keeps the newest 1,000 runs', () => {
		const storage = makeStorage();
		const ledger = createAnalyticsRunLedger({ storage });
		for (let index = 0; index <= ANALYTICS_RUN_LEDGER_MAX_RUNS; index++) {
			expect(mark(ledger, { runId: runIdFor(index), recordedAt: index + 1 })).toBe('recorded');
		}
		const runs = (read(storage) as { runs: Array<{ runId: string }> }).runs;
		expect(runs).toHaveLength(ANALYTICS_RUN_LEDGER_MAX_RUNS);
		expect(runs[0].runId).toBe(runIdFor(ANALYTICS_RUN_LEDGER_MAX_RUNS));
		expect(runs.some((run) => run.runId === runIdFor(0))).toBe(false);
	});

	it('preserves a future-schema record and fails closed', () => {
		const future = JSON.stringify({ schemaVersion: 2, runs: [{ future: true }] });
		const storage = makeStorage({ [ANALYTICS_RUN_LEDGER_KEY]: future });
		const errors: string[] = [];
		const ledger = createAnalyticsRunLedger({ storage, onError: (code) => errors.push(code) });
		expect(mark(ledger)).toBe('incompatible_schema');
		expect(storage.getItem(ANALYTICS_RUN_LEDGER_KEY)).toBe(future);
		expect(errors).toEqual([]);
	});

	it.each([
		'not json',
		JSON.stringify({ schemaVersion: 1, runs: 'bad' }),
		JSON.stringify({ schemaVersion: 1, runs: [], extra: true }),
		JSON.stringify({
			schemaVersion: 1,
			runs: [
				{
					runId: runA,
					lastRecordedAt: 1_000,
					events: [
						{
							eventSchemaVersion: 1,
							eventName: 'puzzle_opened',
							recordedAt: 1_000,
							extra: true
						}
					]
				}
			]
		})
	])('resets malformed current-schema storage %s', (raw) => {
		const storage = makeStorage({ [ANALYTICS_RUN_LEDGER_KEY]: raw });
		const errors: string[] = [];
		const ledger = createAnalyticsRunLedger({ storage, onError: (code) => errors.push(code) });
		expect(mark(ledger)).toBe('recorded');
		expect(errors).toContain('invalid_record');
		expect((read(storage) as { runs: unknown[] }).runs).toHaveLength(1);
	});

	it('returns storage unavailable for read and write failures', () => {
		const readErrors: string[] = [];
		const readFailure = makeStorage();
		readFailure.getItem = () => {
			throw new Error('read failed');
		};
		expect(
			mark(
				createAnalyticsRunLedger({
					storage: readFailure,
					onError: (code) => readErrors.push(code)
				})
			)
		).toBe('storage_unavailable');
		expect(readErrors).toEqual(['read_error']);

		const writeErrors: string[] = [];
		const writeFailure = makeStorage();
		writeFailure.setItem = () => {
			throw new Error('write failed');
		};
		expect(
			mark(
				createAnalyticsRunLedger({
					storage: writeFailure,
					onError: (code) => writeErrors.push(code)
				})
			)
		).toBe('storage_unavailable');
		expect(writeErrors).toEqual(['write_error']);
	});

	it('reports remove failures while recovering a corrupt record', () => {
		const storage = makeStorage({ [ANALYTICS_RUN_LEDGER_KEY]: 'not json' });
		storage.removeItem = () => {
			throw new Error('remove failed');
		};
		const errors: string[] = [];
		expect(mark(createAnalyticsRunLedger({ storage, onError: (code) => errors.push(code) }))).toBe(
			'recorded'
		);
		expect(errors).toEqual(['invalid_record', 'remove_error']);
	});

	it.each([
		[
			'future event schema version',
			JSON.stringify({
				schemaVersion: 1,
				runs: [
					{
						runId: runA,
						lastRecordedAt: 1_000,
						events: [{ eventSchemaVersion: 2, eventName: 'puzzle_opened', recordedAt: 1_000 }]
					}
				]
			})
		],
		[
			'unknown event name',
			JSON.stringify({
				schemaVersion: 1,
				runs: [
					{
						runId: runA,
						lastRecordedAt: 1_000,
						events: [{ eventSchemaVersion: 1, eventName: 'made_up', recordedAt: 1_000 }]
					}
				]
			})
		],
		[
			'unsafe recorded timestamp',
			JSON.stringify({
				schemaVersion: 1,
				runs: [
					{
						runId: runA,
						lastRecordedAt: 1_000,
						events: [{ eventSchemaVersion: 1, eventName: 'puzzle_opened', recordedAt: -1 }]
					}
				]
			})
		]
	])(
		'resets storage with a run event that has valid keys but invalid values (%s)',
		(_label, raw) => {
			const storage = makeStorage({ [ANALYTICS_RUN_LEDGER_KEY]: raw });
			const errors: string[] = [];
			const ledger = createAnalyticsRunLedger({ storage, onError: (code) => errors.push(code) });
			expect(mark(ledger)).toBe('recorded');
			expect(errors).toContain('invalid_record');
		}
	);

	it.each([
		[
			'invalid run id',
			JSON.stringify({
				schemaVersion: 1,
				runs: [
					{
						runId: 'not-a-run-id',
						lastRecordedAt: 1_000,
						events: [{ eventSchemaVersion: 1, eventName: 'puzzle_opened', recordedAt: 1_000 }]
					}
				]
			})
		],
		[
			'non-array events',
			JSON.stringify({
				schemaVersion: 1,
				runs: [{ runId: runA, lastRecordedAt: 1_000, events: 'bad' }]
			})
		],
		[
			'empty events',
			JSON.stringify({
				schemaVersion: 1,
				runs: [{ runId: runA, lastRecordedAt: 1_000, events: [] }]
			})
		],
		[
			'unsafe last recorded timestamp',
			JSON.stringify({
				schemaVersion: 1,
				runs: [
					{
						runId: runA,
						lastRecordedAt: -1,
						events: [{ eventSchemaVersion: 1, eventName: 'puzzle_opened', recordedAt: 1_000 }]
					}
				]
			})
		]
	])(
		'resets storage with a run record that has valid keys but invalid values (%s)',
		(_label, raw) => {
			const storage = makeStorage({ [ANALYTICS_RUN_LEDGER_KEY]: raw });
			const errors: string[] = [];
			const ledger = createAnalyticsRunLedger({ storage, onError: (code) => errors.push(code) });
			expect(mark(ledger)).toBe('recorded');
			expect(errors).toContain('invalid_record');
		}
	);

	it.each([
		['non-record ledger value', '42'],
		['non-integer schema version', JSON.stringify({ schemaVersion: 1.5, runs: [] })],
		['non-record run element', JSON.stringify({ schemaVersion: 1, runs: [42] })],
		[
			'duplicate event keys',
			JSON.stringify({
				schemaVersion: 1,
				runs: [
					{
						runId: runA,
						lastRecordedAt: 1_000,
						events: [
							{ eventSchemaVersion: 1, eventName: 'puzzle_opened', recordedAt: 500 },
							{ eventSchemaVersion: 1, eventName: 'puzzle_opened', recordedAt: 1_000 }
						]
					}
				]
			})
		],
		[
			'lastRecordedAt mismatch',
			JSON.stringify({
				schemaVersion: 1,
				runs: [
					{
						runId: runA,
						lastRecordedAt: 2_000,
						events: [{ eventSchemaVersion: 1, eventName: 'puzzle_opened', recordedAt: 1_000 }]
					}
				]
			})
		]
	])('resets storage with a structurally invalid ledger (%s)', (_label, raw) => {
		const storage = makeStorage({ [ANALYTICS_RUN_LEDGER_KEY]: raw });
		const errors: string[] = [];
		const ledger = createAnalyticsRunLedger({ storage, onError: (code) => errors.push(code) });
		expect(mark(ledger)).toBe('recorded');
		expect(errors).toContain('invalid_record');
	});

	it('resets the ledger when a malformed run accompanies a valid duplicate', () => {
		// A valid run holds the puzzle_opened dedup tuple, and a second run is
		// malformed. The malformed run must force a full reset (the documented
		// policy for malformed current-schema storage) rather than being
		// silently dropped while the valid duplicate suppresses the mark and
		// leaves the corrupt ledger persisted indefinitely.
		const raw = JSON.stringify({
			schemaVersion: 1,
			runs: [
				{
					runId: runA,
					lastRecordedAt: 1_000,
					events: [{ eventSchemaVersion: 1, eventName: 'puzzle_opened', recordedAt: 1_000 }]
				},
				{
					runId: runB,
					lastRecordedAt: 'not-a-timestamp',
					events: 'not-an-array'
				}
			]
		});
		const storage = makeStorage({ [ANALYTICS_RUN_LEDGER_KEY]: raw });
		const errors: string[] = [];
		const ledger = createAnalyticsRunLedger({ storage, onError: (code) => errors.push(code) });

		// Without the fix this returns 'duplicate' and leaves the corrupt ledger
		// in storage. With the reset path the mark is recorded fresh.
		expect(mark(ledger)).toBe('recorded');
		expect(errors).toContain('invalid_record');

		const stored = read(storage) as { runs: Array<{ runId: string }> };
		expect(stored.runs.map((run) => run.runId)).toEqual([runA]);
	});

	it('returns invalid_input for an invalid mark input', () => {
		const storage = makeStorage();
		const ledger = createAnalyticsRunLedger({ storage });
		expect(
			ledger.markIfNew({
				eventSchemaVersion: 1,
				eventName: 'puzzle_opened',
				runId: 'not-a-run-id',
				recordedAt: 1_000
			})
		).toBe('invalid_input');
	});

	it('returns storage unavailable when the default localStorage getter throws', () => {
		// Sandboxed or storage-disabled contexts can throw SecurityError on the
		// localStorage property access itself, before getItem/setItem ever run.
		// Construction must not escape that throw, and markIfNew must report
		// storage_unavailable rather than wedging application composition.
		const own = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
		Object.defineProperty(globalThis, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('storage access denied');
			}
		});
		try {
			const ledger = createAnalyticsRunLedger();
			expect(
				ledger.markIfNew({
					eventSchemaVersion: 1,
					eventName: 'puzzle_opened',
					runId: runA,
					recordedAt: 1_000
				})
			).toBe('storage_unavailable');
		} finally {
			if (own) {
				Object.defineProperty(globalThis, 'localStorage', own);
			} else {
				delete (globalThis as { localStorage?: Storage }).localStorage;
			}
		}
	});
});
