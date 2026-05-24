import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PlayerAllowlistEntry, PlayerUser } from '@perseus/types';
import {
	OAUTH_STATE_TTL_SECONDS,
	PLAYER_SESSION_DURATION_MS,
	bytesToBase64Url,
	hashToken,
	normalizeEmail,
	type GoogleIdentityClaims
} from './player-auth.shared';

const SESSION_INDEX_FILE_PATTERN = /^[a-f0-9]{64}\.txt$/;

export interface CreatedPlayerSession {
	token: string;
	expiresAt: number;
}

export interface PlayerSessionRecord {
	sessionHash: string;
	user: PlayerUser;
	createdAt: number;
	expiresAt: number;
}

export interface StoredOAuthState {
	state: string;
	codeVerifier: string;
	returnTo: string;
	createdAt: number;
}

function authDir(): string {
	return join(process.env.DATA_DIR || './data', 'auth');
}

function pathPart(value: string): string {
	return encodeURIComponent(value);
}

function allowlistPath(email: string): string {
	return join(authDir(), 'allowlist', `${pathPart(normalizeEmail(email))}.json`);
}

function playerPath(id: string): string {
	return join(authDir(), 'players', `${pathPart(id)}.json`);
}

function emailIndexPath(email: string): string {
	return join(authDir(), 'email-index', `${pathPart(normalizeEmail(email))}.txt`);
}

function sessionPath(sessionHash: string): string {
	return join(authDir(), 'sessions', `${pathPart(sessionHash)}.json`);
}

function sessionIndexDir(email: string): string {
	return join(authDir(), 'session-index', pathPart(normalizeEmail(email)));
}

function sessionIndexSessionDir(email: string): string {
	return join(sessionIndexDir(email), 'session');
}

function sessionIndexPath(email: string, sessionHash: string): string {
	return join(sessionIndexSessionDir(email), `${pathPart(sessionHash)}.txt`);
}

function revokedAfterPath(email: string): string {
	return join(sessionIndexDir(email), 'revoked_after.txt');
}

function oauthStatePath(state: string): string {
	return join(authDir(), 'oauth-state', `${pathPart(state)}.json`);
}

function oauthStateClaimPath(state: string): string {
	const claimId = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
	return join(authDir(), 'oauth-state', `${pathPart(state)}.${claimId}.claimed.json`);
}

async function readJson<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, 'utf-8')) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, JSON.stringify(value, null, 2), 'utf-8');
}

async function writeText(path: string, value: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, value, 'utf-8');
}

