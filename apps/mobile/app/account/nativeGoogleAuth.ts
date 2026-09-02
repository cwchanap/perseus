// Native Google Sign-In adapter. OAuth client IDs come from Info.plist
// (GIDClientID / GIDServerClientID); configuration happens exactly once via
// a module-level promise. signIn() resolves with a non-empty ID token.
import { GoogleSignin } from '@nativescript/google-signin';
import type { GoogleIdTokenProvider } from './mobileAccount';

function requireBundleValue(key: string): string {
	const value: unknown = NSBundle.mainBundle.objectForInfoDictionaryKey(key);
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`missing_ios_bundle_value_${key}`);
	}
	return value;
}

let configured: Promise<void> | null = null;

function ensureConfigured(): Promise<void> {
	configured ??= GoogleSignin.configure({
		clientId: requireBundleValue('GIDClientID'),
		serverClientId: requireBundleValue('GIDServerClientID')
	});
	return configured;
}

export const nativeGoogleIdTokenProvider: GoogleIdTokenProvider = {
	async signIn(): Promise<string> {
		await ensureConfigured();
		await GoogleSignin.signIn();
		const tokens = await GoogleSignin.getTokens();
		if (typeof tokens.idToken !== 'string' || tokens.idToken.length === 0) {
			throw new Error('google_sign_in_missing_id_token');
		}
		return tokens.idToken;
	},
	async signOut(): Promise<void> {
		await ensureConfigured();
		await GoogleSignin.signOut();
	}
};
