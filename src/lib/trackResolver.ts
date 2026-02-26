import type { Track } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ResolvedTrack {
  spotifyId: string;
  artist: string;
  name: string;
  thumbnailUrl: string;
}

interface OEmbedResponse {
  type: string;
  version: string;
  title: string;
  author_name: string;
  thumbnail_url: string;
  html: string;
  width: number;
  height: number;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

export const STORAGE_KEY = 'beatpulse_custom_tracks';

export function saveCustomTracks(tracks: Track[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tracks));
}

export function loadCustomTracks(): Track[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Track[];
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Resolution ───────────────────────────────────────────────────────────────

/**
 * Resolves a Spotify track ID via the public oEmbed endpoint (no auth required).
 * Returns artist, track name and thumbnail URL.
 */
export async function resolveSpotifyTrack(spotifyId: string): Promise<ResolvedTrack> {
  const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(
    `https://open.spotify.com/track/${spotifyId}`
  )}`;
  const response = await fetch(oembedUrl);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data: OEmbedResponse = await response.json();
  return {
    spotifyId,
    artist: data.author_name,
    name: data.title,
    thumbnailUrl: data.thumbnail_url,
  };
}

// ─── Input parsing ────────────────────────────────────────────────────────────

/**
 * Accepts a block of text containing any mix of:
 *   - Full URLs:  https://open.spotify.com/track/ABC123?si=...
 *   - Spotify URIs: spotify:track:ABC123
 *   - Bare IDs:   ABC123
 *   - One per line or comma separated
 *
 * Returns a deduplicated array of clean Spotify track IDs.
 */
export function parseSpotifyInput(raw: string): string[] {
  const parts = raw.split(/[\n,]+/);
  const seen = new Set<string>();
  const ids: string[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // Full URL: https://open.spotify.com/track/ABC123
    const urlMatch = trimmed.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/);
    if (urlMatch) {
      const id = urlMatch[1];
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
      continue;
    }

    // Spotify URI: spotify:track:ABC123
    const uriMatch = trimmed.match(/^spotify:track:([A-Za-z0-9]+)$/);
    if (uriMatch) {
      const id = uriMatch[1];
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
      continue;
    }

    // Bare ID: alphanumeric, 10–30 chars (Spotify IDs are 22 chars)
    if (/^[A-Za-z0-9]{10,30}$/.test(trimmed)) {
      if (!seen.has(trimmed)) { seen.add(trimmed); ids.push(trimmed); }
    }
  }

  return ids;
}
