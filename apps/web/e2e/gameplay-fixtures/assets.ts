// Deterministic padded SVG assets for gameplay fixtures.
//
// Each piece is served as a self-contained, dependency-free SVG with transparent
// padding that matches the production `TAB_RATIO` / `EXPANSION_FACTOR` overflow
// model: the visible content is centered inside a `PADDED_PIECE_SIZE` canvas with
// `BASE_OFFSET` padding on every side, leaving room for tab protrusions.
//
// These are synthetic stand-ins (a colored rectangle per piece), NOT full
// jigsaw-shaped masks. Tests may assert loading, placement, and layout, but must
// not infer pixel-perfect tab geometry from synthetic assets.
import { BASE_OFFSET } from '../../src/lib/constants/puzzle';
import { FIXTURE_BASE_PIECE_SIZE, PADDED_PIECE_SIZE, type GameplayFixture } from './builder';

export const SVG_CONTENT_TYPE = 'image/svg+xml';

/** Transparent padding applied to each side of a piece's visible content. */
export const PIECE_CONTENT_OFFSET = Math.round(BASE_OFFSET * PADDED_PIECE_SIZE);

const SVG_NS = 'http://www.w3.org/2000/svg';

function escapeXml(value: string): string {
	return value.replace(/[<>&'"]/g, (c) => {
		switch (c) {
			case '<':
				return '&lt;';
			case '>':
				return '&gt;';
			case '&':
				return '&amp;';
			case "'":
				return '&apos;';
			case '"':
				return '&quot;';
			default:
				return c;
		}
	});
}

/** Deterministic hue spread so adjacent pieces are visually distinguishable. */
function pieceHue(pieceId: number): number {
	return (pieceId * 47) % 360;
}

function pieceColor(pieceId: number, lightness: number): string {
	const hue = pieceHue(pieceId);
	return `hsl(${hue},70%,${lightness}%)`;
}

/**
 * Render a single piece as a padded SVG. The content rectangle sits at
 * `PIECE_CONTENT_OFFSET` on every side within a `PADDED_PIECE_SIZE` canvas; the
 * surrounding padding is transparent to accommodate tab protrusions.
 */
export function buildPieceSvg(fixture: GameplayFixture, pieceId: number): string {
	const piece = fixture.pieces[pieceId];
	if (!piece || piece.id !== pieceId) {
		throw new Error(
			`buildPieceSvg: fixture "${fixture.fixtureId}" has no piece with id ${pieceId}`
		);
	}
	const size = PADDED_PIECE_SIZE;
	const offset = PIECE_CONTENT_OFFSET;
	const content = FIXTURE_BASE_PIECE_SIZE;
	const fixtureId = escapeXml(fixture.fixtureId);
	const fill = pieceColor(pieceId, 55);
	const stroke = pieceColor(pieceId, 30);
	return [
		`<svg xmlns="${SVG_NS}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
		`\t<desc>perseus-e2e fixture=${fixtureId} piece=${piece.id} row=${piece.correctY} col=${piece.correctX}</desc>`,
		`\t<rect x="${offset}" y="${offset}" width="${content}" height="${content}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`,
		`</svg>`
	].join('\n');
}

/**
 * Render the full reference image as a single SVG. Each piece occupies its
 * correct grid cell at `FIXTURE_BASE_PIECE_SIZE` per side, so the canvas matches
 * the fixture's declared `imageWidth` × `imageHeight`.
 */
export function buildReferenceSvg(fixture: GameplayFixture): string {
	const width = fixture.imageWidth;
	const height = fixture.imageHeight;
	const cell = FIXTURE_BASE_PIECE_SIZE;
	const fixtureId = escapeXml(fixture.fixtureId);
	const rects = fixture.pieces
		.map((piece) => {
			const x = piece.correctX * cell;
			const y = piece.correctY * cell;
			const fill = pieceColor(piece.id, 55);
			const stroke = pieceColor(piece.id, 30);
			return `\t<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
		})
		.join('\n');
	return [
		`<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`\t<desc>perseus-e2e reference fixture=${fixtureId} rows=${fixture.rows} cols=${fixture.cols} pieces=${fixture.pieceCount}</desc>`,
		rects,
		`</svg>`
	].join('\n');
}
