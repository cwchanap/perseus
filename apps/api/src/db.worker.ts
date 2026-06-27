import { createD1Db } from '@perseus/shared/d1';
import type { Env } from './worker';
import type { AppDb } from '@perseus/shared';

export function getWorkerDb(env: Env): AppDb {
	return createD1Db(env);
}
