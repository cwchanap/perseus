<script lang="ts">
	import {
		actionsForProgress,
		type DownloadedAction,
		type DownloadedPuzzleRow,
		type GameplayLaunch
	} from './downloadedLibrary';
	import type { CorruptDownload } from './downloadStore';

	export let rows: readonly DownloadedPuzzleRow[] = [];
	export let corruptRows: readonly CorruptDownload[] = [];
	export let onLaunch: (launch: GameplayLaunch) => void;
	export let onDiscardProgress: (puzzleId: string) => void;
	export let onRemoveDownload: (puzzleId: string) => void;
	export let onRemoveAndDownloadAgain: (puzzleId: string) => void;

	function actionLabel(action: DownloadedAction): string {
		switch (action) {
			case 'start':
				return 'START';
			case 'resume':
				return 'RESUME';
			case 'discard_progress':
				return 'DISCARD PROGRESS';
			case 'remove_download':
				return 'REMOVE DOWNLOAD';
		}
	}

	function runAction(row: DownloadedPuzzleRow, action: DownloadedAction): void {
		const puzzleId = row.install.manifest.puzzle.id;
		switch (action) {
			case 'start':
				onLaunch({ install: row.install, mode: 'start' });
				return;
			case 'resume':
				onLaunch({ install: row.install, mode: 'resume' });
				return;
			case 'discard_progress':
				onDiscardProgress(puzzleId);
				return;
			case 'remove_download':
				onRemoveDownload(puzzleId);
				return;
		}
	}
</script>

<stackLayout class="library-section">
	<label text="DOWNLOADED" class="library-section-title" />

	{#if rows.length === 0 && corruptRows.length === 0}
		<label text="No downloaded puzzles." class="library-empty" />
	{/if}

	{#each rows as row (row.install.manifest.puzzle.id)}
		<gridLayout columns="112,*,auto" class="library-card">
			<image
				col="0"
				src={row.install.thumbnailPath}
				width="104"
				height="104"
				stretch="aspectFill"
				class="library-thumbnail"
			/>
			<stackLayout col="1" class="library-card-copy">
				<label text={row.install.manifest.puzzle.name} class="library-card-title" textWrap="true" />
				<label
					text={`${row.install.manifest.puzzle.pieceCount} PIECES`}
					class="library-card-detail"
				/>
				{#if row.progress.kind === 'resumable'}
					<label text="SAVED PROGRESS" class="library-progress" />
				{:else if row.progress.kind === 'protected'}
					<label text="COMPLETED PROGRESS" class="library-card-detail" />
				{:else if row.progress.kind === 'invalid'}
					<label
						text={`INVALID PROGRESS: ${row.progress.reason}`}
						class="library-error"
						textWrap="true"
					/>
				{/if}
			</stackLayout>
			<stackLayout col="2" class="library-card-actions">
				{#each actionsForProgress(row.progress) as action}
					<button
						text={actionLabel(action)}
						class="library-button"
						on:tap={() => runAction(row, action)}
					/>
				{/each}
			</stackLayout>
		</gridLayout>
	{/each}

	{#each corruptRows as corrupt (corrupt.puzzleId)}
		<gridLayout columns="*,auto" class="library-card">
			<stackLayout col="0" class="library-card-copy">
				<label
					text={`CORRUPT DOWNLOAD: ${corrupt.puzzleId}`}
					class="library-card-title"
					textWrap="true"
				/>
				<label text={corrupt.reason} class="library-error" textWrap="true" />
			</stackLayout>
			<stackLayout col="1" class="library-card-actions">
				<button
					text="REMOVE & DOWNLOAD AGAIN"
					class="library-button"
					on:tap={() => onRemoveAndDownloadAgain(corrupt.puzzleId)}
				/>
				<button
					text="REMOVE DOWNLOAD"
					class="library-button"
					on:tap={() => onRemoveDownload(corrupt.puzzleId)}
				/>
			</stackLayout>
		</gridLayout>
	{/each}
</stackLayout>
