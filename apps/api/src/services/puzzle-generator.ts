// Puzzle generator service using Sharp for image processing
import sharp from 'sharp';
import { mkdir } from 'fs/promises';
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
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new Error('Invalid image metadata: missing width or height');
  }
  const imageWidth = metadata.width;
  const imageHeight = metadata.height;

  // Generate thumbnail
  const thumbnailPath = path.join(puzzleDir, 'thumbnail.jpg');
  await image
    .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toFile(thumbnailPath);

  // Calculate grid dimensions
  const { rows, cols } = getGridDimensions(pieceCount);
  const basePieceWidth = Math.floor(imageWidth / cols);
  const extraWidth = imageWidth % cols;
  const basePieceHeight = Math.floor(imageHeight / rows);
  const extraHeight = imageHeight % rows;

  // Generate pieces
  const pieces: PuzzlePiece[] = [];
  const piecePaths: string[] = [];

  const bottomEdgesForAbove: Array<'flat' | 'tab' | 'blank'> = new Array(cols).fill('flat');
  const opposite = (edge: 'flat' | 'tab' | 'blank'): 'flat' | 'tab' | 'blank' =>
    edge === 'tab' ? 'blank' : edge === 'blank' ? 'tab' : 'flat';

  for (let row = 0; row < rows; row++) {
    let leftEdgeForNext = 'flat' as 'flat' | 'tab' | 'blank';
    for (let col = 0; col < cols; col++) {
      const pieceId = row * cols + col;
      const piecePath = path.join(piecesDir, `${pieceId}.png`);

      // Extract piece from image
      const left = col * basePieceWidth;
      const top = row * basePieceHeight;
      const width = basePieceWidth + (col === cols - 1 ? extraWidth : 0);
      const height = basePieceHeight + (row === rows - 1 ? extraHeight : 0);
      await sharp(imageBuffer)
        .extract({
          left,
          top,
          width,
          height
        })
        .png()
        .toFile(piecePath);

      // Determine edge types with matched neighbors
      const topEdge = row === 0 ? 'flat' : opposite(bottomEdgesForAbove[col]);
      const rightEdge = col === cols - 1 ? 'flat' : ((row + col) % 2 === 0 ? 'tab' : 'blank');
      const bottomEdge = row === rows - 1 ? 'flat' : ((row + col) % 2 === 0 ? 'blank' : 'tab');
      const leftEdge = col === 0 ? 'flat' : opposite(leftEdgeForNext);

      bottomEdgesForAbove[col] = bottomEdge;
      leftEdgeForNext = rightEdge;

      const edges = {
        top: topEdge,
        right: rightEdge,
        bottom: bottomEdge,
        left: leftEdge
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

  // Construct puzzle metadata
  const puzzle: Puzzle = {
    id: id,
    name,
    pieceCount,
    gridCols: cols,
    gridRows: rows,
    imageWidth,
    imageHeight,
    pieces,
    createdAt: Date.now()
  };

  return {
    puzzle,
    thumbnailPath,
    piecePaths
  };
}

export { ALLOWED_PIECE_COUNTS, isValidPieceCount };
