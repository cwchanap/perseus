<script lang="ts">
	import type { PlayerProfile } from '$lib/types/puzzle';
	import { ICONS } from '$lib/constants/icons';
	import { playerIdentity } from '$lib/utils/playerIdentity';
	import { formatRelativeTime } from '$lib/utils/relativeTime';

	interface Props {
		profile: PlayerProfile;
		score: number;
		rank: number | null;
		editing: boolean;
		displayName: string;
		saving: boolean;
		saveError: string | null;
		onEdit: () => void;
		onCancel: () => void;
		onSave: () => void;
		onReset: () => void;
		onAvatarChosen: (event: Event) => void;
	}

	let {
		profile,
		score,
		rank,
		editing,
		displayName = $bindable(),
		saving,
		saveError,
		onEdit,
		onCancel,
		onSave,
		onReset,
		onAvatarChosen
	}: Props = $props();

	const initials = $derived(playerIdentity(profile.name, profile.email).initials);
	const joined = $derived(
		new Date(profile.createdAt).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		})
	);

	function handleSubmit(event: SubmitEvent) {
		event.preventDefault();
		onSave();
	}
</script>

<section
	class="arcade-panel-hero flex flex-col items-center gap-4 px-[18px] pt-[26px] pb-5 text-center
	md:flex-row md:gap-[26px] md:px-[30px] md:py-7 md:text-left"
	aria-label="Player card"
