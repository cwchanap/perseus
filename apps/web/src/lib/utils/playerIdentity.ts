/**
 * Presentation identity for a player name: the trimmed display name with an
 * email fallback for absent or blank input, then 'Player' as a last resort,
 * plus the 1–2-grapheme initials derived from it. Shared by the arcade
 * shell (avatar + profile link label) and the profile page so the two
 * cannot drift — e.g. a whitespace-only name producing an empty avatar and
 * a dangling label.
 */

// Splitting on code points alone breaks on grapheme clusters: a flag emoji
// (two regional indicators), a decomposed accent, or a ZWJ sequence would
// each leak a partial mark into the avatar. A shared segmenter keeps each
// initial one whole grapheme.
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function playerIdentity(
	name: string | null | undefined,
	email?: string | null
): {
	displayName: string;
	initials: string;
} {
	const displayName = name?.trim() || email?.trim() || 'Player';
	const initials = displayName
		// Any whitespace separates name parts — a plain ' ' split misses the
		// ideographic space (U+3000) and would fuse two names into one.
		.split(/\s+/)
		.filter(Boolean)
		.map((part) => Array.from(segmenter.segment(part))[0]?.segment ?? '')
		.slice(0, 2)
		.join('')
		.toUpperCase();
	return { displayName, initials };
}
