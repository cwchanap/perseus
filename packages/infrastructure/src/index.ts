import * as pulumi from '@pulumi/pulumi';
import { createR2Bucket, createKVNamespace } from './resources.js';
import { createWorkflowsWorker, createApiWorker } from './workers.js';
import { accountId, naming, paths } from './config.js';
import {
	DEFAULT_ADMIN_ACCESS_SESSION_DURATION,
	createAdminAccessResources
} from './admin-access.js';

const config = new pulumi.Config();
const r2Bucket = createR2Bucket();
const kvNamespace = createKVNamespace();

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
	envVars: {
		NODE_ENV: 'production'
	}
};

const apiBindings = {
	envVars: {
		...commonBindings.envVars,
		ALLOWED_ORIGINS: config.require('ALLOWED_ORIGINS'),
		AUTH_REDIRECT_BASE_URL: config.require('AUTH_REDIRECT_BASE_URL')
	},
	secretVars: {
		JWT_SECRET: config.requireSecret('jwtSecret'),
		ADMIN_PASSKEY: config.requireSecret('adminPasskey'),
		GOOGLE_CLIENT_ID: config.requireSecret('googleClientId'),
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
	hostname: config.require('AUTH_REDIRECT_BASE_URL'),
	adminEmail: config.requireSecret('adminAccessEmail'),
	deviceSerialsJson: config.requireSecret('adminDeviceSerials'),
	sessionDuration: config.get('adminAccessSessionDuration') ?? DEFAULT_ADMIN_ACCESS_SESSION_DURATION
});

export const r2BucketName = r2Bucket.name;
export const kvNamespaceId = kvNamespace.id;
export const workflowsWorkerName = workflowsWorker.workerName;
export const apiWorkerName = apiWorker.workerName;
export const adminAccessApplicationId = adminAccess.application.id;
export const adminAccessDevicePostureRuleId = adminAccess.devicePostureRule.id;
export const adminAccessDeviceSerialListId = adminAccess.deviceSerialList.id;
