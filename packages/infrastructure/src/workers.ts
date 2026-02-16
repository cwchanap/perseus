import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';
import * as fs from 'fs';
import * as path from 'path';
import { naming, accountId, compatibility, paths } from './config.js';

export interface WorkerBindings {
	kvNamespaces?: Array<{
		binding: string;
		namespaceId: pulumi.Input<string>;
	}>;
	r2Buckets?: Array<{
		binding: string;
		bucketName: pulumi.Input<string>;
	}>;
	envVars?: Record<string, string>;
}

function readWorkerCode(workerPath: string): string {
	const infraDir = path.dirname(new URL(import.meta.url).pathname);
	const fullPath = path.resolve(infraDir, '../../../', workerPath);
	if (!fs.existsSync(fullPath)) {
		console.warn(`Worker code not found at ${fullPath}, using placeholder`);
		return `export default { async fetch(request) { return new Response('Worker not built yet'); } };`;
	}
	return fs.readFileSync(fullPath, 'utf-8');
}

function createPlainTextBindings(
	envVars: Record<string, string> | undefined
): cloudflare.types.input.WorkersScriptPlainTextBinding[] | undefined {
	if (!envVars || Object.keys(envVars).length === 0) {
		return undefined;
	}
	return Object.entries(envVars).map(([name, text]) => ({
		name,
		text
	}));
}

export function createWorkflowsWorker(bindings: WorkerBindings = {}) {
	const kvNamespaceBindings =
		bindings.kvNamespaces?.map((kv) => ({
			name: kv.binding,
			namespaceId: kv.namespaceId
		})) || [];

	const r2BucketBindings =
		bindings.r2Buckets?.map((r2) => ({
			name: r2.binding,
			bucketName: r2.bucketName
		})) || [];

	return new cloudflare.WorkersScript('workflows-worker', {
		accountId: accountId,
		name: naming.workerWorkflows,
		content: readWorkerCode(paths.workflowsWorker),
		module: true,
		compatibilityDate: compatibility.date,
		compatibilityFlags: compatibility.flags,
		kvNamespaceBindings: kvNamespaceBindings.length > 0 ? kvNamespaceBindings : undefined,
		r2BucketBindings: r2BucketBindings.length > 0 ? r2BucketBindings : undefined,
		plainTextBindings: createPlainTextBindings(bindings.envVars)
	});
}

export function createApiWorker(bindings: WorkerBindings = {}) {
	const kvNamespaceBindings =
		bindings.kvNamespaces?.map((kv) => ({
			name: kv.binding,
			namespaceId: kv.namespaceId
		})) || [];

	const r2BucketBindings =
		bindings.r2Buckets?.map((r2) => ({
			name: r2.binding,
			bucketName: r2.bucketName
		})) || [];

	return new cloudflare.WorkersScript('api-worker', {
		accountId: accountId,
		name: naming.workerApi,
		content: readWorkerCode(paths.apiWorker),
		module: true,
		compatibilityDate: compatibility.date,
		compatibilityFlags: compatibility.flags,
		kvNamespaceBindings: kvNamespaceBindings.length > 0 ? kvNamespaceBindings : undefined,
		r2BucketBindings: r2BucketBindings.length > 0 ? r2BucketBindings : undefined,
		plainTextBindings: createPlainTextBindings(bindings.envVars)
	});
}

export function createWorkerRoute(
	worker: cloudflare.WorkersScript,
	pattern: string,
	zoneId: string
) {
	return new cloudflare.WorkersRoute('api-route', {
		zoneId: zoneId,
		pattern: pattern,
		scriptName: worker.name
	});
}
