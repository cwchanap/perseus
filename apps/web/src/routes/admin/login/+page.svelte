<script lang="ts">
	import { goto } from '$app/navigation';
	import { login, ApiError } from '$lib/services/api';
	import { resolve } from '$app/paths';

	let passkey = $state('');
	let error: string | null = $state(null);
	let loading = $state(false);

	async function handleSubmit(event: Event) {
		event.preventDefault();
		error = null;
		loading = true;

		try {
			const result = await login(passkey);
			if (result.success) {
				passkey = '';
				goto(resolve('/admin'));
			} else {
				error = result.error || 'Login failed';
			}
		} catch (e) {
			if (e instanceof ApiError) {
				error = e.message;
			} else {
				error = 'Failed to connect to server';
			}
		} finally {
			loading = false;
		}
	}
</script>

<svelte:head>
	<title>Admin Access | Perseus</title>
</svelte:head>

<main class="login-main">
	<div class="login-box">
		<div class="login-header">
			<div class="sys-tag">// PERSEUS SYSTEM</div>
			<h1 class="login-title">ADMIN ACCESS</h1>
			<p class="login-sub">Enter your passkey to authenticate</p>
		</div>

		<div class="login-line"></div>

		<form onsubmit={handleSubmit} class="login-form">
			{#if error}
				<div class="form-error">
					<span class="form-error-icon">!</span>
					{error}
				</div>
			{/if}

			<div class="field-wrap">
				<label for="passkey" class="field-label">PASSKEY</label>
				<input
					id="passkey"
					type="password"
					bind:value={passkey}
					required
					class="field-input"
					placeholder="••••••••"
					disabled={loading}
				/>
			</div>

			<button type="submit" disabled={loading || !passkey} class="submit-btn">
				{#if loading}
					<span class="btn-inner">
						<span class="btn-spinner"></span>
						AUTHENTICATING...
					</span>
				{:else}
					AUTHENTICATE
				{/if}
			</button>
		</form>

		<div class="login-footer">
			<a href={resolve('/')} class="back-link">← BACK TO ARCADE</a>
		</div>
	</div>
</main>

<style>
	.login-main {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		background-color: var(--bg-0);
		background-image:
			linear-gradient(rgba(0, 240, 255, 0.025) 1px, transparent 1px),
			linear-gradient(90deg, rgba(0, 240, 255, 0.025) 1px, transparent 1px);
		background-size: 48px 48px;
		padding: 1.5rem;
	}

	.login-box {
		width: 100%;
		max-width: 22rem;
		background: var(--bg-1);
		border: 1px solid var(--border);
		padding: 2rem 1.75rem;
	}

	.login-header {
		text-align: center;
		margin-bottom: 1.5rem;
	}

	.sys-tag {
		font-family: var(--font-mono);
		font-size: 0.6rem;
		color: var(--accent);
		letter-spacing: 0.2em;
		opacity: 0.6;
		margin-bottom: 0.5rem;
	}

	.login-title {
		font-family: var(--font-display);
		font-size: 1.5rem;
		font-weight: 900;
		letter-spacing: 0.15em;
		color: var(--text-0);
	}

	.login-sub {
		font-family: var(--font-mono);
		font-size: 0.65rem;
		color: var(--text-2);
		letter-spacing: 0.1em;
		margin-top: 0.4rem;
	}

	.login-line {
		height: 1px;
		background: linear-gradient(90deg, transparent, var(--border-bright), transparent);
		margin-bottom: 1.5rem;
	}

	.login-form {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.form-error {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		background: rgba(255, 0, 102, 0.08);
		border: 1px solid var(--hot-dim);
		padding: 0.625rem 0.875rem;
		font-family: var(--font-mono);
		font-size: 0.7rem;
		color: var(--hot);
		letter-spacing: 0.05em;
	}

	.form-error-icon {
		font-weight: 900;
		font-size: 0.85rem;
		flex-shrink: 0;
	}

	.field-wrap {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.field-label {
		font-family: var(--font-display);
		font-size: 0.58rem;
		font-weight: 600;
		letter-spacing: 0.2em;
		color: var(--text-2);
	}

	.field-input {
		width: 100%;
		background: var(--bg-0);
		border: 1px solid var(--border);
		color: var(--text-0);
		padding: 0.75rem 1rem;
		font-family: var(--font-mono);
		font-size: 0.9rem;
		letter-spacing: 0.1em;
		outline: none;
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease;
	}

	.field-input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 15px var(--accent-glow);
	}

	.field-input:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.field-input::placeholder {
		color: var(--text-2);
	}

	.submit-btn {
		font-family: var(--font-display);
		font-size: 0.65rem;
		font-weight: 700;
		letter-spacing: 0.25em;
		border: 1px solid var(--accent);
		color: var(--accent);
		background: transparent;
		padding: 0.75rem 1rem;
		cursor: pointer;
		transition: all 0.2s ease;
		width: 100%;
	}

	.submit-btn:hover:not(:disabled) {
		background: var(--accent-glow);
		box-shadow: 0 0 25px var(--accent-glow-strong);
		text-shadow: 0 0 10px var(--accent);
	}

	.submit-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.btn-inner {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
	}

	.btn-spinner {
		width: 0.875rem;
		height: 0.875rem;
		border: 2px solid var(--accent-dim);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin-cw 0.75s linear infinite;
	}

	.login-footer {
		margin-top: 1.5rem;
		text-align: center;
	}

	.back-link {
		font-family: var(--font-mono);
		font-size: 0.62rem;
		letter-spacing: 0.15em;
		color: var(--text-2);
		text-decoration: none;
		transition: color 0.15s ease;
	}

	.back-link:hover {
		color: var(--accent);
	}
</style>
