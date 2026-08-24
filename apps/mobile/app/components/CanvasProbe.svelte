<script lang="ts">
	import { File, knownFolders, path } from '@nativescript/core';
	import { ImageAsset } from '@nativescript/canvas';
	import { rotateClockwise } from '@perseus/game-core';

	let canvas: any;
	let piece: any;
	let x = 80;
	let y = 80;
	let dragStartX = 0;
	let dragStartY = 0;
	let originX = x;
	let originY = y;
	let status = 'waiting';
	let replaceStatus = 'replace: waiting';

	// HPA-1 Task 3: runtime (not type-only) import of the workspace package.
	// Evaluated at component init so bundling AND execution are both proven.
	const gameCoreProbe = rotateClockwise(0);
	let gameCoreStatus = `game-core: rotateClockwise(0)=${gameCoreProbe} pass=${gameCoreProbe === 90}`;
	console.log(`[game-core probe] ${gameCoreStatus}`);

	function runtimeStatus(): string {
		const hasClock = typeof globalThis.performance?.now === 'function';
		const cryptoSource = (globalThis as any).crypto;
		const hasCrypto =
			typeof cryptoSource?.randomUUID === 'function' ||
			typeof cryptoSource?.getRandomValues === 'function';
		return `clock=${hasClock} crypto=${hasCrypto}`;
	}

	function draw(): void {
		if (!canvas || !piece) return;
		const ctx = canvas.getContext('2d');
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(piece, x, y, 128, 128);
	}

	function onTap(event: any): void {
		status = `${runtimeStatus()} tap=${Math.round(event.getX())},${Math.round(event.getY())}`;
	}

	// Pan events on this runtime expose deltaX/deltaY (not getX/getY): the brief's
	// onPan body is adapted to the concrete installed NativeScript API.
	function onPan(event: any): void {
		if (event.state === 1) {
			dragStartX = event.deltaX;
			dragStartY = event.deltaY;
			originX = x;
			originY = y;
		}
		if (event.state === 2) {
			x = originX + event.deltaX - dragStartX;
			y = originY + event.deltaY - dragStartY;
			status = `${runtimeStatus()} drag=${Math.round(event.deltaX)},${Math.round(event.deltaY)}`;
			draw();
		}
	}

	function loadPiece(): void {
		const asset = new ImageAsset();
		const ok = asset.fromFileSync('~/assets/hpa-1/probe-piece.png');
		if (!ok) {
			status = `piece load failed: ${asset.error}`;
			return;
		}
		piece = asset;
		draw();
		status = `${runtimeStatus()} piece loaded`;
	}

	function probeRoot(): string {
		// Folder.fromPath returns undefined for missing paths; getFolder creates it.
		const folder = knownFolders.documents().getFolder('perseus-hpa1-probe');
		return folder.path;
	}

	// Clean same-volume replacement primitive on iOS: NSFileManager.replaceItemAt.
	// Absent/awkward bridge -> false, and the exact remove_then_rename fallback runs.
	function probeAtomic(): boolean {
		try {
			const root = probeRoot();
			const targetPath = path.join(root, 'session.json');
			const tempPath = `${targetPath}.tmp`;
			const target = File.fromPath(targetPath);
			const temp = File.fromPath(tempPath);
			target.writeTextSync('old');
			temp.writeTextSync('new');
			const fm = (globalThis as any).NSFileManager.defaultManager;
			const replaced = fm.replaceItemAtURLWithItemAtURLBackupItemNameOptionsResultingItemURLError(
				(globalThis as any).NSURL.fileURLWithPath(targetPath),
				(globalThis as any).NSURL.fileURLWithPath(tempPath),
				null,
				0,
				null,
				null
			);
			if (!replaced) return false;
			if (File.exists(tempPath)) return false;
			return File.fromPath(targetPath).readTextSync() === 'new';
		} catch (e) {
			return false;
		}
	}

	function probeRemoveThenRename(): boolean {
		const root = probeRoot();
		const targetPath = path.join(root, 'session.json');
		const tempPath = `${targetPath}.tmp`;
		const target = File.fromPath(targetPath);
		const temp = File.fromPath(tempPath);

		target.writeTextSync('old');
		temp.writeTextSync('new');
		target.removeSync();
		temp.renameSync('session.json');
		return File.fromPath(targetPath).readTextSync() === 'new';
	}

	function probeReplacement(): void {
		if (probeAtomic()) {
			replaceStatus = 'replace: atomic';
			return;
		}
		replaceStatus = probeRemoveThenRename() ? 'replace: remove_then_rename' : 'replace: FAIL';
	}

	function onLoaded(args: any): void {
		// bind:this yields the svelte-native element wrapper; the loaded event
		// carries the actual native Canvas view.
		canvas = args.object;
		loadPiece();
		probeReplacement();
	}
</script>

<page>
	<gridLayout rows="auto,auto,auto,auto,*">
		<label row="0" text="HPA-1 Canvas Probe" fontSize="24" margin="12" />
		<label row="1" text={status} textWrap="true" margin="4,12" />
		<label row="2" text={replaceStatus} textWrap="true" margin="4,12" />
		<label row="3" text={gameCoreStatus} textWrap="true" margin="4,12" />
		<canvas
			row="4"
			bind:this={canvas}
			on:tap={onTap}
			on:pan={onPan}
			width="700"
			height="700"
			backgroundColor="#222222"
			on:loaded={onLoaded}
		/>
	</gridLayout>
</page>
