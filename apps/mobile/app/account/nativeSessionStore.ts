// Keychain-backed session storage; the less secure fallback is never
// enabled. Store behavior lives in sessionStore.ts (pure, unit-tested).
import { SecureStorage } from '@nativescript/secure-storage';
import { createSecureSessionStore } from './sessionStore';

export const nativeMobileSessionStore = createSecureSessionStore(new SecureStorage());
