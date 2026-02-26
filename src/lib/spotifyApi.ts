// Simple fetch wrappers for the Spotify Web API.
// No React dependency — called from components or hooks directly.

const API_BASE = 'https://api.spotify.com/v1';

export async function transferPlayback(
  deviceId: string,
  token: string
): Promise<void> {
  const response = await fetch(`${API_BASE}/me/player`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ device_ids: [deviceId], play: false }),
  });

  // Spotify returns 204 No Content on success
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`transferPlayback failed: ${response.status} ${text}`);
  }
}

export async function playTrack(
  spotifyId: string,
  deviceId: string,
  token: string,
  opts?: { positionMs?: number }
): Promise<void> {
  const body: Record<string, unknown> = {
    uris: [`spotify:track:${spotifyId}`],
  };
  if (opts?.positionMs !== undefined) {
    body.position_ms = Math.max(0, Math.floor(opts.positionMs));
  }

  const response = await fetch(
    `${API_BASE}/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`playTrack failed: ${response.status} ${text}`);
  }
}

export async function pausePlayback(
  deviceId: string,
  token: string
): Promise<void> {
  const response = await fetch(
    `${API_BASE}/me/player/pause?device_id=${encodeURIComponent(deviceId)}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  // 204 = success, 403 = already paused — both are acceptable
  if (!response.ok && response.status !== 403) {
    const text = await response.text().catch(() => '');
    throw new Error(`pausePlayback failed: ${response.status} ${text}`);
  }
}

export async function seekPlayback(
  deviceId: string,
  token: string,
  positionMs: number
): Promise<void> {
  const safeMs = Math.max(0, Math.floor(positionMs));
  const response = await fetch(
    `${API_BASE}/me/player/seek?position_ms=${safeMs}&device_id=${encodeURIComponent(deviceId)}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`seekPlayback failed: ${response.status} ${text}`);
  }
}
