import { useState, useEffect, useCallback } from 'react';
import {
  parseSpotifyInput,
  resolveSpotifyTrack,
  saveCustomTracks,
  loadCustomTracks,
  STORAGE_KEY,
} from '../lib/trackResolver';
import type { ResolvedTrack } from '../lib/trackResolver';
import type { Track } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

type ResolveStatus = 'pending' | 'loading' | 'success' | 'error';

interface ResolveItem {
  spotifyId: string;
  status: ResolveStatus;
  resolved?: ResolvedTrack;
  error?: string;
}

interface Props {
  onClose: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function TrackManager({ onClose }: Props) {
  const [input, setInput] = useState('');
  const [resolveItems, setResolveItems] = useState<ResolveItem[]>([]);
  const [isResolving, setIsResolving] = useState(false);
  const [resolveProgress, setResolveProgress] = useState(0);

  // Section B: working track list (pre-populated from localStorage)
  const [trackList, setTrackList] = useState<ResolvedTrack[]>(() => {
    const saved = loadCustomTracks();
    if (saved && saved.length > 0) {
      return saved.map((t) => ({
        spotifyId: t.spotifyId,
        artist: t.artist,
        name: t.name,
        thumbnailUrl: '',
      }));
    }
    return [];
  });

  // Close on Escape
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); },
    [onClose]
  );
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // ── Section A: resolve ──────────────────────────────────────────────────

  async function handleResolve() {
    const ids = parseSpotifyInput(input);
    if (ids.length === 0) return;

    setIsResolving(true);
    setResolveProgress(0);

    const items: ResolveItem[] = ids.map((id) => ({ spotifyId: id, status: 'pending' as const }));
    setResolveItems(items);

    for (let i = 0; i < ids.length; i++) {
      // Mark current as loading
      setResolveItems((prev) =>
        prev.map((item, idx) => idx === i ? { ...item, status: 'loading' } : item)
      );

      try {
        const resolved = await resolveSpotifyTrack(ids[i]);
        setResolveItems((prev) =>
          prev.map((item, idx) => idx === i ? { ...item, status: 'success', resolved } : item)
        );
        // Append to working track list (deduplicated by spotifyId)
        setTrackList((prev) => {
          if (prev.some((t) => t.spotifyId === resolved.spotifyId)) return prev;
          return [...prev, resolved];
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setResolveItems((prev) =>
          prev.map((item, idx) => idx === i ? { ...item, status: 'error', error: msg } : item)
        );
      }

      setResolveProgress((i + 1) / ids.length);

      if (i < ids.length - 1) {
        await new Promise<void>((res) => setTimeout(res, 200));
      }
    }

    setIsResolving(false);
  }

  // ── Section B: reorder / remove ─────────────────────────────────────────

  function moveUp(i: number) {
    if (i === 0) return;
    setTrackList((prev) => {
      const next = [...prev];
      [next[i - 1], next[i]] = [next[i], next[i - 1]];
      return next;
    });
  }

  function moveDown(i: number) {
    setTrackList((prev) => {
      if (i >= prev.length - 1) return prev;
      const next = [...prev];
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
      return next;
    });
  }

  function removeTrack(i: number) {
    setTrackList((prev) => prev.filter((_, idx) => idx !== i));
  }

  // ── USE THESE TRACKS ────────────────────────────────────────────────────

  function handleUseTheseTracks() {
    if (trackList.length === 0) return;
    const tracks: Track[] = trackList.map((t, i) => ({
      id: i + 1,
      artist: t.artist,
      name: t.name,
      spotifyId: t.spotifyId,
      spotifyUrl: `https://open.spotify.com/track/${t.spotifyId}`,
      sheetName: `Track ${i + 1}`,
      audioLabel: `${t.artist} - ${t.name} https://open.spotify.com/track/${t.spotifyId}`,
    }));
    saveCustomTracks(tracks);
    // Clear annotation session state so the new track set initialises cleanly
    localStorage.removeItem('tunetag_v1');
    window.location.reload();
  }

  // ── RESTORE DEFAULTS ────────────────────────────────────────────────────

  function handleRestoreDefaults() {
    if (
      !window.confirm(
        'This will clear your custom track list and restore the default tracks.\n\nAll annotation progress for custom tracks will be lost. Continue?'
      )
    ) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem('tunetag_v1');
    window.location.reload();
  }

  // ── Derived ─────────────────────────────────────────────────────────────

  const resolvedCount = resolveItems.filter((i) => i.status === 'success').length;
  const errorCount    = resolveItems.filter((i) => i.status === 'error').length;
  const hasResults    = resolveItems.length > 0;
  const progressPct   = Math.round(resolveProgress * 100);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.panel} onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <button style={styles.closeBtn} onClick={onClose} aria-label="Close Track Manager">✕</button>
        <p style={styles.title}>TRACK MANAGER</p>
        <p style={styles.subtitle}>
          Track data resolves via Spotify's public API.&nbsp; No login required.
        </p>

        {/* ── SECTION A — Paste tracks ───────────────────────────────────── */}
        <div style={styles.section}>
          <p style={styles.sectionLabel}>PASTE TRACKS</p>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={'Paste Spotify URLs or track IDs, one per line\n\nhttps://open.spotify.com/track/6N4ioa3XSbvjmwdVEERl8F\n6N4ioa3XSbvjmwdVEERl8F'}
            disabled={isResolving}
            style={styles.textarea}
          />

          <button
            className="btn-primary"
            onClick={handleResolve}
            disabled={isResolving || !input.trim()}
            style={{ marginTop: '0.625rem', width: '100%' }}
          >
            {isResolving ? `RESOLVING… ${progressPct}%` : 'RESOLVE'}
          </button>

          {/* Progress bar */}
          {isResolving && (
            <div style={styles.progressTrack}>
              <div style={{ ...styles.progressBar, width: `${progressPct}%` }} />
            </div>
          )}

          {/* Resolve result items */}
          {hasResults && (
            <div style={styles.resolveList}>
              {hasResults && !isResolving && (
                <p style={styles.resolveStats}>
                  {resolvedCount} resolved
                  {errorCount > 0 && <span style={{ color: 'var(--error)' }}> · {errorCount} failed</span>}
                </p>
              )}
              {resolveItems.map((item) => (
                <div key={item.spotifyId} style={styles.resolveItem}>
                  {item.status === 'loading' && (
                    <span style={styles.resolveLoading}>⟳ {item.spotifyId}</span>
                  )}
                  {item.status === 'pending' && (
                    <span style={styles.resolvePending}>· · {item.spotifyId}</span>
                  )}
                  {item.status === 'success' && item.resolved && (
                    <div style={styles.resolveSuccess}>
                      {item.resolved.thumbnailUrl ? (
                        <img
                          src={item.resolved.thumbnailUrl}
                          alt=""
                          style={styles.thumb}
                        />
                      ) : (
                        <div style={styles.thumbPlaceholder}>♪</div>
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={styles.resolveArtist}>{item.resolved.artist}</span>
                        <span style={styles.resolveName}> — {item.resolved.name}</span>
                      </div>
                      <a
                        href={`https://open.spotify.com/track/${item.spotifyId}`}
                        target="_blank"
                        rel="noreferrer"
                        style={styles.externalLink}
                        onClick={(e) => e.stopPropagation()}
                      >↗</a>
                    </div>
                  )}
                  {item.status === 'error' && (
                    <div style={styles.resolveError}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem' }}>
                        {item.spotifyId}
                      </span>
                      <span style={styles.errorMsg}> — {item.error ?? 'Failed to resolve'}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── SECTION B — Working track list ─────────────────────────────── */}
        <div style={styles.section}>
          <p style={styles.sectionLabel}>TRACK LIST</p>

          {trackList.length === 0 ? (
            <p style={styles.emptyNote}>
              No tracks yet. Resolve tracks above to build your list.
            </p>
          ) : (
            <div style={styles.trackList}>
              {trackList.map((t, i) => (
                <div key={t.spotifyId} style={styles.trackItem}>
                  {/* Thumbnail */}
                  {t.thumbnailUrl ? (
                    <img src={t.thumbnailUrl} alt="" style={styles.thumb} />
                  ) : (
                    <div style={styles.thumbPlaceholder}>♪</div>
                  )}

                  {/* Number + info */}
                  <span style={styles.trackNum}>{i + 1}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={styles.trackArtist}>{t.artist}</span>
                    <span style={styles.trackName}> — {t.name}</span>
                  </div>

                  {/* Actions */}
                  <div style={styles.trackActions}>
                    <a
                      href={`https://open.spotify.com/track/${t.spotifyId}`}
                      target="_blank"
                      rel="noreferrer"
                      style={styles.externalLink}
                      onClick={(e) => e.stopPropagation()}
                      title="Open in Spotify"
                    >↗</a>
                    <button
                      style={styles.iconBtn}
                      onClick={() => moveUp(i)}
                      disabled={i === 0}
                      title="Move up"
                      aria-label="Move up"
                    >↑</button>
                    <button
                      style={styles.iconBtn}
                      onClick={() => moveDown(i)}
                      disabled={i === trackList.length - 1}
                      title="Move down"
                      aria-label="Move down"
                    >↓</button>
                    <button
                      style={{ ...styles.iconBtn, color: 'var(--error)' }}
                      onClick={() => removeTrack(i)}
                      title="Remove"
                      aria-label="Remove track"
                    >×</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <button
            className="btn-primary"
            onClick={handleUseTheseTracks}
            disabled={trackList.length === 0}
            style={{ marginTop: '1rem', width: '100%' }}
          >
            USE THESE TRACKS ({trackList.length})
          </button>
        </div>

        {/* ── SECTION C — Reset ──────────────────────────────────────────── */}
        <div style={{ ...styles.section, borderBottom: 'none', paddingBottom: 0 }}>
          <p style={styles.sectionLabel}>RESET</p>
          <button
            className="btn-ghost btn-small"
            onClick={handleRestoreDefaults}
            style={styles.restoreBtn}
          >
            RESTORE DEFAULT TRACKS
          </button>
        </div>

      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 190,
    background: 'rgba(0,0,0,0.75)',
    backdropFilter: 'blur(3px)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    overflowY: 'auto' as const,
    padding: '2rem 1rem 3rem',
  },
  panel: {
    position: 'relative' as const,
    width: '100%',
    maxWidth: '640px',
    background: 'var(--surface)',
    border: '1px solid var(--border-active)',
    borderRadius: 'var(--radius)',
    padding: '2rem',
  },
  closeBtn: {
    position: 'absolute' as const,
    top: '1rem',
    right: '1rem',
    background: 'transparent',
    border: '1px solid var(--border-active)',
    borderRadius: '4px',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.75rem',
    width: '28px',
    height: '28px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    lineHeight: 1,
  },
  title: {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.8125rem',
    color: 'var(--amber)',
    letterSpacing: '0.12em',
    margin: '0 0 0.375rem',
    paddingRight: '2rem',
  },
  subtitle: {
    fontFamily: 'var(--font-serif)',
    fontSize: '0.8rem',
    color: 'var(--text-dim)',
    margin: '0 0 1.5rem',
  },
  section: {
    borderBottom: '1px solid var(--border)',
    paddingBottom: '1.5rem',
    marginBottom: '1.5rem',
  },
  sectionLabel: {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.7rem',
    letterSpacing: '0.1em',
    color: 'var(--text-dim)',
    margin: '0 0 0.75rem',
  },
  textarea: {
    width: '100%',
    minHeight: '120px',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.8rem',
    color: 'var(--text)',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: '0.625rem 0.75rem',
    resize: 'vertical' as const,
    outline: 'none',
    boxSizing: 'border-box' as const,
    lineHeight: 1.6,
  },
  progressTrack: {
    height: '3px',
    background: 'var(--border)',
    borderRadius: '2px',
    marginTop: '0.5rem',
    overflow: 'hidden',
  },
  progressBar: {
    height: '100%',
    background: 'var(--amber)',
    borderRadius: '2px',
    transition: 'width 150ms ease',
  },
  resolveList: {
    marginTop: '0.875rem',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.375rem',
  },
  resolveStats: {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.72rem',
    color: 'var(--text-dim)',
    margin: '0 0 0.375rem',
    letterSpacing: '0.04em',
  },
  resolveItem: {
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: '0.4rem 0.6rem',
  },
  resolveLoading: {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.75rem',
    color: 'var(--text-dim)',
    fontStyle: 'italic' as const,
  },
  resolvePending: {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.75rem',
    color: 'var(--border-active)',
  },
  resolveSuccess: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  resolveError: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.375rem',
    flexWrap: 'wrap' as const,
  },
  errorMsg: {
    fontFamily: 'var(--font-serif)',
    fontSize: '0.78rem',
    color: 'var(--error)',
  },
  resolveArtist: {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.78rem',
    color: 'var(--text-muted)',
    fontWeight: 600,
  },
  resolveName: {
    fontFamily: 'var(--font-serif)',
    fontSize: '0.85rem',
    color: 'var(--text)',
  },
  thumb: {
    width: '48px',
    height: '48px',
    borderRadius: 'var(--radius)',
    objectFit: 'cover' as const,
    flexShrink: 0,
  },
  thumbPlaceholder: {
    width: '48px',
    height: '48px',
    borderRadius: 'var(--radius)',
    background: 'var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '1.25rem',
    color: 'var(--text-dim)',
    flexShrink: 0,
  },
  externalLink: {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.8rem',
    color: 'var(--amber)',
    textDecoration: 'none',
    padding: '0.2rem 0.3rem',
    borderRadius: '3px',
    flexShrink: 0,
  },
  trackList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.375rem',
  },
  trackItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    padding: '0.4rem 0.6rem',
  },
  trackNum: {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.72rem',
    color: 'var(--amber)',
    minWidth: '1.25rem',
    textAlign: 'center' as const,
    flexShrink: 0,
  },
  trackArtist: {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.78rem',
    color: 'var(--text-muted)',
    fontWeight: 600,
  },
  trackName: {
    fontFamily: 'var(--font-serif)',
    fontSize: '0.85rem',
    color: 'var(--text)',
  },
  trackActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
    flexShrink: 0,
  },
  iconBtn: {
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: '4px',
    color: 'var(--text-dim)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.8rem',
    width: '24px',
    height: '24px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    lineHeight: 1,
    padding: 0,
  },
  emptyNote: {
    fontFamily: 'var(--font-serif)',
    fontSize: '0.85rem',
    color: 'var(--text-dim)',
    fontStyle: 'italic' as const,
    margin: '0 0 0.5rem',
  },
  restoreBtn: {
    color: 'var(--error)',
    borderColor: 'var(--error)',
    opacity: 0.8,
  },
};
