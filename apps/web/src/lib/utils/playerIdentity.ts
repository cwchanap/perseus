/**
 * Presentation identity for a player name: the trimmed display name with a
 * 'Player' fallback for absent or blank input, plus the 1–2-letter
 * initials derived from it. Shared by the arcade shell (avatar + profile
 * link label) and the profile page so the two cannot drift — e.g. a
 * whitespace-only name producing an empty avatar and a dangling label.
 */
export function playerIdentity(name: string | null | undefined): {
	displayName: string;
	initials: string;
} {
	const displayName = name?.trim() || 'Player';
	const initials = displayName
		.split(' ')
		.filter(Boolean)
		// Array.from iterates code points: part[0] would split a supplementary-
		// plane character (e.g. 𠮷) into a lone surrogate that renders as �.
		.map((part) => Array.from(part)[0])
		.slice(0, 2)
		.join('')
		.toUpperCase();
	return { displayName, initials };
}
