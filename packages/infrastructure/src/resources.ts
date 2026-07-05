import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';
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
	const config = new pulumi.Config();
	// D1 database UUID to import into Pulumi management. This is a one-time
	// bootstrap value for adopting the existing D1 database. The same UUID
	// also appears in:
	//   - apps/api/wrangler.production.toml (database_id)
	//   - apps/workflows/wrangler.production.toml (database_id)
	// Keep all three in sync. If the Pulumi stack is destroyed and recreated,
	// update d1DatabaseImportId here and both wrangler.production.toml files.
	const importId = config.require('d1DatabaseImportId');
	return new cloudflare.D1Database(
		'player-data',
		{
			accountId: accountId,
			name: naming.d1Database
		},
		{
			import: `${accountId}/${importId}`,
			// readReplication is a settable D1 input, but on imported databases
			// the Cloudflare API returns a value that doesn't match Pulumi's
			// schema shape, causing a perpetual diff. Ignoring it prevents
			// unnecessary updates while still allowing all other D1 properties
			// to be managed normally.
			ignoreChanges: ['readReplication']
		}
	);
}
