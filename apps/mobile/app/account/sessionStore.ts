// Secure one-key session store: raw JSON in and out. All payload validation
// lives in mobileAccount.ts. Write/remove results are checked: a silent
// failure would leave a valid bearer in the Keychain while logout or
// persistence appears to have succeeded. Pure policy — the NativeScript
// SecureStorage instance is injected (see nativeSessionStore.ts).
import type { MobileSessionStore } from './mobileAccount';

export const SESSION_KEY = 'perseus_player_session_v1';

export function createSecureSessionStore(storage: {
	getSync(arg: { key: string }): unknown;
	setSync(arg: { key: string; value: string }): boolean;
	removeSync(arg: { key: string }): boolean;
}): MobileSessionStore {
	return {
		read(): string | null {
			const raw: unknown = storage.getSync({ key: SESSION_KEY });
			return typeof raw === 'string' && raw.length > 0 ? raw : null;
		},
		write(raw: string): void {
			if (!storage.setSync({ key: SESSION_KEY, value: raw })) {
				throw new Error('secure_storage_write_failed');
			}
		},
		clear(): void {
			// iOS reports a remove of an already-absent item as false; only
			// treat it as a failure when the item is still readable afterwards.
			if (!storage.removeSync({ key: SESSION_KEY }) && this.read() !== null) {
				throw new Error('secure_storage_remove_failed');
			}
		}
	};
}
