// Admin routes for authentication and puzzle management
import { Hono } from 'hono';
import {
  createSession,
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
  verifySession,
  requireAuth
} from '../middleware/auth';
import { generatePuzzle, isValidPieceCount } from '../services/puzzle-generator';
import { createPuzzle as storePuzzle, deletePuzzle as deleteStoredPuzzle } from '../services/storage';
import { MAX_FILE_SIZE, ALLOWED_MIME_TYPES } from '../types';

const admin = new Hono();

const ADMIN_PASSKEY = process.env.ADMIN_PASSKEY || 'admin';
const DATA_DIR = process.env.DATA_DIR || './data';

// POST /api/admin/login - Admin login
admin.post('/login', async (c) => {
  try {
    const body = await c.req.json();
    const { passkey } = body as { passkey?: string };

    if (!passkey) {
      return c.json({ error: 'bad_request', message: 'Passkey is required' }, 400);
    }

    if (passkey !== ADMIN_PASSKEY) {
      return c.json({ error: 'unauthorized', message: 'Invalid passkey' }, 401);
    }

    const token = await createSession();
    setSessionCookie(c, token);

    return c.json({ success: true });
  } catch {
    return c.json({ error: 'bad_request', message: 'Invalid request body' }, 400);
  }
});

// POST /api/admin/logout - Admin logout
admin.post('/logout', async (c) => {
  clearSessionCookie(c);
  return c.json({ success: true });
});

// GET /api/admin/session - Check admin session
admin.get('/session', async (c) => {
  const token = getSessionToken(c);

  if (!token) {
    return c.json({ authenticated: false });
  }

  const session = await verifySession(token);

  if (!session) {
    clearSessionCookie(c);
    return c.json({ authenticated: false });
  }

  return c.json({ authenticated: true });
});

// POST /api/admin/puzzles - Create new puzzle (protected)
admin.post('/puzzles', requireAuth, async (c) => {
  try {
    const formData = await c.req.formData();
    const name = formData.get('name');
    const pieceCountStr = formData.get('pieceCount');
    const image = formData.get('image');

    // Validate required fields
    if (!name || typeof name !== 'string') {
      return c.json({ error: 'bad_request', message: 'Name is required' }, 400);
    }

    if (!pieceCountStr) {
      return c.json({ error: 'bad_request', message: 'Piece count is required' }, 400);
    }

    const pieceCount = parseInt(pieceCountStr.toString(), 10);
    if (!isValidPieceCount(pieceCount)) {
      return c.json({ error: 'bad_request', message: 'Invalid piece count. Allowed: 9, 16, 25, 36, 49, 64, 100' }, 400);
    }

    if (!image || !(image instanceof File)) {
      return c.json({ error: 'bad_request', message: 'Image file is required' }, 400);
    }

    // Validate file size
    if (image.size > MAX_FILE_SIZE) {
      return c.json({ error: 'bad_request', message: 'File size exceeds 10MB limit' }, 400);
    }

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(image.type as typeof ALLOWED_MIME_TYPES[number])) {
      return c.json({ error: 'bad_request', message: 'Invalid file type. Allowed: JPEG, PNG, WebP' }, 400);
    }

    // Generate puzzle ID
    const id = crypto.randomUUID();

    // Read image buffer
    const imageBuffer = Buffer.from(await image.arrayBuffer());

    // Generate puzzle pieces and thumbnail
    const result = await generatePuzzle({
      id,
      name: name.trim(),
      pieceCount,
      imageBuffer,
      outputDir: `${DATA_DIR}/puzzles`
    });

    // Save puzzle metadata
    await storePuzzle(result.puzzle);

    return c.json(result.puzzle, 201);
  } catch (error) {
    console.error('Error creating puzzle:', error);
    return c.json({ error: 'internal_error', message: 'Failed to create puzzle' }, 500);
  }
});

// DELETE /api/admin/puzzles/:id - Delete puzzle (protected)
admin.delete('/puzzles/:id', requireAuth, async (c) => {
  const id = c.req.param('id');

  const deleted = await deleteStoredPuzzle(id);

  if (!deleted) {
    return c.json({ error: 'not_found', message: 'Puzzle not found' }, 404);
  }

  return c.body(null, 204);
});

export default admin;
