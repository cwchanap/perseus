import * as cloudflare from '@pulumi/cloudflare';
import { naming, accountId } from './config.js';

export function createR2Bucket() {
	return new cloudflare.R2Bucket('puzzles-bucket', {
		accountId: accountId,
		name: naming.r2Bucket
	});
}

export function createKVNamespace() {
	return new cloudflare.WorkersKvNamespace('puzzle-metadata', {
		accountId: accountId,
		title: naming.kvNamespace
	});
}

export function createD1Database() {
	// D1 database UUID. The same UUID also appears in:
	//   - apps/api/wrangler.production.toml (database_id)
	//   - apps/workflows/wrangler.production.toml (database_id)
	// Keep both in sync. The database was adopted into Pulumi management
	// via a one-time `import:` on the first deploy; that line has been removed
	// now that the resource is in Pulumi state. Pulumi now fully owns the
	// resource — `pulumi destroy` will delete the database, and a subsequent
	// `pulumi up` will create a fresh one (with a new UUID). After a
	// destroy/recreate, update both wrangler.production.toml files with the
	// new UUID (the deploy workflow derives database_id from the Pulumi stack
	// output d1DatabaseId, so the sed replacement handles itself).
	return new cloudflare.D1Database(
		'player-data',
		{
			accountId: accountId,
			name: naming.d1Database
		},
		{
			// readReplication is a settable D1 input, but the Cloudflare API
			// returns a value whose shape doesn't match Pulumi's schema for
			// this field, causing a perpetual diff. Ignoring it prevents
			// unnecessary updates while still allowing all other D1 properties
			// to be managed normally.
			ignoreChanges: ['readReplication']
		}
	);
}
