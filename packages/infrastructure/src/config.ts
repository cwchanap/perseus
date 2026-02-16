import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();

export const accountId = config.require('cloudflareAccountId');

export const naming = {
	workerApi: 'perseus',
	workerWorkflows: 'workflows',
	r2Bucket: 'perseus-production',
	kvNamespace: 'perseus-kv-production',
	workflow: 'perseus'
};

export const compatibility = {
	date: '2024-12-30',
	flags: ['nodejs_compat']
};

export const paths = {
	apiWorker: 'apps/api/src/worker.ts',
	workflowsWorker: 'apps/workflows/src/index.ts',
	webAssets: 'apps/web/build'
};
