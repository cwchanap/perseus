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
	envVars?: Record<string, pulumi.Input<string>>;
	secretVars?: Record<string, pulumi.Input<string>>;
}

export interface AssetsConfig {
	directory: string;
	binding?: string;
}

function getModules(
	distDir: string,
	mainModule: string
): cloudflare.types.input.WorkerVersionModule[] {
	if (!fs.existsSync(distDir)) {
		throw new Error(
			`Build output not found at: ${distDir}\n` +
				`Run the build step first: bun run build --filter=@perseus/${path.basename(path.dirname(distDir))}`
		);
	}

	const modules: cloudflare.types.input.WorkerVersionModule[] = [];

	function walkDir(currentDir: string) {
		const entries = fs.readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				walkDir(fullPath);
			} else if (entry.isFile()) {
				let contentType: string;
				if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
					contentType = 'application/javascript+module';
				} else if (entry.name.endsWith('.wasm')) {
					contentType = 'application/wasm';
				} else {
					continue;
				}

				const relativePath = path.relative(distDir, fullPath);
				modules.push({
					name: relativePath,
					contentFile: fullPath,
					contentType
				});
			}
		}
	}

	walkDir(distDir);

	if (!modules.some((m) => m.name === mainModule)) {
		throw new Error(`Main module "${mainModule}" not found in ${distDir}`);
	}

	return modules;
}

function buildVersionBindings(
	bindings: WorkerBindings
): cloudflare.types.input.WorkerVersionBinding[] {
	const result: cloudflare.types.input.WorkerVersionBinding[] = [];

	for (const kv of bindings.kvNamespaces || []) {
		result.push({
			name: kv.binding,
			type: 'kv_namespace',
			namespaceId: kv.namespaceId
		});
	}

	for (const r2 of bindings.r2Buckets || []) {
		result.push({
			name: r2.binding,
			type: 'r2_bucket',
			bucketName: r2.bucketName
		});
	}

	for (const dObj of bindings.durableObjects || []) {
		result.push({
			name: dObj.binding,
			type: 'durable_object_namespace',
			className: dObj.className,
			scriptName: dObj.scriptName
		});
	}

	for (const wf of bindings.workflows || []) {
		result.push({
			name: wf.binding,
			type: 'workflow',
			workflowName: wf.workflowName,
			className: wf.className,
			scriptName: wf.scriptName
		});
	}

	if (bindings.envVars) {
		for (const [name, text] of Object.entries(bindings.envVars)) {
			result.push({
				name,
				type: 'plain_text',
				text
			});
		}
	}

	if (bindings.secretVars) {
		for (const [name, text] of Object.entries(bindings.secretVars)) {
			result.push({
				name,
				type: 'secret_text',
				text
			});
		}
	}

	return result;
}

export function createWorkflowsWorker(bindings: WorkerBindings = {}): {
	worker: cloudflare.Worker;
	version: cloudflare.WorkerVersion;
	workerName: string;
} {
	const distDir = path.dirname(paths.workflowsWorker);
	const mainModule = path.basename(paths.workflowsWorker);

	const versionBindings = buildVersionBindings(bindings);
	const doBinding = versionBindings.find(
		(b) => b.name === 'PUZZLE_METADATA_DO' && b.type === 'durable_object_namespace'
	);
	const bindingsWithoutDo = versionBindings.filter(
		(b) => !(b.name === 'PUZZLE_METADATA_DO' && b.type === 'durable_object_namespace')
	);

	const worker = new cloudflare.Worker('workflows-worker', {
		accountId: accountId,
		name: naming.workerWorkflows,
		observability: {
			enabled: true,
			headSamplingRate: 1,
			logs: {
				enabled: true,
				headSamplingRate: 1,
				invocationLogs: true
			}
		}
	});

	const initialVersion = new cloudflare.WorkerVersion(
		'workflows-worker-version',
		{
			accountId: accountId,
			workerId: worker.name,
			mainModule: mainModule,
			modules: getModules(distDir, mainModule),
			bindings: bindingsWithoutDo,
			compatibilityDate: compatibility.date,
			compatibilityFlags: compatibility.flags
		},
		{ dependsOn: worker }
	);

	const workflow = new cloudflare.Workflow(
		'perseus-workflow',
		{
			accountId: accountId,
			workflowName: naming.workflow,
			className: 'PerseusWorkflow',
			scriptName: naming.workerWorkflows
		},
		{ dependsOn: initialVersion }
	);

	if (doBinding) {
		const versionWithDo = new cloudflare.WorkerVersion(
			'workflows-worker-version-do',
			{
				accountId: accountId,
				workerId: worker.name,
				mainModule: mainModule,
				modules: getModules(distDir, mainModule),
				bindings: versionBindings,
				compatibilityDate: compatibility.date,
				compatibilityFlags: compatibility.flags
			},
			{ dependsOn: workflow }
		);

		void new cloudflare.WorkersDeployment(
			'workflows-worker-deployment',
			{
				accountId: accountId,
				scriptName: naming.workerWorkflows,
				strategy: 'percentage',
				versions: [{ percentage: 100, versionId: versionWithDo.id }]
			},
			{ dependsOn: versionWithDo }
		);

		return { worker, version: versionWithDo, workerName: naming.workerWorkflows };
	}

	void new cloudflare.WorkersDeployment(
		'workflows-worker-deployment',
		{
			accountId: accountId,
			scriptName: naming.workerWorkflows,
			strategy: 'percentage',
			versions: [{ percentage: 100, versionId: initialVersion.id }]
		},
		{ dependsOn: workflow }
	);

	return { worker, version: initialVersion, workerName: naming.workerWorkflows };
}

