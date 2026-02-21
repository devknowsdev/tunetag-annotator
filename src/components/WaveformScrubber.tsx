// WaveformScrubber — fetches Spotify audio analysis, renders a waveform canvas
// with a playhead and click-to-seek support.
import { useEffect, useRef, useState, useCallback } from 'react';

interface Props {
  spotifyTrackId: string | null;
  spotifyToken: string | null;
  elapsedSeconds: number;
  durationSeconds: number;
  onSeek?: (seconds: number) => void; // called when user clicks the scrubber
}

export function WaveformScrubber({
  spotifyTrackId,
  spotifyToken,
  elapsedSeconds,
  durationSeconds,
  onSeek,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loudness, setLoudness] = useState<number[] | null>(null);

  // ── Fetch audio analysis from Spotify ──────────────────────────────────────
  useEffect(() => {
    if (!spotifyTrackId || !spotifyToken) return;
    let cancelled = false;

    fetch(`https://api.spotify.com/v1/audio-analysis/${spotifyTrackId}`, {
      headers: { Authorization: `Bearer ${spotifyToken}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        // Use segment loudness_max to build amplitude array
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const segments: any[] = data.segments ?? [];
        if (segments.length === 0) return;

        // Normalise to 0–1 range
        const raw = segments.map((s) => s.loudness_max as number);
        const min = Math.min(...raw);
        const max = Math.max(...raw);
        const range = max - min || 1;
        const normalised = raw.map((v) => (v - min) / range);
        setLoudness(normalised);
      })
      .catch(() => {/* fail silently — no waveform shown */});

    return () => { cancelled = true; };
  }, [spotifyTrackId, spotifyToken]);

  // ── Draw waveform + playhead ────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const progress = durationSeconds > 0 ? Math.min(1, elapsedSeconds / durationSeconds) : 0;
    const playheadX = Math.floor(progress * W);

    if (loudness && loudness.length > 0) {
      // Draw bars
      const barW = W / loudness.length;
      for (let i = 0; i < loudness.length; i++) {
        const x = i * barW;
        const barH = Math.max(2, loudness[i] * H * 0.85);
        const y = (H - barH) / 2;
        // Played portion: amber; unplayed: dim
        ctx.fillStyle = x < playheadX
          ? 'rgba(255,176,0,0.9)'   // var(--amber)
          : 'rgba(255,255,255,0.18)';
        ctx.fillRect(x + 0.5, y, Math.max(1, barW - 1), barH);
      }
    } else {
      // Fallback flat bar if no analysis data yet
      const midY = H / 2;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(0, midY - 1, W, 2);
      ctx.fillStyle = 'rgba(255,176,0,0.7)';
      ctx.fillRect(0, midY - 1, playheadX, 2);
    }

    // Playhead line
    ctx.fillStyle = 'rgba(255,176,0,1)';
    ctx.fillRect(playheadX - 1, 0, 2, H);
  }, [loudness, elapsedSeconds, durationSeconds]);

  useEffect(() => { draw(); }, [draw]);

  // ── Click-to-seek ──────────────────────────────────────────────────────────
  function handleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!onSeek || durationSeconds <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const fraction = (e.clientX - rect.left) / rect.width;
    onSeek(Math.max(0, fraction * durationSeconds));
  }

  return (
    <canvas
      ref={canvasRef}
      width={800}
      height={48}
      onClick={handleClick}
      style={{
        width: '100%',
        height: '48px',
        display: 'block',
        cursor: onSeek ? 'pointer' : 'default',
        flexShrink: 0,
      }}
    />
  );
}
