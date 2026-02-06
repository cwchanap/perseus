import { vi } from 'vitest';

// Mock Cloudflare Workers types

// Minimal runtime classes so instanceof checks and construction succeed in tests
class MockWorkflowStep {
	async do<T>(_name: string, fn: () => Promise<T>): Promise<T> {
		return fn();
	}
}

class MockWorkflowEvent<T> {
	payload: T;
	timestamp: Date;
	instanceId: string;
	constructor(payload: T) {
		this.payload = payload;
		this.timestamp = new Date();
		this.instanceId = '';
	}
}

// Create a mock WorkflowEntrypoint class
class MockWorkflowEntrypoint<Env, Params> {
	env: Env = {} as Env;
	async run(_event: MockWorkflowEvent<Params>, _step: MockWorkflowStep): Promise<void> {
		throw new Error('Not implemented in mock');
	}
}

vi.mock('cloudflare:workers', () => ({
	WorkflowEntrypoint: MockWorkflowEntrypoint,
	WorkflowStep: MockWorkflowStep,
	WorkflowEvent: MockWorkflowEvent
}));

// Re-export for use in tests
export { MockWorkflowEntrypoint as WorkflowEntrypoint };
export type WorkflowStep = MockWorkflowStep;
export type WorkflowEvent<T> = MockWorkflowEvent<T>;
