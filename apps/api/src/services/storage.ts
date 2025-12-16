// Storage service for puzzle CRUD operations
// Uses JSON files for metadata and filesystem for images

import { mkdir, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Puzzle, PuzzleSummary } from '../types/index';

const DATA_DIR = process.env.DATA_DIR || './data';
const PUZZLES_DIR = join(DATA_DIR, 'puzzles');

// Initialize data directory structure
export async function initializeStorage(): Promise<void> {
  try {
    await mkdir(PUZZLES_DIR, { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }
}

// Get puzzle directory path
export function getPuzzleDir(puzzleId: string): string {
  return join(PUZZLES_DIR, puzzleId);
}

// Get puzzle pieces directory path
export function getPiecesDir(puzzleId: string): string {
  return join(getPuzzleDir(puzzleId), 'pieces');
}

// Get metadata file path
function getMetadataPath(puzzleId: string): string {
  return join(getPuzzleDir(puzzleId), 'metadata.json');
}

// Get original image path
export function getOriginalImagePath(puzzleId: string): string {
  return join(getPuzzleDir(puzzleId), 'original.jpg');
}

// Get thumbnail path
export function getThumbnailPath(puzzleId: string): string {
  return join(getPuzzleDir(puzzleId), 'thumbnail.jpg');
}

// Get piece image path
export function getPieceImagePath(puzzleId: string, pieceId: number): string {
  return join(getPiecesDir(puzzleId), `${pieceId}.png`);
}

// Check if puzzle exists
export async function puzzleExists(puzzleId: string): Promise<boolean> {
  try {
    await access(getMetadataPath(puzzleId));
    return true;
  } catch {
    return false;
  }
}

// Create a new puzzle
export async function createPuzzle(puzzle: Puzzle): Promise<void> {
  const puzzleDir = getPuzzleDir(puzzle.id);
  const piecesDir = getPiecesDir(puzzle.id);

  await mkdir(puzzleDir, { recursive: true });
  await mkdir(piecesDir, { recursive: true });

  await writeFile(getMetadataPath(puzzle.id), JSON.stringify(puzzle, null, 2), 'utf-8');
}

// Get a puzzle by ID
export async function getPuzzle(puzzleId: string): Promise<Puzzle | null> {
  try {
    const data = await readFile(getMetadataPath(puzzleId), 'utf-8');
    return JSON.parse(data) as Puzzle;
  } catch {
    return null;
  }
}

// Update puzzle metadata
export async function updatePuzzle(puzzle: Puzzle): Promise<void> {
  await writeFile(getMetadataPath(puzzle.id), JSON.stringify(puzzle, null, 2), 'utf-8');
}

// Delete a puzzle and all its files
export async function deletePuzzle(puzzleId: string): Promise<boolean> {
  try {
    const puzzleDir = getPuzzleDir(puzzleId);
    await rm(puzzleDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// List all puzzles
export async function listPuzzles(): Promise<PuzzleSummary[]> {
  try {
    const entries = await readdir(PUZZLES_DIR, { withFileTypes: true });
    const puzzles: PuzzleSummary[] = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const puzzle = await getPuzzle(entry.name);
        if (puzzle) {
          puzzles.push({
            id: puzzle.id,
            name: puzzle.name,
            pieceCount: puzzle.pieceCount,
            thumbnailUrl: `/api/puzzles/${puzzle.id}/thumbnail`
          });
        }
      }
    }

    // Sort by creation date, newest first
    puzzles.sort((a, b) => {
      // We need to fetch full puzzle data for sorting, but for now just return as-is
      return 0;
    });

    return puzzles;
  } catch {
    return [];
  }
}

// Get puzzles sorted by creation date
export async function listPuzzlesSorted(): Promise<PuzzleSummary[]> {
  try {
    const entries = await readdir(PUZZLES_DIR, { withFileTypes: true });
    const puzzlesWithDate: Array<{ summary: PuzzleSummary; createdAt: string }> = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const puzzle = await getPuzzle(entry.name);
        if (puzzle) {
          puzzlesWithDate.push({
            summary: {
              id: puzzle.id,
              name: puzzle.name,
              pieceCount: puzzle.pieceCount,
              thumbnailUrl: `/api/puzzles/${puzzle.id}/thumbnail`
            },
            createdAt: puzzle.createdAt
          });
        }
      }
    }

    // Sort by creation date, newest first
    puzzlesWithDate.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return puzzlesWithDate.map((p) => p.summary);
  } catch {
    return [];
  }
}
