import * as pulumi from '@pulumi/pulumi';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');

if (!fs.existsSync(path.join(repoRoot, 'package.json'))) {
	throw new Error(
		`Repository root not found at computed path: ${repoRoot}\n` +
			`Expected package.json to exist there. The compiled output directory depth may have changed.`
	);
}

const config = new pulumi.Config();

export const accountId = config.require('cloudflareAccountId');

export const naming = {
	workerApi: 'perseus',
	workerWorkflows: 'perseus-workflows',
	r2Bucket: 'perseus',
	kvNamespace: 'perseus',
	workflow: 'perseus'
};

export const compatibility = {
	date: '2024-12-30',
	flags: ['nodejs_compat']
};

export const paths = {
	apiWorker: path.join(repoRoot, 'apps/api/dist/worker.js'),
	workflowsWorker: path.join(repoRoot, 'apps/workflows/dist/index.js'),
	webAssets: path.join(repoRoot, 'apps/web/build')
};
