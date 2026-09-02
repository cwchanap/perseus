// Native secure-storage adapter: one key, raw JSON in and out. All payload
// validation lives in mobileAccount.ts. Keychain-backed defaults; the less
// secure fallback is never enabled.
import { SecureStorage } from '@nativescript/secure-storage';
import type { MobileSessionStore } from './mobileAccount';

const SESSION_KEY = 'perseus_player_session_v1';

const storage = new SecureStorage();

export const nativeMobileSessionStore: MobileSessionStore = {
	read(): string | null {
		const raw: unknown = storage.getSync({ key: SESSION_KEY });
		return typeof raw === 'string' && raw.length > 0 ? raw : null;
	},
	write(raw: string): void {
		storage.setSync({ key: SESSION_KEY, value: raw });
	},
	clear(): void {
		storage.removeSync({ key: SESSION_KEY });
	}
};
