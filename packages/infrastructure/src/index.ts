import * as pulumi from '@pulumi/pulumi';
import { createR2Bucket, createKVNamespace } from './resources.js';
import { createWorkflowsWorker, createApiWorker } from './workers.js';
import { naming } from './config.js';

const r2Bucket = createR2Bucket();
const kvNamespace = createKVNamespace();

const workflowsWorker = createWorkflowsWorker({
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
});

const apiWorker = createApiWorker({
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
});

export const r2BucketName = r2Bucket.name;
export const kvNamespaceId = kvNamespace.id;
export const workflowsWorkerName = workflowsWorker.name;
export const apiWorkerName = apiWorker.name;
