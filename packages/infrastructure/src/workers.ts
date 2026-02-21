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
	durableObjects?: Array<{
		binding: string;
		className: string;
		scriptName?: string;
	}>;
	workflows?: Array<{
		binding: string;
		workflowName: string;
		className: string;
		scriptName?: string;
	}>;
	envVars?: Record<string, string>;
}

export interface AssetsConfig {
	directory: string;
}

interface WorkerScriptConfig {
	logicalName: string;
	scriptName: string;
	workerPath: string;
	bindings: cloudflare.types.input.WorkersScriptBinding[];
	migrations?: { newTag: string; newClasses: string[] };
	assets?: { directory: string };
}

function readWorkerCode(workerPath: string): string {
	const infraDir = path.dirname(new URL(import.meta.url).pathname);
	const fullPath = path.resolve(infraDir, '../../../', workerPath);
	if (!fs.existsSync(fullPath)) {
		throw new Error(
			`Worker code not found at ${fullPath}. Run the build for the worker package before deploying.`
		);
	}
	return fs.readFileSync(fullPath, 'utf-8');
}

function buildBindings(bindings: WorkerBindings): cloudflare.types.input.WorkersScriptBinding[] {
	const result: cloudflare.types.input.WorkersScriptBinding[] = [];

	// KV namespace bindings
	for (const kv of bindings.kvNamespaces || []) {
		result.push({
			name: kv.binding,
			type: 'kv_namespace',
			namespaceId: kv.namespaceId
		});
	}

	// R2 bucket bindings
	for (const r2 of bindings.r2Buckets || []) {
		result.push({
			name: r2.binding,
			type: 'r2_bucket',
			bucketName: r2.bucketName
		});
	}

	// Durable Object bindings
	for (const dObj of bindings.durableObjects || []) {
		result.push({
			name: dObj.binding,
			type: 'durable_object_namespace',
			className: dObj.className,
			scriptName: dObj.scriptName
		});
	}

	// Workflow bindings
	for (const wf of bindings.workflows || []) {
		result.push({
			name: wf.binding,
			type: 'workflow',
			workflowName: wf.workflowName,
			className: wf.className,
			scriptName: wf.scriptName
		});
	}

	// Plain text environment variables
	if (bindings.envVars) {
		for (const [name, text] of Object.entries(bindings.envVars)) {
			result.push({
				name,
				type: 'plain_text',
				text
			});
		}
	}

	return result;
}

function createWorkerScript(config: WorkerScriptConfig): cloudflare.WorkersScript {
	return new cloudflare.WorkersScript(config.logicalName, {
		accountId: accountId,
		scriptName: config.scriptName,
		content: readWorkerCode(config.workerPath),
		compatibilityDate: compatibility.date,
		compatibilityFlags: compatibility.flags,
		bindings: config.bindings,
		...(config.migrations ? { migrations: config.migrations } : {}),
		...(config.assets ? { assets: config.assets } : {})
	});
}

export function createWorkflowsWorker(bindings: WorkerBindings = {}) {
	return createWorkerScript({
		logicalName: 'workflows-worker',
		scriptName: naming.workerWorkflows,
		workerPath: paths.workflowsWorker,
		bindings: buildBindings(bindings),
		migrations: { newTag: 'v1', newClasses: ['PuzzleMetadataDO'] }
	});
}

export function createApiWorker(
	bindings: WorkerBindings = {},
	assets?: AssetsConfig,
	workflowsScript?: cloudflare.WorkersScript
) {
	const scriptBindings = buildBindings(bindings);

	// Add cross-script bindings that reference the workflows worker
	if (workflowsScript) {
		// Durable Object binding to workflows script (only if not already present)
		if (!scriptBindings.some((b) => b.name === 'PUZZLE_METADATA_DO')) {
			scriptBindings.push({
				name: 'PUZZLE_METADATA_DO',
				type: 'durable_object_namespace',
				className: 'PuzzleMetadataDO',
				scriptName: workflowsScript.scriptName
			});
		}

		// Workflow binding to workflows script (only if not already present)
		if (!scriptBindings.some((b) => b.name === 'PUZZLE_WORKFLOW')) {
			scriptBindings.push({
				name: 'PUZZLE_WORKFLOW',
				type: 'workflow',
				workflowName: naming.workflow,
				className: 'PerseusWorkflow',
				scriptName: workflowsScript.scriptName
			});
		}
	}

	return createWorkerScript({
		logicalName: 'api-worker',
		scriptName: naming.workerApi,
		workerPath: paths.apiWorker,
		bindings: scriptBindings,
		...(assets ? { assets: { directory: assets.directory } } : {})
	});
}

export function createWorkerRoute(
	worker: cloudflare.WorkersScript,
	pattern: string,
	zoneId: string,
	logicalName: string = 'api-route'
) {
	return new cloudflare.WorkersRoute(logicalName, {
		zoneId: zoneId,
		pattern: pattern,
		script: worker.scriptName
	});
}
