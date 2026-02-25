import * as pulumi from '@pulumi/pulumi';
import { createR2Bucket, createKVNamespace } from './resources.js';
import { createWorkflowsWorker, createApiWorker } from './workers.js';
import { naming, paths } from './config.js';

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
		NODE_ENV: 'production',
		ALLOWED_ORIGINS: config.get('allowedOrigins') || ''
	},
	secretVars: {
		JWT_SECRET: config.requireSecret('jwtSecret'),
		ADMIN_PASSKEY: config.requireSecret('adminPasskey')
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
	commonBindings,
	{
		directory: paths.webAssets
	},
	workflowsWorker
);

export const r2BucketName = r2Bucket.name;
export const kvNamespaceId = kvNamespace.id;
export const workflowsWorkerName = workflowsWorker.workerName;
export const apiWorkerName = apiWorker.workerName;
