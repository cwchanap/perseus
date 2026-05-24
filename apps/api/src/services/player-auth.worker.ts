import type { PlayerAllowlistEntry, PlayerUser } from '@perseus/types';
import {
	PLAYER_SESSION_DURATION_MS,
	bytesToBase64Url,
	hashToken,
	normalizeEmail,
	type GoogleIdentityClaims
} from './player-auth.shared';

const ALLOWLIST_PREFIX = 'player_allowlist:';
const PLAYER_PREFIX = 'player:';
const PLAYER_EMAIL_INDEX_PREFIX = 'player_email_index:';
const PLAYER_SESSION_PREFIX = 'player_session:';
const PLAYER_SESSIONS_PREFIX = 'player_sessions:';

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

function allowlistKey(email: string): string {
	return `${ALLOWLIST_PREFIX}${normalizeEmail(email)}`;
}

function playerKey(id: string): string {
	return `${PLAYER_PREFIX}${id}`;
}

function emailIndexKey(email: string): string {
	return `${PLAYER_EMAIL_INDEX_PREFIX}${normalizeEmail(email)}`;
}

function sessionKey(hash: string): string {
	return `${PLAYER_SESSION_PREFIX}${hash}`;
}

function sessionsIndexKey(playerId: string): string {
	return `${PLAYER_SESSIONS_PREFIX}${playerId}`;
}

async function readJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
	return (await kv.get(key, 'json')) as T | null;
}

async function writeJson(
	kv: KVNamespace,
	key: string,
	value: unknown,
	ttlSeconds?: number
): Promise<void> {
	await kv.put(
		key,
		JSON.stringify(value),
		ttlSeconds === undefined ? undefined : { expirationTtl: ttlSeconds }
	);
}

function createSessionToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return bytesToBase64Url(bytes);
}

export async function addAllowlistEntry(
	kv: KVNamespace,
	email: string,
	addedBy: string
): Promise<PlayerAllowlistEntry> {
	const normalized = normalizeEmail(email);
	const existing = await getAllowlistEntry(kv, normalized);
	if (existing) return existing;

	const entry: PlayerAllowlistEntry = {
		email: normalized,
		createdAt: Date.now(),
		addedBy
	};
	await writeJson(kv, allowlistKey(normalized), entry);
	return entry;
}

export async function getAllowlistEntry(
	kv: KVNamespace,
	email: string
): Promise<PlayerAllowlistEntry | null> {
	return await readJson<PlayerAllowlistEntry>(kv, allowlistKey(email));
}

export async function listAllowlistEntries(kv: KVNamespace): Promise<PlayerAllowlistEntry[]> {
	const listed = await kv.list({ prefix: ALLOWLIST_PREFIX });
	const entries = await Promise.all(
		listed.keys.map((key) => readJson<PlayerAllowlistEntry>(kv, key.name))
	);
	return entries
		.filter((entry): entry is PlayerAllowlistEntry => entry !== null)
		.sort((a, b) => a.email.localeCompare(b.email));
}

export async function deleteAllowlistEntry(kv: KVNamespace, email: string): Promise<void> {
	await kv.delete(allowlistKey(email));
}

export async function upsertPlayer(
	kv: KVNamespace,
	claims: GoogleIdentityClaims
): Promise<PlayerUser> {
	const email = normalizeEmail(claims.email);
	const existing = await readJson<PlayerUser>(kv, playerKey(claims.sub));
	const now = Date.now();
	const player: PlayerUser = {
		id: claims.sub,
		email,
		createdAt: existing?.createdAt ?? now,
		lastLoginAt: now
	};
	if (claims.name) player.name = claims.name;
	if (claims.picture) player.picture = claims.picture;

	await writeJson(kv, playerKey(player.id), player);
	if (existing && existing.email !== email) {
		await kv.delete(emailIndexKey(existing.email));
	}
	await kv.put(emailIndexKey(email), player.id);
	return player;
}

export async function getPlayer(kv: KVNamespace, id: string): Promise<PlayerUser | null> {
	return await readJson<PlayerUser>(kv, playerKey(id));
}

export async function getPlayerByEmail(kv: KVNamespace, email: string): Promise<PlayerUser | null> {
	const playerId = await kv.get(emailIndexKey(email));
	return playerId ? await getPlayer(kv, playerId) : null;
}

async function readSessionHashes(kv: KVNamespace, playerId: string): Promise<string[]> {
	return (await readJson<string[]>(kv, sessionsIndexKey(playerId))) ?? [];
}

async function writeSessionHashes(
	kv: KVNamespace,
	playerId: string,
	hashes: string[]
): Promise<void> {
	await writeJson(kv, sessionsIndexKey(playerId), [...new Set(hashes)]);
}

export async function createPlayerSession(
	kv: KVNamespace,
	user: PlayerUser
): Promise<CreatedPlayerSession> {
	const email = normalizeEmail(user.email);
	const allowlistEntry = await getAllowlistEntry(kv, email);
	if (!allowlistEntry) {
		throw new Error('Player is not allowlisted');
	}

	const now = Date.now();
	const token = createSessionToken();
	const sessionHash = await hashToken(token);
	const expiresAt = now + PLAYER_SESSION_DURATION_MS;
	const sessionUser: PlayerUser = { ...user, email };
	const record: PlayerSessionRecord = {
		sessionHash,
		user: sessionUser,
		createdAt: now,
		expiresAt
	};

	await writeJson(
		kv,
		sessionKey(sessionHash),
		record,
		Math.ceil(PLAYER_SESSION_DURATION_MS / 1000)
	);
	await writeSessionHashes(kv, user.id, [...(await readSessionHashes(kv, user.id)), sessionHash]);

	return { token, expiresAt };
}

export async function getPlayerSession(
	kv: KVNamespace,
	token: string
): Promise<PlayerSessionRecord | null> {
	const sessionHash = await hashToken(token);
	const record = await readJson<PlayerSessionRecord>(kv, sessionKey(sessionHash));
	if (!record || record.expiresAt <= Date.now()) return null;
	if (!(await getAllowlistEntry(kv, record.user.email))) return null;
	return record;
}

export async function revokePlayerSession(kv: KVNamespace, token: string): Promise<void> {
	const sessionHash = await hashToken(token);
	const record = await readJson<PlayerSessionRecord>(kv, sessionKey(sessionHash));
	await kv.delete(sessionKey(sessionHash));

	if (!record) return;
	const hashes = await readSessionHashes(kv, record.user.id);
	const remaining = hashes.filter((hash) => hash !== sessionHash);
	if (remaining.length > 0) {
		await writeSessionHashes(kv, record.user.id, remaining);
		return;
	}
	await kv.delete(sessionsIndexKey(record.user.id));
}

export async function revokePlayerSessionsForEmail(kv: KVNamespace, email: string): Promise<void> {
	const player = await getPlayerByEmail(kv, email);
	if (!player) return;

	const hashes = await readSessionHashes(kv, player.id);
	await Promise.all(hashes.map((hash) => kv.delete(sessionKey(hash))));
	await kv.delete(sessionsIndexKey(player.id));
}
