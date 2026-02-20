// Fixed bottom player bar for the Spotify Web Playback SDK.
// z-index 150 — above all phase content, below HowToUse modal (200).
// All colours and fonts use existing CSS variables.

import { useMemo, useRef } from 'react';
import type { UseSpotifyPlayerReturn } from '../hooks/useSpotifyPlayer';

interface SpotifyPlayerProps {
  player: UseSpotifyPlayerReturn;
  spotifyId?: string | null;
}

/** Format milliseconds → m:ss */
function fmtMs(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Seeded pseudo-random number generator (mulberry32) */
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Turn a string into a numeric seed */
function strToSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

/** Generate BAR_COUNT waveform bar heights (0–1) seeded from a string */
const BAR_COUNT = 80;
function generateWaveform(seed: string): number[] {
  const rng = mulberry32(strToSeed(seed));
  // Create a smooth envelope — quiet start/end, louder middle
  return Array.from({ length: BAR_COUNT }, (_, i) => {
    const envelope = Math.sin((Math.PI * i) / (BAR_COUNT - 1)); // 0→1→0 arc
    const noise = rng();
    return Math.max(0.05, Math.min(1, envelope * 0.6 + noise * 0.55));
  });
}

export function SpotifyPlayer({ player, spotifyId }: SpotifyPlayerProps) {
  const {
    isReady,
    isPlaying,
    position,
    duration,
    volume,
    play,
    pause,
    seek,
    setVolume,
    currentTrackName,
    currentArtistName,
  } = player;

  const progress = duration > 0 ? position / duration : 0;

  // Generate a stable waveform for the current track
  const waveform = useMemo(
    () => generateWaveform(spotifyId ?? currentTrackName ?? 'default'),
    [spotifyId, currentTrackName]
  );

  const scrubberRef = useRef<HTMLDivElement>(null);

  function handleScrubberClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!isReady || duration === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seek(Math.floor(ratio * duration));
  }

  function handleVolumeChange(e: React.ChangeEvent<HTMLInputElement>) {
    setVolume(parseFloat(e.target.value));
  }

  function handlePlayPause() {
    if (isPlaying) pause();
    else play();
  }

  function handleSeekToStart() {
    seek(0);
  }

  return (
    <div style={styles.bar}>
      {/* ── Waveform scrubber ── */}
      <div
        ref={scrubberRef}
        style={styles.waveformTrack}
        onClick={handleScrubberClick}
        role="slider"
        aria-label="Playback position"
        aria-valuenow={Math.round(progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        title={isReady ? `${fmtMs(position)} / ${fmtMs(duration)}` : 'Connecting…'}
      >
        {waveform.map((h, i) => {
          const barProgress = i / BAR_COUNT;
          const played = barProgress < progress;
          const isHead = Math.abs(barProgress - progress) < 1.5 / BAR_COUNT;
          return (
            <div
              key={i}
              style={{
                ...styles.waveBar,
                height: `${h * 100}%`,
                background: played ? 'var(--amber)' : 'var(--border-active)',
                opacity: isHead ? 1 : played ? 0.9 : 0.35,
                transform: isHead ? 'scaleY(1.2)' : 'scaleY(1)',
              }}
            />
          );
        })}
        {/* Playhead line */}
        <div
          style={{
            ...styles.playhead,
            left: `${progress * 100}%`,
          }}
        />
      </div>

      {/* ── Main row ── */}
      <div style={styles.row}>
        {/* Track info */}
        <div style={styles.trackInfo}>
          <span style={styles.trackName}>
            {currentTrackName ?? (isReady ? 'No track playing' : 'Connecting…')}
          </span>
          {currentArtistName && (
            <span style={styles.artistName}>{currentArtistName}</span>
          )}
        </div>

        {/* Controls */}
        <div style={styles.controls}>
          <button
            style={styles.iconBtn}
            onClick={handleSeekToStart}
            disabled={!isReady}
            aria-label="Seek to start"
            title="Seek to start"
          >
            ⏮
          </button>
          <button
            style={{ ...styles.iconBtn, ...styles.playBtn }}
            onClick={handlePlayPause}
            disabled={!isReady}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isPlaying ? '⏸' : '▶'}
          </button>
        </div>

        {/* Time + Volume */}
        <div style={styles.rightSide}>
          <span style={styles.time}>
            {fmtMs(position)}&nbsp;/&nbsp;{fmtMs(duration)}
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={handleVolumeChange}
            disabled={!isReady}
            aria-label="Volume"
            style={styles.volumeSlider}
          />
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 150,
    background: 'var(--surface)',
    borderTop: '1px solid var(--border-active)',
  },
  waveformTrack: {
    width: '100%',
    height: '44px',
    display: 'flex',
    alignItems: 'center',
    gap: '1px',
    padding: '5px 0',
    cursor: 'pointer',
    position: 'relative',
    userSelect: 'none',
    boxSizing: 'border-box',
  },
  waveBar: {
    flex: 1,
    borderRadius: '1px',
    transition: 'background 0.15s, opacity 0.15s, transform 0.1s',
    pointerEvents: 'none',
    minWidth: 0,
  },
  playhead: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '2px',
    background: 'var(--amber)',
    transform: 'translateX(-50%)',
    pointerEvents: 'none',
    borderRadius: '1px',
    boxShadow: '0 0 6px var(--amber-glow)',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0.25rem 1rem 0.5rem',
    gap: '0.75rem',
    maxWidth: '800px',
    margin: '0 auto',
    width: '100%',
    boxSizing: 'border-box',
  },
  trackInfo: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.1rem',
    overflow: 'hidden',
  },
  trackName: {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.75rem',
    color: 'var(--text)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  artistName: {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.6875rem',
    color: 'var(--text-muted)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  controls: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    flexShrink: 0,
  },
  iconBtn: {
    background: 'transparent',
    border: '1px solid var(--border-active)',
    borderRadius: '4px',
    color: 'var(--text-muted)',
    fontSize: '0.875rem',
    width: '28px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    transition: 'color 150ms ease, border-color 150ms ease',
    padding: 0,
  },
  playBtn: {
    color: 'var(--amber)',
    borderColor: 'var(--amber)',
  },
  rightSide: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    flexShrink: 0,
  },
  time: {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.6875rem',
    color: 'var(--text-muted)',
    whiteSpace: 'nowrap',
  },
  volumeSlider: {
    width: '72px',
    accentColor: 'var(--amber)',
    cursor: 'pointer',
  },
};
