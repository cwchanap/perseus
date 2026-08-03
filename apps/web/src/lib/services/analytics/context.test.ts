import { describe, expect, it } from 'vitest';
import {
	buildAnalyticsClientContextV1,
	buildAnalyticsPuzzleContextV1,
	classifyAspectBucket,
	classifyAssistanceMode,
	classifyPieceCountBucket,
	classifyPrimaryInput,
	classifyProgressBucket,
	classifyViewportClass,
	resolveAuthenticationClass,
	resolveContentOrigin
} from './context';

describe('analytics context projection', () => {
	describe('piece-count buckets', () => {
		it.each([
			[1, '1-24'],
			[24, '1-24'],
			[25, '25-49'],
			[49, '25-49'],
			[50, '50-99'],
			[99, '50-99'],
			[100, '100-149'],
			[149, '100-149'],
			[150, '150-225'],
			[225, '150-225'],
			[226, '226+'],
			[250, '226+']
		] as const)('classifies %s as %s', (pieceCount, expected) => {
			expect(classifyPieceCountBucket(pieceCount)).toBe(expected);
		});

		it.each([0, -1, 1.5, 251, Number.NaN, Number.POSITIVE_INFINITY])(
			'rejects invalid piece count %s',
			(pieceCount) => {
				expect(classifyPieceCountBucket(pieceCount)).toBeNull();
			}
		);
	});

	describe('aspect buckets', () => {
		it('prefers a declared aspect over pixel dimensions', () => {
			expect(
				classifyAspectBucket({ declaredAspect: 'portrait', width: 1600, height: 900 })
			).toBe('portrait');
		});

		it.each([
			[{ width: 100, height: 100 }, 'square'],
			[{ width: 200, height: 100 }, 'landscape'],
			[{ width: 100, height: 200 }, 'portrait']
		] as const)('classifies $0 as $1', (input, expected) => {
			expect(classifyAspectBucket(input)).toBe(expected);
		});

		it.each([
			{ width: 0, height: 100 },
			{ width: 100, height: 0 },
			{ width: -1, height: 100 },
			{ width: Number.NaN, height: 100 }
		])('rejects invalid dimensions $width x $height', (input) => {
			expect(classifyAspectBucket(input)).toBeNull();
		});
	});

	describe('viewport classes', () => {
		it.each([
			[0, 'mobile'],
			[767.99, 'mobile'],
			[768, 'tablet'],
			[1023.99, 'tablet'],
			[1024, 'desktop']
		] as const)('classifies width %s as %s', (width, expected) => {
			expect(classifyViewportClass(width)).toBe(expected);
		});

		it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
			'rejects invalid width %s',
			(width) => {
				expect(classifyViewportClass(width)).toBeNull();
			}
		);
	});

	describe('progress buckets', () => {
		it.each([
			[0, 250, '0'],
			[1, 250, '1-24'],
			[62, 250, '1-24'],
			[63, 250, '25-49'],
			[124, 250, '25-49'],
			[125, 250, '50-74'],
			[187, 250, '50-74'],
			[188, 250, '75-99'],
			[249, 250, '75-99'],
			[250, 250, '100'],
			[1, 1, '100']
		] as const)('classifies %s/%s as %s', (placed, total, expected) => {
			expect(classifyProgressBucket(placed, total)).toBe(expected);
		});

		it.each([
			[-1, 250],
			[251, 250],
			[1.5, 250],
			[1, 0],
			[1, 251]
		])('rejects invalid progress %s/%s', (placed, total) => {
			expect(classifyProgressBucket(placed, total)).toBeNull();
		});
	});

	describe('primary input', () => {
		it('prefers the last keyboard interaction', () => {
			expect(
				classifyPrimaryInput({
					lastInteraction: 'keyboard',
					pointerType: 'touch',
					coarsePointer: true
				})
			).toBe('keyboard');
		});

		it('classifies touch as coarse and mouse or pen as fine', () => {
			expect(
				classifyPrimaryInput({
					lastInteraction: 'pointer',
					pointerType: 'touch',
					coarsePointer: null
				})
			).toBe('coarse_pointer');
			expect(
				classifyPrimaryInput({
					lastInteraction: 'pointer',
					pointerType: 'mouse',
					coarsePointer: true
				})
			).toBe('fine_pointer');
			expect(
				classifyPrimaryInput({
					lastInteraction: 'pointer',
					pointerType: 'pen',
					coarsePointer: true
				})
			).toBe('fine_pointer');
		});

		it('uses the media-query fallback and otherwise returns unknown', () => {
			expect(
				classifyPrimaryInput({
					lastInteraction: 'pointer',
					pointerType: '',
					coarsePointer: true
				})
			).toBe('coarse_pointer');
			expect(
				classifyPrimaryInput({
					lastInteraction: null,
					coarsePointer: false
				})
			).toBe('fine_pointer');
			expect(
				classifyPrimaryInput({
					lastInteraction: null,
					coarsePointer: null
				})
			).toBe('unknown');
		});
	});

	describe('authentication and content origin', () => {
		it.each([
			['loading', 'unknown'],
			['authenticated', 'authenticated'],
			['anonymous', 'anonymous']
		] as const)('maps %s to %s', (status, expected) => {
			expect(resolveAuthenticationClass(status)).toBe(expected);
		});

		it('maps local content to player uploaded and API content to bounded or unknown origin', () => {
			expect(resolveContentOrigin({ puzzleSource: 'local' })).toBe('player_uploaded');
			expect(resolveContentOrigin({ puzzleSource: 'api' })).toBe('unknown');
			expect(
				resolveContentOrigin({ puzzleSource: 'api', apiOrigin: 'player_uploaded' })
			).toBe('player_uploaded');
			expect(resolveContentOrigin({ puzzleSource: 'api', apiOrigin: 'system' })).toBe(
				'system'
			);
		});
	});

	describe('persisted assistance classification', () => {
		it.each([
			[
				{ hintUsed: false, ghostReferenceUsed: false, referenceActivations: 0 },
				'none'
			],
			[{ hintUsed: true, ghostReferenceUsed: false, referenceActivations: 0 }, 'hint'],
			[
				{ hintUsed: false, ghostReferenceUsed: false, referenceActivations: 2 },
				'reference'
			],
			[
				{ hintUsed: false, ghostReferenceUsed: true, referenceActivations: 2 },
				'ghost_reference'
			],
			[{ hintUsed: true, ghostReferenceUsed: false, referenceActivations: 2 }, 'mixed'],
			[{ hintUsed: true, ghostReferenceUsed: true, referenceActivations: 2 }, 'mixed']
		] as const)('classifies $0 as $1', (snapshot, expected) => {
			expect(classifyAssistanceMode(snapshot)).toBe(expected);
		});

		it.each([-1, 1.5, Number.NaN])('rejects invalid activation count %s', (count) => {
			expect(
				classifyAssistanceMode({
					hintUsed: false,
					ghostReferenceUsed: false,
					referenceActivations: count
				})
			).toBeNull();
		});
	});

	describe('context builders', () => {
		it('builds a client context while auth is loading', () => {
			expect(
				buildAnalyticsClientContextV1({
					authStatus: 'loading',
					viewportWidth: 390,
					primaryInput: {
						lastInteraction: 'pointer',
						pointerType: 'touch',
						coarsePointer: true
					}
				})
			).toEqual({
				authentication: 'unknown',
				viewportClass: 'mobile',
				primaryInput: 'coarse_pointer'
			});
		});

		it('builds an allowlisted puzzle context from event-time facts', () => {
			const client = buildAnalyticsClientContextV1({
				authStatus: 'authenticated',
				viewportWidth: 1200,
				primaryInput: {
					lastInteraction: 'keyboard',
					coarsePointer: false
				}
			});
			expect(client).not.toBeNull();
			expect(
				buildAnalyticsPuzzleContextV1({
					client: client!,
					puzzleSource: 'local',
					declaredAspect: 'portrait',
					pieceCount: 250,
					imageWidth: 1600,
					imageHeight: 900,
					sessionMode: 'timed',
					resultClass: 'assisted_timed',
					timingQuality: 'known',
					sessionOrigin: 'resumed',
					rotationUsed: true,
					placedPieceCount: 249,
					assistance: {
						hintUsed: true,
						ghostReferenceUsed: false,
						referenceActivations: 3
					}
				})
			).toEqual({
				...client,
				puzzleSource: 'local',
				contentOrigin: 'player_uploaded',
				pieceCountBucket: '226+',
				aspectBucket: 'portrait',
				sessionMode: 'timed',
				resultClass: 'assisted_timed',
				timingQuality: 'known',
				sessionOrigin: 'resumed',
				rotationUsed: true,
				progressBucket: '75-99',
				assistanceMode: 'mixed'
			});
		});

		it('returns null when a bounded projection cannot be produced', () => {
			expect(
				buildAnalyticsClientContextV1({
					authStatus: 'anonymous',
					viewportWidth: -1,
					primaryInput: { lastInteraction: null, coarsePointer: null }
				})
			).toBeNull();

			expect(
				buildAnalyticsPuzzleContextV1({
					client: {
						authentication: 'anonymous',
						viewportClass: 'desktop',
						primaryInput: 'fine_pointer'
					},
					puzzleSource: 'api',
					pieceCount: 100,
					imageWidth: 100,
					imageHeight: 100,
					sessionMode: 'timed',
					resultClass: 'standard_timed',
					timingQuality: 'known',
					sessionOrigin: 'new',
					rotationUsed: false,
					placedPieceCount: 101,
					assistance: {
						hintUsed: false,
						ghostReferenceUsed: false,
						referenceActivations: 0
					}
				})
			).toBeNull();
		});
	});
});