async function readText(path: string): Promise<string | null> {
	try {
		return await readFile(path, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

function createSessionToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return bytesToBase64Url(bytes);
}

export async function initializePlayerAuthStorage(): Promise<void> {
	await Promise.all(
		['allowlist', 'players', 'email-index', 'sessions', 'session-index', 'oauth-state'].map((dir) =>
			mkdir(join(authDir(), dir), { recursive: true })
		)
	);
}

export async function addAllowlistEntry(
	email: string,
	addedBy: string
): Promise<PlayerAllowlistEntry> {
	const normalized = normalizeEmail(email);
	const existing = await getAllowlistEntry(normalized);
	if (existing) return existing;

	const entry: PlayerAllowlistEntry = {
		email: normalized,
		createdAt: Date.now(),
		addedBy
	};
	await writeJson(allowlistPath(normalized), entry);
	return entry;
}

export async function getAllowlistEntry(email: string): Promise<PlayerAllowlistEntry | null> {
	return await readJson<PlayerAllowlistEntry>(allowlistPath(email));
}

export async function listAllowlistEntries(): Promise<PlayerAllowlistEntry[]> {
	let fileNames: string[];
	try {
		fileNames = await readdir(join(authDir(), 'allowlist'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}

	const entries = await Promise.all(
		fileNames
			.filter((fileName) => fileName.endsWith('.json'))
			.map((fileName) => readJson<PlayerAllowlistEntry>(join(authDir(), 'allowlist', fileName)))
	);

	return entries
		.filter((entry): entry is PlayerAllowlistEntry => entry !== null)
		.sort((a, b) => a.email.localeCompare(b.email));
}

export async function deleteAllowlistEntry(email: string): Promise<void> {
	await rm(allowlistPath(email), { force: true });
}

export async function upsertPlayer(claims: GoogleIdentityClaims): Promise<PlayerUser> {
	const email = normalizeEmail(claims.email);
	const existing = await readJson<PlayerUser>(playerPath(claims.sub));
	const now = Date.now();
	const player: PlayerUser = {
		id: claims.sub,
		email,
		createdAt: existing?.createdAt ?? now,
		lastLoginAt: now
	};
	if (claims.name) player.name = claims.name;
	if (claims.picture) player.picture = claims.picture;

	await writeJson(playerPath(player.id), player);
	if (existing && existing.email !== email) {
		const indexedPlayerId = await readText(emailIndexPath(existing.email));
		if (indexedPlayerId === player.id) {
			await rm(emailIndexPath(existing.email), { force: true });
		}
	}
	await writeText(emailIndexPath(email), player.id);
	return player;
}

export async function getPlayer(id: string): Promise<PlayerUser | null> {
	return await readJson<PlayerUser>(playerPath(id));
}

export async function getPlayerByEmail(email: string): Promise<PlayerUser | null> {
	const normalized = normalizeEmail(email);
	const playerId = await readText(emailIndexPath(normalized));
	if (!playerId) return null;

	const player = await getPlayer(playerId);
	return player?.email === normalized ? player : null;
}

export async function createPlayerSession(user: PlayerUser): Promise<CreatedPlayerSession> {
	const email = normalizeEmail(user.email);
	if (!(await getAllowlistEntry(email))) {
		throw new Error('Player is not allowlisted');
	}

	const now = Date.now();
	const token = createSessionToken();
	const sessionHash = await hashToken(token);
	const expiresAt = now + PLAYER_SESSION_DURATION_MS;
	const record: PlayerSessionRecord = {
		sessionHash,
		user: { ...user, email },
		createdAt: now,
		expiresAt
	};

	await writeJson(sessionPath(sessionHash), record);
	await writeText(sessionIndexPath(email, sessionHash), '1');

	return { token, expiresAt };
}

export async function getPlayerSession(token: string): Promise<PlayerSessionRecord | null> {
	const sessionHash = await hashToken(token);
	const record = await readJson<PlayerSessionRecord>(sessionPath(sessionHash));
	if (!record || record.expiresAt <= Date.now()) return null;
	if (!(await getAllowlistEntry(record.user.email))) return null;

	const revokedAfter = Number(await readText(revokedAfterPath(record.user.email)));
	if (Number.isFinite(revokedAfter) && record.createdAt <= revokedAfter) return null;

	return record;
}

export async function revokePlayerSession(token: string): Promise<void> {
	const sessionHash = await hashToken(token);
	const record = await readJson<PlayerSessionRecord>(sessionPath(sessionHash));
	await rm(sessionPath(sessionHash), { force: true });

	if (!record) return;
	await rm(sessionIndexPath(record.user.email, sessionHash), { force: true });
}

export async function revokePlayerSessionsForEmail(email: string): Promise<void> {
	const normalized = normalizeEmail(email);
	const sessionDir = sessionIndexSessionDir(normalized);
	await writeText(revokedAfterPath(normalized), String(Date.now()));

	let fileNames: string[];
	try {
		fileNames = await readdir(sessionDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}

	await Promise.all(
		fileNames
			.filter((fileName) => SESSION_INDEX_FILE_PATTERN.test(fileName))
			.map(async (fileName) => {
				const sessionHash = fileName.slice(0, -'.txt'.length);
				await Promise.all([
					rm(sessionPath(sessionHash), { force: true }),
					rm(join(sessionDir, fileName), { force: true })
				]);
			})
	);
}

export async function storeOAuthState(
	state: string,
	value: Omit<StoredOAuthState, 'state' | 'createdAt'>
): Promise<void> {
	await writeJson(oauthStatePath(state), {
		state,
		codeVerifier: value.codeVerifier,
		returnTo: value.returnTo,
		createdAt: Date.now()
	} satisfies StoredOAuthState);
}

export async function consumeOAuthState(state: string): Promise<StoredOAuthState | null> {
	const path = oauthStatePath(state);
	const claimedPath = oauthStateClaimPath(state);

	try {
		await rename(path, claimedPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}

	let stored: StoredOAuthState | null;
	try {
		stored = await readJson<StoredOAuthState>(claimedPath);
	} finally {
		await rm(claimedPath, { force: true });
	}
	if (!stored) return null;
	if (stored.createdAt + OAUTH_STATE_TTL_SECONDS * 1000 <= Date.now()) return null;
	return stored;
}
