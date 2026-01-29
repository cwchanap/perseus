import { vi } from 'vitest';

// Mock Cloudflare Workers types
export interface WorkflowStep {
	do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export interface WorkflowEvent<T> {
	payload: T;
}

// Create a mock WorkflowEntrypoint class
class MockWorkflowEntrypoint<Env, Params> {
	env!: Env;
	async run(_event: WorkflowEvent<Params>, _step: WorkflowStep): Promise<void> {
		throw new Error('Not implemented in mock');
	}
}

// Mock the cloudflare:workers module
vi.mock('cloudflare:workers', () => ({
	WorkflowEntrypoint: MockWorkflowEntrypoint,
	WorkflowStep: {},
	WorkflowEvent: {}
}));

// Re-export types for use in tests
export { MockWorkflowEntrypoint as WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent };
