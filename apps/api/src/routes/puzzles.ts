// Puzzle routes for public access
import { Hono } from 'hono';
import { getPuzzle, listPuzzlesSorted, getThumbnailPath, getPieceImagePath } from '../services/storage';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const puzzles = new Hono();

function getImageContentType(filePath: string): string {
	const ext = extname(filePath).toLowerCase();
	if (ext === '.png') return 'image/png';
	if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
	if (ext === '.webp') return 'image/webp';
	return 'application/octet-stream';
}

// GET /api/puzzles - List all puzzles
puzzles.get('/', async (c) => {
	try {
		const puzzleList = await listPuzzlesSorted();
		return c.json({ puzzles: puzzleList });
	} catch (error) {
		console.error('Failed to list puzzles');
		if (error instanceof Error) {
			console.error(error.stack || error.message);
		} else {
			console.error(error);
		}
		return c.json({ error: 'internal_error', message: 'Failed to list puzzles' }, 500);
	}
});

// GET /api/puzzles/:id - Get puzzle details
puzzles.get('/:id', async (c) => {
  const id = c.req.param('id');
  let puzzle: Awaited<ReturnType<typeof getPuzzle>>;

  try {
		puzzle = await getPuzzle(id);
	} catch (error) {
		console.error('Failed to retrieve puzzle');
		if (error instanceof Error) {
			console.error(error.stack || error.message);
		} else {
			console.error(error);
		}
		return c.json({ error: 'internal_error', message: 'Failed to retrieve puzzle' }, 500);
	}

  if (!puzzle) {
    return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
  }

  return c.json(puzzle);
});

// GET /api/puzzles/:id/thumbnail - Get puzzle thumbnail image
puzzles.get('/:id/thumbnail', async (c) => {
  const id = c.req.param('id');
	let puzzle: Awaited<ReturnType<typeof getPuzzle>>;

	try {
		puzzle = await getPuzzle(id);
	} catch (error) {
		console.error('Failed to retrieve puzzle');
		if (error instanceof Error) {
			console.error(error.stack || error.message);
		} else {
			console.error(error);
		}
		return c.json({ error: 'internal_error', message: 'Failed to retrieve puzzle' }, 500);
	}

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
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT' || (error instanceof Error && error.message === 'Invalid puzzleId')) {
      return c.json({ error: 'not_found', message: 'Thumbnail not found' }, 404);
    }
    console.error('Failed to retrieve thumbnail');
    if (error instanceof Error) {
      console.error(error.stack || error.message);
    } else {
      console.error(error);
    }
    return c.json({ error: 'internal_error', message: 'Failed to retrieve thumbnail' }, 500);
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

  let puzzle: Awaited<ReturnType<typeof getPuzzle>>;

  try {
    puzzle = await getPuzzle(id);
  } catch (error) {
    console.error('Failed to retrieve puzzle');
    if (error instanceof Error) {
      console.error(error.stack || error.message);
    } else {
      console.error(error);
    }
    return c.json({ error: 'internal_error', message: 'Failed to retrieve puzzle' }, 500);
  }

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
      'Content-Type': getImageContentType(piecePath),
      'Cache-Control': 'public, max-age=86400'
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT' || (error instanceof Error && error.message === 'Invalid puzzleId')) {
      return c.json({ error: 'not_found', message: 'Piece image not found' }, 404);
    }
    console.error('Failed to retrieve piece image');
    if (error instanceof Error) {
      console.error(error.stack || error.message);
    } else {
      console.error(error);
    }
    return c.json({ error: 'internal_error', message: 'Failed to retrieve piece image' }, 500);
  }
});

export default puzzles;
