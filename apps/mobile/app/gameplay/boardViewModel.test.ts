import { describe, expect, it } from 'vitest';
import { createBoardViewModel } from './boardViewModel';

describe('BoardViewModel', () => {
	it('maps fitted canvas points to canonical cells', () => {
		const vm = createBoardViewModel({
			canvasWidth: 800,
			canvasHeight: 600,
			gridCols: 2,
			gridRows: 2
		});

		expect(vm.cellAt(250, 150)).toEqual({ x: 0, y: 0 });
		expect(vm.cellAt(550, 450)).toEqual({ x: 1, y: 1 });
		expect(vm.cellAt(5, 5)).toBeNull();
	});
});
