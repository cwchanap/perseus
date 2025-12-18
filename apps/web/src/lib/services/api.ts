// API client service for Jigsaw Puzzle Web App
import type {
  Puzzle,
  PuzzleSummary,
  PuzzleListResponse,
  LoginResponse,
  SessionResponse,
  ErrorResponse
} from '$lib/types/puzzle';

const API_BASE = 'http://localhost:3000';

class ApiError extends Error {
  constructor(
    public status: number,
    public error: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorData = (await response.json().catch(() => ({}))) as ErrorResponse;
    throw new ApiError(
      response.status,
      errorData.error || 'Unknown error',
      errorData.message || response.statusText
    );
  }
  return response.json() as Promise<T>;
}

// Puzzle endpoints
export async function fetchPuzzles(): Promise<PuzzleSummary[]> {
  const response = await fetch(`${API_BASE}/api/puzzles`);
  const data = await handleResponse<PuzzleListResponse>(response);
  return data.puzzles;
}

export async function fetchPuzzle(id: string): Promise<Puzzle> {
  const response = await fetch(`${API_BASE}/api/puzzles/${id}`);
  return handleResponse<Puzzle>(response);
}

export function getThumbnailUrl(puzzleId: string): string {
  return `${API_BASE}/api/puzzles/${puzzleId}/thumbnail`;
}

export function getPieceImageUrl(puzzleId: string, pieceId: number): string {
  return `${API_BASE}/api/puzzles/${puzzleId}/pieces/${pieceId}/image`;
}

// Admin auth endpoints
export async function login(passkey: string): Promise<LoginResponse> {
  const response = await fetch(`${API_BASE}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ passkey })
  });
  return handleResponse<LoginResponse>(response);
}

export async function logout(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/api/admin/logout`, {
      method: 'POST',
      credentials: 'include'
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      const message = `Logout failed (${response.status} ${response.statusText})${
        responseText ? `: ${responseText}` : ''
      }`;
      throw new Error(message);
    }
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error('Logout failed');
  }
}

export async function checkSession(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/admin/session`, {
      credentials: 'include'
    });
    if (!response.ok) return false;
    const data = await handleResponse<SessionResponse>(response);
    return data.authenticated;
  } catch {
    return false;
  }
}

// Admin puzzle management
export async function createPuzzle(
  name: string,
  pieceCount: number,
  image: File
): Promise<Puzzle> {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('pieceCount', pieceCount.toString());
  formData.append('image', image);

  const response = await fetch(`${API_BASE}/api/admin/puzzles`, {
    method: 'POST',
    credentials: 'include',
    body: formData
  });
  return handleResponse<Puzzle>(response);
}

export async function deletePuzzle(id: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/admin/puzzles/${id}`, {
    method: 'DELETE',
    credentials: 'include'
  });
  if (!response.ok && response.status !== 204) {
    const errorData = (await response.json().catch(() => ({}))) as ErrorResponse;
    throw new ApiError(
      response.status,
      errorData.error || 'Unknown error',
      errorData.message || response.statusText
    );
  }
}

export { ApiError };
