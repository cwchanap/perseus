import type { Miniflare } from 'miniflare';

/**
 * D1-over-dispatchFetch harness.
 *
 * `mf.getD1Database()` returns a proxy stub whose calls travel miniflare's
 * synchronous fetch channel (Atomics.wait + a message port). Under Bun that
 * channel can desync — a response arrives after the waiter already gave up —
 * and once it does, every later call reads a stale reply and asserts
 * `message?.id === id`, failing the whole test file.
 *
 * This helper instead exposes a `D1Database`-shaped object that posts each
 * operation to a tiny worker running inside workerd via `mf.dispatchFetch()`.
 * All traffic is ordinary async HTTP, and the SQL executes against the real
 * D1 binding inside workerd, so semantics (triggers, transactional batch,
 * result/meta shapes) match production.
 */

// The worker served to Miniflare. Must stay dependency-free: it runs inside
// workerd, not under Bun.
export const D1_HARNESS_WORKER_SOURCE = `export default {
	async fetch(request, env) {
		const { op, sql, params, stmts, colName } = await request.json();
		const detail = (error) =>
			(error instanceof Error ? error.message : String(error)) +
			(error instanceof Error && error.cause instanceof Error
				? ': ' + error.cause.message
				: '');
		try {
			if (op === 'exec') return Response.json({ result: await env.DB.exec(sql) });
			if (op === 'batch') {
				const prepared = stmts.map((s) => env.DB.prepare(s.sql).bind(...s.params));
				return Response.json({ result: await env.DB.batch(prepared) });
			}
			const stmt = env.DB.prepare(sql).bind(...(params ?? []));
			const result =
				op === 'run' ? await stmt.run()
				: op === 'all' ? await stmt.all()
				: op === 'first' ? await stmt.first(colName)
				: await stmt.raw();
			return Response.json({ result });
		} catch (error) {
			return Response.json({ error: detail(error) });
		}
	}
};
`;

type BoundStatement = { sql: string; params: unknown[] };

export function createMiniflareD1(mf: Miniflare): D1Database {
	const bound = new WeakMap<D1PreparedStatement, BoundStatement>();

	async function post(payload: Record<string, unknown>): Promise<unknown> {
		const res = await mf.dispatchFetch('http://localhost/', {
			method: 'POST',
			body: JSON.stringify(payload)
		});
		const body = (await res.json()) as { result?: unknown; error?: string };
		if (body.error !== undefined) throw new Error(body.error);
		return body.result;
	}

	function makeStatement(sqlText: string, params: unknown[]): D1PreparedStatement {
		const statement = {
			bind: (...values: unknown[]) => makeStatement(sqlText, values),
			run: <T = unknown>() => post({ op: 'run', sql: sqlText, params }) as Promise<D1Result<T>>,
			all: <T = unknown>() => post({ op: 'all', sql: sqlText, params }) as Promise<D1Result<T>>,
			first: <T = unknown>(colName?: string) =>
				post({ op: 'first', sql: sqlText, params, colName }) as Promise<T | null>,
			raw: <T = unknown>() => post({ op: 'raw', sql: sqlText, params }) as Promise<T[]>
		} as D1PreparedStatement;
		bound.set(statement, { sql: sqlText, params });
		return statement;
	}

	return {
		prepare: (query: string) => makeStatement(query, []),
		batch: (statements: D1PreparedStatement[]) =>
			post({
				op: 'batch',
				stmts: statements.map((stmt) => {
					const entry = bound.get(stmt);
					if (!entry) throw new Error('batch received a statement not created here');
					return entry;
				})
			}) as Promise<D1Result[]>,
		exec: (query: string) => post({ op: 'exec', sql: query }) as Promise<D1ExecResult>
	} as D1Database;
}
