import * as pulumi from '@pulumi/pulumi';
import { createR2Bucket, createKVNamespace } from './resources.js';
import { createWorkflowsWorker, createApiWorker } from './workers.js';
import { naming, paths } from './config.js';

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
		// Assets configuration for serving static web app files
		directory: paths.webAssets
	},
	workflowsWorker // Pass workflows worker for cross-script bindings
);

export const r2BucketName = r2Bucket.name;
export const kvNamespaceId = kvNamespace.id;
export const workflowsWorkerName = workflowsWorker.scriptName;
export const apiWorkerName = apiWorker.scriptName;
