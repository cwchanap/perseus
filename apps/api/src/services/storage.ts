// Storage service for puzzle CRUD operations
// Uses JSON files for metadata and filesystem for images

import { mkdir, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { Puzzle, PuzzleSummary } from '../types/index';

const DATA_DIR = process.env.DATA_DIR || './data';
const PUZZLES_DIR = join(DATA_DIR, 'puzzles');
const PUZZLES_DIR_RESOLVED = resolve(PUZZLES_DIR);

function isValidPuzzleId(puzzleId: string): boolean {
  if (puzzleId.length === 0 || puzzleId.length > 128) {
    return false;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(puzzleId)) {
    return false;
  }

  return true;
}

function resolvePuzzlePath(puzzleId: string, ...segments: string[]): string {
  if (!isValidPuzzleId(puzzleId)) {
    throw new Error('Invalid puzzleId');
  }

  const fullPath = resolve(PUZZLES_DIR, puzzleId, ...segments);
  const rel = relative(PUZZLES_DIR_RESOLVED, fullPath);

  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Invalid puzzleId');
  }

  return fullPath;
}

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
  return resolvePuzzlePath(puzzleId);
}

// Get puzzle pieces directory path
export function getPiecesDir(puzzleId: string): string {
  return resolvePuzzlePath(puzzleId, 'pieces');
}

// Get metadata file path
function getMetadataPath(puzzleId: string): string {
  return resolvePuzzlePath(puzzleId, 'metadata.json');
}

// Get original image path
export function getOriginalImagePath(puzzleId: string): string {
  return resolvePuzzlePath(puzzleId, 'original.jpg');
}

// Get thumbnail path
export function getThumbnailPath(puzzleId: string): string {
  return resolvePuzzlePath(puzzleId, 'thumbnail.jpg');
}

// Get piece image path
export function getPieceImagePath(puzzleId: string, pieceId: number): string {
  return resolvePuzzlePath(puzzleId, 'pieces', `${pieceId}.png`);
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
export async function createPuzzle(puzzle: Puzzle): Promise<boolean> {
  let puzzleDir: string;
  let piecesDir: string;
  let metadataPath: string;

  try {
    puzzleDir = getPuzzleDir(puzzle.id);
    piecesDir = getPiecesDir(puzzle.id);
    metadataPath = getMetadataPath(puzzle.id);
  } catch (error) {
    console.error(`Refusing to create puzzle ${puzzle.id}: invalid puzzle id`);
    console.error(error);
    return false;
  }

  try {
    await access(metadataPath);
    console.error(`Refusing to create puzzle ${puzzle.id}: metadata already exists`);
    return false;
  } catch {
    // continue
  }

  try {
    await mkdir(puzzleDir, { recursive: true });
    await mkdir(piecesDir, { recursive: true });

    await writeFile(metadataPath, JSON.stringify(puzzle, null, 2), {
      encoding: 'utf-8',
      flag: 'wx'
    });
    return true;
  } catch (error) {
    console.error(`Failed to create puzzle ${puzzle.id}`);
    console.error(error);
    return false;
  }
}

// Get a puzzle by ID
export async function getPuzzle(puzzleId: string): Promise<Puzzle | null> {
  try {
    const data = await readFile(getMetadataPath(puzzleId), 'utf-8');
    const parsed = JSON.parse(data) as Puzzle;
    const createdAt =
      typeof parsed.createdAt === 'number' ? parsed.createdAt : new Date(parsed.createdAt).getTime();
    return { ...parsed, createdAt };
  } catch {
    return null;
  }
}

// Update puzzle metadata
export async function updatePuzzle(puzzle: Puzzle): Promise<boolean> {
  let metadataPath: string;

  try {
    metadataPath = getMetadataPath(puzzle.id);
  } catch (error) {
    console.error(`Failed to update puzzle metadata for ${puzzle.id}: invalid puzzle id`);
    console.error(error);
    return false;
  }

  try {
    await access(metadataPath);
  } catch {
    return false;
  }

  try {
    await writeFile(metadataPath, JSON.stringify(puzzle, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error(`Failed to update puzzle metadata for ${puzzle.id}`);
    console.error(error);
    return false;
  }
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

async function listPuzzlesWithDate(): Promise<Array<{ summary: PuzzleSummary; createdAt: number }>> {
  const entries = await readdir(PUZZLES_DIR, { withFileTypes: true });
  const puzzlesWithDate: Array<{ summary: PuzzleSummary; createdAt: number }> = [];

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

  return puzzlesWithDate;
}

// List all puzzles
export async function listPuzzles(): Promise<PuzzleSummary[]> {
  try {
    const puzzlesWithDate = await listPuzzlesWithDate();
    return puzzlesWithDate.map((p) => p.summary);
  } catch {
    return [];
  }
}

// Get puzzles sorted by creation date
export async function listPuzzlesSorted(): Promise<PuzzleSummary[]> {
  try {
    const puzzlesWithDate = await listPuzzlesWithDate();

    // Sort by creation date, newest first
    puzzlesWithDate.sort((a, b) => b.createdAt - a.createdAt);

    return puzzlesWithDate.map((p) => p.summary);
  } catch {
    return [];
  }
}
