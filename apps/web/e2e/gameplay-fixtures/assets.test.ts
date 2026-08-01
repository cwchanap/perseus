// Invariant tests for deterministic padded SVG assets.
//
// Piece SVGs must be self-contained (no external references), carry transparent
// padding that matches TAB_RATIO / EXPANSION_FACTOR, and embed fixture/piece
// identity. Reference SVGs must cover every grid cell at the declared canvas
// size. Output is byte-stable for a given fixture.
import { describe, expect, it } from 'bun:test';
import { TAB_RATIO, EXPANSION_FACTOR } from '../../src/lib/constants/puzzle';
import { FIXTURE_BASE_PIECE_SIZE, PADDED_PIECE_SIZE, type GameplayFixture } from './builder';
import { PIECE_CONTENT_OFFSET, SVG_CONTENT_TYPE, buildPieceSvg, buildReferenceSvg } from './assets';
import { FIXTURE_IDS, getFixture } from './catalog';

function openSvgTag(svg: string): string {
	const match = svg.match(/<svg\b[^>]*>/);
	expect(match, 'svg must have an opening <svg> tag').toBeDefined();
	return match![0];
}

function attr(tag: string, name: string): string {
	const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
	expect(match, `expected attribute "${name}" on tag`).toBeDefined();
	return match![1];
}

function firstRect(svg: string): string {
	const match = svg.match(/<rect\b[^>]*\/>/);
	expect(match, 'svg must contain a <rect/>').toBeDefined();
	return match![0];
}

function countRects(svg: string): number {
	return (svg.match(/<rect\b[^>]*\/>/g) ?? []).length;
}

describe('assets - content type', () => {
	it('exposes the SVG content type', () => {
		expect(SVG_CONTENT_TYPE).toBe('image/svg+xml');
	});
});

describe('assets - piece SVG padding model', () => {
	for (const id of FIXTURE_IDS) {
		it(`${id} piece 0 canvas matches EXPANSION_FACTOR with TAB_RATIO padding`, () => {
			const fixture = getFixture(id);
			const svg = buildPieceSvg(fixture, 0);
			const tag = openSvgTag(svg);

			expect(attr(tag, 'width')).toBe(String(PADDED_PIECE_SIZE));
			expect(attr(tag, 'height')).toBe(String(PADDED_PIECE_SIZE));
			expect(attr(tag, 'viewBox')).toBe(`0 0 ${PADDED_PIECE_SIZE} ${PADDED_PIECE_SIZE}`);
			expect(PADDED_PIECE_SIZE).toBe(Math.round(FIXTURE_BASE_PIECE_SIZE * EXPANSION_FACTOR));

			const rect = firstRect(svg);
			expect(attr(rect, 'x')).toBe(String(PIECE_CONTENT_OFFSET));
			expect(attr(rect, 'y')).toBe(String(PIECE_CONTENT_OFFSET));
			expect(attr(rect, 'width')).toBe(String(FIXTURE_BASE_PIECE_SIZE));
			expect(attr(rect, 'height')).toBe(String(FIXTURE_BASE_PIECE_SIZE));

			// Padding is TAB_RATIO of the content size on each side.
			expect(PIECE_CONTENT_OFFSET).toBe(Math.round(TAB_RATIO * FIXTURE_BASE_PIECE_SIZE));
			// Content + 2 * padding equals the full padded canvas.
			expect(FIXTURE_BASE_PIECE_SIZE + 2 * PIECE_CONTENT_OFFSET).toBe(PADDED_PIECE_SIZE);
		});
	}
});

describe('assets - identity and determinism', () => {
	it('embeds fixture id, piece id, row, and col in the desc', () => {
		const fixture = getFixture('e2e-landscape-12');
		const piece = fixture.pieces[5]!;
		const svg = buildPieceSvg(fixture, piece.id);
		expect(svg).toContain(`fixture=${fixture.fixtureId}`);
		expect(svg).toContain(`piece=${piece.id}`);
		expect(svg).toContain(`row=${piece.correctY}`);
		expect(svg).toContain(`col=${piece.correctX}`);
	});

	it('is byte-stable for identical inputs', () => {
		const fixture = getFixture('e2e-square-225');
		const a = buildPieceSvg(fixture, 7);
		const b = buildPieceSvg(fixture, 7);
		expect(a).toBe(b);
	});

	it('distinguishes pieces by color', () => {
		const fixture = getFixture('e2e-square-4');
		const a = buildPieceSvg(fixture, 0);
		const b = buildPieceSvg(fixture, 1);
		expect(a).not.toBe(b);
	});

	it('throws for an unknown piece id', () => {
		const fixture = getFixture('e2e-square-4');
		expect(() => buildPieceSvg(fixture, 99)).toThrow(/piece with id 99/);
	});
});

describe('assets - self-contained and XML-safe', () => {
	for (const id of FIXTURE_IDS) {
		it(`${id} piece SVG has no external references and is well-formed`, () => {
			const svg = buildPieceSvg(getFixture(id), 0);
			expect(svg.startsWith('<svg')).toBe(true);
			expect(svg.trim().endsWith('</svg>')).toBe(true);
			expect(svg).not.toContain('href');
			expect(svg).not.toContain('xlink');
			expect(svg).not.toContain('src=');
			expect(countRects(svg)).toBe(1);
		});
	}

	it('escapes XML-special characters in the fixture id', () => {
		const crafted = {
			fixtureId: 'a&b<c>"d"',
			pieces: [{ id: 0, puzzleId: 'x', correctX: 0, correctY: 0, edges: {} }],
			imageWidth: 100,
			imageHeight: 100,
			rows: 1,
			cols: 1
		} as unknown as GameplayFixture;
		const svg = buildPieceSvg(crafted, 0);
		expect(svg).not.toContain('fixture=a&b');
		expect(svg).toContain('fixture=a&amp;b&lt;c&gt;&quot;d&quot;');
	});
});

describe('assets - reference SVG', () => {
	for (const id of FIXTURE_IDS) {
		it(`${id} reference canvas matches the grid and covers every piece`, () => {
			const fixture = getFixture(id);
			const svg = buildReferenceSvg(fixture);
			const tag = openSvgTag(svg);
			expect(attr(tag, 'width')).toBe(String(fixture.imageWidth));
			expect(attr(tag, 'height')).toBe(String(fixture.imageHeight));
			expect(attr(tag, 'viewBox')).toBe(`0 0 ${fixture.imageWidth} ${fixture.imageHeight}`);
			expect(countRects(svg)).toBe(fixture.pieceCount);
			expect(svg).toContain(`rows=${fixture.rows}`);
			expect(svg).toContain(`cols=${fixture.cols}`);
		});
	}

	it('is byte-stable for identical inputs', () => {
		const fixture = getFixture('e2e-square-100');
		expect(buildReferenceSvg(fixture)).toBe(buildReferenceSvg(fixture));
	});
});
