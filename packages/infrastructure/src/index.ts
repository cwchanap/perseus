import * as pulumi from '@pulumi/pulumi';
import { createR2Bucket, createKVNamespace, createD1Database } from './resources.js';
import { createWorkflowsWorker, createApiWorker } from './workers.js';
import { accountId, naming, paths } from './config.js';
import { createAdminAccessResources } from './admin-access.js';

const config = new pulumi.Config();
const r2Bucket = createR2Bucket();
const kvNamespace = createKVNamespace();
const d1Database = createD1Database();

const commonBindings = {
	kvNamespaces: [
		{
			binding: 'PUZZLE_METADATA',
			namespaceId: kvNamespace.id
		}
	],
	r2Buckets: [
		{
			binding: 'PUZZLES_BUCKET',
			bucketName: r2Bucket.name
		}
	],
	d1Databases: [
		{
			binding: 'DB',
			databaseId: d1Database.uuid
		}
	],
	envVars: {
		NODE_ENV: 'production'
	}
};

const apiBindings = {
	envVars: {
		...commonBindings.envVars,
		ALLOWED_ORIGINS: config.require('ALLOWED_ORIGINS'),
		AUTH_REDIRECT_BASE_URL: config.require('AUTH_REDIRECT_BASE_URL'),
		GOOGLE_CLIENT_ID: config.require('googleClientId')
	},
	secretVars: {
		JWT_SECRET: config.requireSecret('jwtSecret'),
		GOOGLE_CLIENT_SECRET: config.requireSecret('googleClientSecret')
	}
};

const workflowsWorker = createWorkflowsWorker({
	...commonBindings,
	durableObjects: [
		{
			binding: 'PUZZLE_METADATA_DO',
			className: 'PuzzleMetadataDO'
		}
	],
	workflows: [
		{
			binding: 'PUZZLE_WORKFLOW',
			workflowName: naming.workflow,
			className: 'PerseusWorkflow'
		}
	]
});

const apiWorker = createApiWorker(
	{
		...commonBindings,
		envVars: apiBindings.envVars,
		secretVars: apiBindings.secretVars
	},
	{
		directory: paths.webAssets
	},
	workflowsWorker
);

const adminAccess = createAdminAccessResources({
	accountId,
	// AUTH_REDIRECT_BASE_URL is used both as the OAuth redirect origin (apiBindings above)
	// and as the Access application hostname. Must be a bare origin (no path/port/query).
	hostname: config.require('AUTH_REDIRECT_BASE_URL'),
	adminEmail: config.requireSecret('adminAccessEmail'),
	deviceSerialsJson: config.requireSecret('adminDeviceSerials'),
	sessionDuration: config.get('adminAccessSessionDuration'),
	// The existing credential was created with the original one-year lifetime.
	// Cloudflare rejects shortening its expiration in place; rotate the service
	// token explicitly when changing this lifetime so new credentials are handled.
	cliServiceTokenDuration: '8760h'
});

export const r2BucketName = r2Bucket.name;
export const kvNamespaceId = kvNamespace.id;
export const d1DatabaseId = d1Database.uuid;
export const workflowsWorkerName = workflowsWorker.workerName;
export const apiWorkerName = apiWorker.workerName;
export const adminAccessApplicationId = adminAccess.application.id;
export const adminCliAccessApplicationId = adminAccess.cliApplication.id;
/** AUD for the narrow CLI Access app. Set as CF_ACCESS_AUD in the startup CLI
 * so cloudflaredTokenPath/cloudflaredLockPath resolve the correct cache files. */
export const adminCliAccessAud = adminAccess.cliApplication.aud;
export const adminAccessDevicePostureRuleId = adminAccess.devicePostureRule.id;
export const adminAccessDeviceSerialListId = adminAccess.deviceSerialList.id;
/** Client ID for CF-Access-Client-Id (safe to store in local shell env for CLI uploads). */
export const adminCliAccessClientId = adminAccess.cliServiceToken.clientId;
/** Client Secret for CF-Access-Client-Secret — treat as a secret. */
export const adminCliAccessClientSecret = pulumi.secret(adminAccess.cliServiceToken.clientSecret);