export function createApiWorker(
	bindings: WorkerBindings,
	assets: AssetsConfig | undefined,
	workflowsWorker: { workerName: string; version: cloudflare.WorkerVersion }
): { worker: cloudflare.Worker; version: cloudflare.WorkerVersion; workerName: string } {
	const distDir = path.dirname(paths.apiWorker);
	const mainModule = path.basename(paths.apiWorker);
	const scriptBindings = buildVersionBindings(bindings);

	if (workflowsWorker) {
		if (!scriptBindings.some((b) => b.name === 'PUZZLE_METADATA_DO')) {
			scriptBindings.push({
				name: 'PUZZLE_METADATA_DO',
				type: 'durable_object_namespace',
				className: 'PuzzleMetadataDO',
				scriptName: workflowsWorker.workerName
			});
		}

		if (!scriptBindings.some((b) => b.name === 'PUZZLE_WORKFLOW')) {
			scriptBindings.push({
				name: 'PUZZLE_WORKFLOW',
				type: 'workflow',
				workflowName: naming.workflow,
				className: 'PerseusWorkflow',
				scriptName: workflowsWorker.workerName
			});
		}
	}

	if (assets && !scriptBindings.some((b) => b.name === 'ASSETS')) {
		scriptBindings.push({ name: 'ASSETS', type: 'assets' });
	}

	const worker = new cloudflare.Worker('api-worker', {
		accountId: accountId,
		name: naming.workerApi,
		observability: {
			enabled: true,
			headSamplingRate: 1,
			logs: {
				enabled: true,
				headSamplingRate: 1,
				invocationLogs: true
			}
		}
	});

	const version = new cloudflare.WorkerVersion(
		'api-worker-version',
		{
			accountId: accountId,
			workerId: worker.name,
			mainModule: mainModule,
			modules: getModules(distDir, mainModule),
			bindings: scriptBindings,
			compatibilityDate: compatibility.date,
			compatibilityFlags: compatibility.flags,
			...(assets ? { assets: { directory: assets.directory } } : {})
		},
		{
			dependsOn: workflowsWorker ? [worker, workflowsWorker.version] : [worker]
		}
	);

	const deployment = new cloudflare.WorkersDeployment(
		'api-worker-deployment',
		{
			accountId: accountId,
			scriptName: naming.workerApi,
			strategy: 'percentage',
			versions: [{ percentage: 100, versionId: version.id }]
		},
		{ dependsOn: version }
	);

	return { worker, version, workerName: naming.workerApi };
}

export function createWorkerRoute(
	workerName: string,
	pattern: string,
	zoneId: string,
	logicalName: string = 'api-route'
) {
	return new cloudflare.WorkersRoute(logicalName, {
		zoneId: zoneId,
		pattern: pattern,
		script: workerName
	});
}