>
	<div class="avatar">
		{#if profile.picture}
			<img
				src={profile.picture}
				alt={profile.name}
				class="h-full w-full rounded-[inherit] object-cover"
			/>
		{:else if !editing}
			<span aria-hidden="true">{initials}</span>
		{/if}
		{#if editing}
			<label class="avatar-change">
				<svg viewBox="0 0 24 24" fill="currentColor" class="h-[26px] w-[26px]" aria-hidden="true">
					<path d={ICONS.camera} />
				</svg>
				CHANGE
				<input
					data-testid="avatar-input"
					aria-label="Upload avatar image"
					type="file"
					accept="image/*"
					onchange={onAvatarChosen}
					class="sr-only"
				/>
			</label>
		{/if}
	</div>

	<div class="w-full min-w-0 flex-1">
		{#if editing}
			<form onsubmit={handleSubmit}>
				<p class="arcade-kicker mb-1.5">Edit profile</p>
				<label class="arcade-label mb-1.5" for="display-name">Display name</label>
				<input
					id="display-name"
					data-testid="display-name-input"
					aria-label="Display name"
					bind:value={displayName}
					class="arcade-input md:max-w-[360px]"
				/>
				<div class="mt-3.5 flex flex-wrap items-center justify-center gap-2.5 md:justify-start">
					<button type="submit" class="arcade-btn" disabled={saving}>Save</button>
					<button type="button" class="arcade-btn-ghost" onclick={onCancel} disabled={saving}>
						Cancel
					</button>
					<button
						type="button"
						data-testid="reset-name"
						class="px-1 py-1.5 text-[0.95rem] font-semibold text-(--text-2) underline
						underline-offset-[3px] hover:text-(--accent)"
						onclick={onReset}
						disabled={saving}
					>
						Reset to Google name
					</button>
				</div>
			</form>
		{:else}
			<p class="arcade-kicker mb-1.5">Player profile</p>
			<h1
				class="truncate font-(family-name:--font-display) text-[1.5rem] leading-[1.15] font-black tracking-[0.03em]
				uppercase [text-shadow:0_2px_14px_rgba(0,0,0,0.6)] md:text-[2rem]"
				data-testid="profile-name"
			>
				{profile.name}
			</h1>
			<p class="mt-1 truncate text-[1.05rem] font-medium text-(--text-1)">{profile.email}</p>
			<div class="mt-3.5 flex flex-wrap justify-center gap-2 md:justify-start">
				<span class="meta-chip" data-testid="profile-join-date">
					<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"
						><path d={ICONS.calendar} /></svg
					>
					Joined {joined}
				</span>
				<span
					class="meta-chip"
					data-testid="profile-last-login"
					title={new Date(profile.lastLoginAt).toLocaleString()}
				>
					<span class="online-dot" aria-hidden="true"></span>
					Last seen {formatRelativeTime(profile.lastLoginAt)}
				</span>
			</div>
		{/if}
		{#if saveError}
			<p
				data-testid="profile-save-error"
				role="alert"
				class="arcade-alert arcade-alert-error mt-3 inline-flex text-left"
			>
				{saveError}
			</p>
		{/if}
	</div>

	<div class="flex w-full flex-col items-stretch gap-3.5 md:w-auto md:items-end">
		<div class="flex gap-3">
			<div class="big-stat big-stat-gold">
				<div class="big-stat-value" data-testid="profile-progression-score">
					{score.toLocaleString()}
				</div>
				<div class="big-stat-label">SCORE</div>
			</div>
			<div class="big-stat big-stat-cyan">
				<div class="big-stat-value">
					{#if rank !== null}<span aria-hidden="true">#</span>{/if}<span
						data-testid="profile-progression-rank">{rank ?? '—'}</span
					>
				</div>
				<div class="big-stat-label">RANK</div>
			</div>
		</div>
		{#if !editing}
			<button type="button" class="arcade-btn-ghost" onclick={onEdit}>
				<svg
					viewBox="0 0 24 24"
					fill="currentColor"
					class="mr-2 h-[15px] w-[15px]"
					aria-hidden="true"
				>
					<path d={ICONS.pencil} />
				</svg>
				Edit profile
			</button>
		{/if}
	</div>
</section>

<style>
	.avatar {
		position: relative;
		display: grid;
		flex: none;
		width: 92px;
		height: 92px;
		place-items: center;
		border-radius: 26px;
		background: linear-gradient(160deg, #ff5cc0, #e0148c);
		box-shadow:
			0 5px 0 #8c0a55,
			0 12px 30px rgba(255, 46, 166, 0.38);
		color: #fff;
		font-family: var(--font-display);
		font-size: 1.8rem;
		font-weight: 900;
		letter-spacing: 0.04em;
	}

	.avatar-change {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		border: 2px dashed var(--accent);
		border-radius: inherit;
		background: rgba(10, 6, 32, 0.78);
		color: var(--accent);
		font-family: var(--font-display);
		font-size: 0.58rem;
		font-weight: 700;
		letter-spacing: 0.14em;
		cursor: pointer;
	}

	.avatar-change:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}

	.meta-chip {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 11px;
		border: 1px solid var(--border-bright);
		border-radius: 999px;
		background: rgba(10, 6, 32, 0.55);
		color: var(--text-1);
		font-family: var(--font-mono);
		font-size: 0.72rem;
		letter-spacing: 0.06em;
	}

	.meta-chip svg {
		width: 13px;
		height: 13px;
		color: var(--text-2);
	}

	.online-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--green);
		box-shadow: 0 0 8px var(--green);
	}

	.big-stat {
		flex: 1;
		min-width: 0;
		padding: 12px 18px 11px;
		border-radius: 18px;
		text-align: center;
	}

	.big-stat-value {
		font-family: var(--font-display);
		font-size: 1.9rem;
		font-weight: 900;
		line-height: 1.1;
	}

	.big-stat-label {
		margin-top: 4px;
		color: var(--text-1);
		font-family: var(--font-mono);
		font-size: 0.66rem;
		letter-spacing: 0.24em;
	}

	.big-stat-gold {
		border: 1px solid rgba(255, 204, 0, 0.42);
		background: rgba(255, 204, 0, 0.1);
		color: var(--gold);
		box-shadow: 0 0 24px var(--gold-glow) inset;
	}

	.big-stat-cyan {
		border: 1px solid rgba(58, 255, 255, 0.4);
		background: rgba(0, 240, 255, 0.08);
		color: var(--accent);
		box-shadow: 0 0 24px var(--accent-glow) inset;
	}

	@media (min-width: 768px) {
		.avatar {
			width: 108px;
			height: 108px;
			border-radius: 30px;
			font-size: 2.1rem;
		}

		.big-stat {
			min-width: 128px;
		}
	}
</style>
