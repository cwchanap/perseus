// Puzzle routes for public access
import { Hono } from 'hono';
import { getPuzzle, listPuzzlesSorted, getThumbnailPath, getPieceImagePath } from '../services/storage';
import { readFile } from 'node:fs/promises';

const puzzles = new Hono();

// GET /api/puzzles - List all puzzles
puzzles.get('/', async (c) => {
  const puzzleList = await listPuzzlesSorted();
  return c.json({ puzzles: puzzleList });
});

// GET /api/puzzles/:id - Get puzzle details
puzzles.get('/:id', async (c) => {
  const id = c.req.param('id');
  const puzzle = await getPuzzle(id);

  if (!puzzle) {
    return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
  }

  return c.json(puzzle);
});

// GET /api/puzzles/:id/thumbnail - Get puzzle thumbnail image
puzzles.get('/:id/thumbnail', async (c) => {
  const id = c.req.param('id');
  const puzzle = await getPuzzle(id);

  if (!puzzle) {
    return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
  }

  try {
    const thumbnailPath = getThumbnailPath(id);
    const imageData = await readFile(thumbnailPath);
    return c.body(imageData, 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=86400'
    });
  } catch {
    return c.json({ error: 'not_found', message: 'Thumbnail not found' }, 404);
  }
});

// GET /api/puzzles/:id/pieces/:pieceId/image - Get piece image
puzzles.get('/:id/pieces/:pieceId/image', async (c) => {
  const id = c.req.param('id');
  const pieceIdStr = c.req.param('pieceId');
  const pieceId = parseInt(pieceIdStr, 10);

  if (isNaN(pieceId) || pieceId < 0) {
    return c.json({ error: 'invalid_piece_id', message: 'Invalid piece ID' }, 400);
  }

  const puzzle = await getPuzzle(id);

  if (!puzzle) {
    return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
  }

  if (pieceId >= puzzle.pieceCount) {
    return c.json({ error: 'not_found', message: 'Piece not found' }, 404);
  }

  try {
    const piecePath = getPieceImagePath(id, pieceId);
    const imageData = await readFile(piecePath);
    return c.body(imageData, 200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400'
    });
  } catch {
    return c.json({ error: 'not_found', message: 'Piece image not found' }, 404);
  }
});

export default puzzles;
