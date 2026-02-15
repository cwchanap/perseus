// Mock Cloudflare Workers types for testing
export interface WorkflowEntrypoint<Env, _Params> {
	env: Env;
	run(event: unknown, step: unknown): Promise<void>;
}

export interface WorkflowStep {
	do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface WorkflowEvent<T> {
	payload: T;
}

// Create a mock WorkflowEntrypoint class
export class _MockWorkflowEntrypoint<Env, _Params> {
	env!: Env;
	async run(_event: WorkflowEvent<_Params>, _step: WorkflowStep): Promise<void> {
		throw new Error('Not implemented in mock');
	}
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Workflow {}
