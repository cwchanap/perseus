// Puzzle generator service using Sharp for image processing
import sharp from 'sharp';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import type { Puzzle, PuzzlePiece, AllowedPieceCount } from '../types';

const THUMBNAIL_SIZE = 300;
const ALLOWED_PIECE_COUNTS: AllowedPieceCount[] = [9, 16, 25, 36, 49, 64, 100];

interface GridDimensions {
  rows: number;
  cols: number;
}

function getGridDimensions(pieceCount: AllowedPieceCount): GridDimensions {
  const sqrt = Math.sqrt(pieceCount);
  return { rows: sqrt, cols: sqrt };
}

function isValidPieceCount(count: number): count is AllowedPieceCount {
  return ALLOWED_PIECE_COUNTS.includes(count as AllowedPieceCount);
}

export interface GeneratePuzzleOptions {
  id: string;
  name: string;
  pieceCount: number;
  imageBuffer: Buffer;
  outputDir: string;
}

export interface GeneratePuzzleResult {
  puzzle: Puzzle;
  thumbnailPath: string;
  piecePaths: string[];
}

export async function generatePuzzle(
  options: GeneratePuzzleOptions
): Promise<GeneratePuzzleResult> {
  const { id, name, pieceCount, imageBuffer, outputDir } = options;

  if (!isValidPieceCount(pieceCount)) {
    throw new Error(`Invalid piece count: ${pieceCount}. Allowed values: ${ALLOWED_PIECE_COUNTS.join(', ')}`);
  }

  // Create output directories
  const puzzleDir = path.join(outputDir, id);
  const piecesDir = path.join(puzzleDir, 'pieces');
  await mkdir(piecesDir, { recursive: true });

  // Get image metadata
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const imageWidth = metadata.width || 800;
  const imageHeight = metadata.height || 600;

  // Generate thumbnail
  const thumbnailPath = path.join(puzzleDir, 'thumbnail.jpg');
  await image
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toFile(thumbnailPath);

  // Calculate grid dimensions
  const { rows, cols } = getGridDimensions(pieceCount);
  const pieceWidth = Math.floor(imageWidth / cols);
  const pieceHeight = Math.floor(imageHeight / rows);

  // Generate pieces
  const pieces: PuzzlePiece[] = [];
  const piecePaths: string[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const pieceId = row * cols + col;
      const piecePath = path.join(piecesDir, `${pieceId}.png`);

      // Extract piece from image
      await sharp(imageBuffer)
        .extract({
          left: col * pieceWidth,
          top: row * pieceHeight,
          width: pieceWidth,
          height: pieceHeight
        })
        .png()
        .toFile(piecePath);

      // Determine edge types based on position
      const edges = {
        top: row === 0 ? 'flat' : (pieceId % 2 === 0 ? 'tab' : 'blank'),
        right: col === cols - 1 ? 'flat' : (pieceId % 2 === 0 ? 'blank' : 'tab'),
        bottom: row === rows - 1 ? 'flat' : (pieceId % 2 === 0 ? 'blank' : 'tab'),
        left: col === 0 ? 'flat' : (pieceId % 2 === 0 ? 'tab' : 'blank')
      } as const;

      pieces.push({
        id: pieceId,
        puzzleId: id,
        correctX: col,
        correctY: row,
        edges,
        imagePath: `pieces/${pieceId}.png`
      });

      piecePaths.push(piecePath);
    }
  }

  const puzzle: Puzzle = {
    id,
    name,
    pieceCount,
    gridRows: rows,
    gridCols: cols,
    imageWidth,
    imageHeight,
    pieces,
    createdAt: new Date().toISOString()
  };

  return {
    puzzle,
    thumbnailPath,
    piecePaths
  };
}

export { ALLOWED_PIECE_COUNTS, isValidPieceCount };
