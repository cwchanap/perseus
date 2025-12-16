// Unit tests for puzzle API endpoints
import { describe, it, expect } from 'bun:test';
import app from '../index';
import type { PuzzleListResponse, PuzzleSummary, ErrorResponse } from '../types/index';

describe('GET /api/puzzles', () => {
  it('should return empty array when no puzzles exist', async () => {
    const response = await app.fetch(new Request('http://localhost/api/puzzles'));
    expect(response.status).toBe(200);

    const data = (await response.json()) as PuzzleListResponse;
    expect(data).toHaveProperty('puzzles');
    expect(Array.isArray(data.puzzles)).toBe(true);
  });

  it('should return puzzles array with correct structure', async () => {
    const response = await app.fetch(new Request('http://localhost/api/puzzles'));
    expect(response.status).toBe(200);

    const data = (await response.json()) as PuzzleListResponse;
    expect(data.puzzles).toBeDefined();
    // Each puzzle should have id, name, pieceCount, thumbnailUrl
    for (const puzzle of data.puzzles as PuzzleSummary[]) {
      expect(puzzle).toHaveProperty('id');
      expect(puzzle).toHaveProperty('name');
      expect(puzzle).toHaveProperty('pieceCount');
      expect(puzzle).toHaveProperty('thumbnailUrl');
    }
  });
});

describe('GET /api/puzzles/:id', () => {
  it('should return 404 for non-existent puzzle', async () => {
    const response = await app.fetch(
      new Request('http://localhost/api/puzzles/non-existent-id')
    );
    expect(response.status).toBe(404);

    const data = (await response.json()) as ErrorResponse;
    expect(data.error).toBe('not_found');
  });
});

describe('GET /api/puzzles/:id/thumbnail', () => {
  it('should return 404 for non-existent puzzle thumbnail', async () => {
    const response = await app.fetch(
      new Request('http://localhost/api/puzzles/non-existent-id/thumbnail')
    );
    expect(response.status).toBe(404);
  });
});

describe('GET /api/puzzles/:id/pieces/:pieceId/image', () => {
  it('should return 404 for non-existent puzzle piece', async () => {
    const response = await app.fetch(
      new Request('http://localhost/api/puzzles/non-existent-id/pieces/0/image')
    );
    expect(response.status).toBe(404);
  });

  it('should return 400 for invalid piece ID', async () => {
    const response = await app.fetch(
      new Request('http://localhost/api/puzzles/some-id/pieces/invalid/image')
    );
    expect(response.status).toBe(400);
  });

  it('should return 400 for negative piece ID', async () => {
    const response = await app.fetch(
      new Request('http://localhost/api/puzzles/some-id/pieces/-1/image')
    );
    expect(response.status).toBe(400);
  });
});
