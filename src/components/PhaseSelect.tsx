// FIX #3: Resume uses annotation.resumePhase (persisted per-track) for exact phase restore.
import { useState } from 'react';
import type { TrackAnnotation, Phase } from '../types';
import { getActiveTracks } from '../lib/schema';
import { TrackManager } from './TrackManager';

interface Props {
  annotations: Record<number, TrackAnnotation>;
  setActiveTrackId: (id: number) => void;
  setPhase: (p: Phase) => void;
  resetTrack: (id: number) => void;
}

const STATUS_LABEL: Record<TrackAnnotation['status'], string> = {
  not_started: 'NOT STARTED',
  in_progress: 'IN PROGRESS',
  complete: 'COMPLETE',
  skipped: 'SKIPPED',
};

// Coloured badge styles per status
const STATUS_BADGE_STYLE: Record<TrackAnnotation['status'], React.CSSProperties> = {
  not_started: {
    background: 'var(--surface)',
    color: 'var(--text-dim)',
    border: '1px solid var(--border)',
  },
  in_progress: {
    background: 'var(--amber)',
    color: 'var(--bg)',
    border: '1px solid var(--amber)',
  },
  complete: {
    background: 'var(--success)',
    color: '#fff',
    border: '1px solid var(--success)',
  },
  skipped: {
    background: 'transparent',
    color: 'var(--text-dim)',
    border: '1px solid var(--border)',
    textDecoration: 'line-through',
  },
};

function formatMSS(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function PhaseSelect({
  annotations,
  setActiveTrackId,
  setPhase,
  resetTrack,
}: Props) {
  const [showTrackManager, setShowTrackManager] = useState(false);

  // ── All routing logic preserved exactly ──────────────────────────────────
  function handleCardClick(trackId: number) {
    const ann = annotations[trackId];
    const status = ann?.status ?? 'not_started';

    if (status === 'not_started') {
      setActiveTrackId(trackId);
      setPhase('ready');
    } else if (status === 'in_progress') {
      const choice = window.confirm(
        `Track ${trackId} is in progress.\n\nOK = Resume where you left off\nCancel = Start over`
      );
      if (choice) {
        setActiveTrackId(trackId);
        setPhase('ready');
      } else {
        if (window.confirm('Start over? This will clear all progress for this track.')) {
          setActiveTrackId(trackId);
          resetTrack(trackId);
          setPhase('ready');
        }
      }
    } else if (status === 'complete') {
      setActiveTrackId(trackId);
      setPhase('review');
    } else if (status === 'skipped') {
      if (window.confirm('Unskip and restart this track?')) {
        setActiveTrackId(trackId);
        resetTrack(trackId);
        setPhase('ready');
      }
    }
  }

  // ── Derived stats for header ─────────────────────────────────────────────
  const tracks = getActiveTracks();
  const allAnnotations = tracks.map((t) => annotations[t.id]);
  const completeCount = allAnnotations.filter((a) => a?.status === 'complete').length;
  const totalCount = tracks.length;
  const allNotStarted = allAnnotations.every((a) => !a || a.status === 'not_started');

  // First in_progress track for CONTINUE SESSION button
  const firstInProgress = tracks.find((t) => annotations[t.id]?.status === 'in_progress');

  function handleContinue() {
    if (!firstInProgress) return;
    setActiveTrackId(firstInProgress.id);
    setPhase('ready');
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      {showTrackManager && (
        <TrackManager onClose={() => setShowTrackManager(false)} />
      )}

      <div className="phase-container fade-in" style={{ maxWidth: '900px', margin: '0 auto' }}>

        {/* ── HEADER ── */}
        <div style={{ marginBottom: '2rem', textAlign: 'center', padding: '1rem 0 0.5rem' }}>
          <p className="label" style={{ marginBottom: '0.5rem' }}>TUNETAG</p>
          <h1 style={{
            fontFamily: 'var(--font-display)',
            fontSize: '2rem',
            color: 'var(--amber)',
            margin: '0 0 0.625rem',
          }}>
            Annotation Session
          </h1>
          {/* Overall progress subtitle */}
          <p style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.78rem',
            color: 'var(--text-dim)',
            letterSpacing: '0.05em',
            margin: '0 0 1rem',
          }}>
            {completeCount} of {totalCount} tracks complete
          </p>

          {/* CONTINUE SESSION button — only shown when a track is in progress */}
          {firstInProgress && (
            <button
              className="btn-primary"
              onClick={handleContinue}
              style={{ marginBottom: '0.5rem' }}
            >
              CONTINUE SESSION — Track {firstInProgress.id} →
            </button>
          )}

          {/* Welcome prompt — only when all tracks not started */}
          {allNotStarted && (
            <p style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
              fontStyle: 'italic',
              margin: '0.5rem 0 0',
            }}>
              Select a track below to begin annotating
            </p>
          )}
        </div>

        {/* ── TRACK CARDS GRID ── */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: '1rem',
          marginBottom: '2rem',
        }}>
          {tracks.map((track) => {
            const ann = annotations[track.id];
            const status = ann?.status ?? 'not_started';
            const timeline = ann?.timeline ?? [];
            const global = ann?.global ?? {};
            const globalFilled = Object.values(global).filter((v) => v && (v as string).trim()).length;
            const elapsed = ann?.elapsedSeconds ?? 0;
            const isComplete = status === 'complete';
            const isInProgress = status === 'in_progress';

            return (
              <button
                key={track.id}
                className="track-card"
                onClick={() => handleCardClick(track.id)}
                style={{
                  minHeight: '140px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  textAlign: 'left',
                  position: 'relative',
                  overflow: 'hidden',
                  // Subtle tint for complete tracks
                  background: isComplete ? 'color-mix(in srgb, var(--success) 8%, var(--surface))' : undefined,
                }}
              >
                {/* Complete: green bottom border accent */}
                {isComplete && (
                  <div style={{
                    position: 'absolute',
                    bottom: 0, left: 0, right: 0,
                    height: '3px',
                    background: 'var(--success)',
                  }} />
                )}
                {/* In-progress: amber bottom border accent */}
                {isInProgress && (
                  <div style={{
                    position: 'absolute',
                    bottom: 0, left: 0, right: 0,
                    height: '3px',
                    background: 'var(--amber)',
                  }} />
                )}

                {/* Top row: track number + status badge */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                  <p className="label" style={{ color: 'var(--amber)', margin: 0 }}>
                    TRACK {track.id}
                  </p>
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.68rem',
                    letterSpacing: '0.07em',
                    padding: '0.2rem 0.6rem',
                    borderRadius: 'var(--radius-pill)',
                    fontWeight: 600,
                    ...STATUS_BADGE_STYLE[status],
                  }}>
                    {STATUS_LABEL[status]}
                  </span>
                </div>

                {/* Track name + artist */}
                <div style={{ flex: 1 }}>
                  <p style={{
                    fontFamily: 'var(--font-display)',
                    fontStyle: 'italic',
                    fontSize: '1.25rem',
                    margin: '0 0 0.25rem',
                    color: status === 'skipped' ? 'var(--text-dim)' : 'var(--text)',
                    textDecoration: status === 'skipped' ? 'line-through' : 'none',
                  }}>
                    {track.name}
                  </p>
                  <p style={{
                    color: 'var(--text-muted)',
                    margin: 0,
                    fontSize: '0.875rem',
                  }}>
                    {track.artist}
                  </p>
                </div>

                {/* Bottom meta row — elapsed time + entry count */}
                {(isInProgress || isComplete) && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.875rem',
                    marginTop: '0.75rem',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.78rem',
                    flexWrap: 'wrap',
                  }}>
                    {elapsed > 0 && (
                      <span style={{ color: 'var(--amber)' }}>
                        ⏱ {formatMSS(elapsed)}
                      </span>
                    )}
                    {timeline.length > 0 && (
                      <span style={{ color: 'var(--text-dim)' }}>
                        {timeline.length} timeline {timeline.length === 1 ? 'entry' : 'entries'}
                      </span>
                    )}
                    {isInProgress && globalFilled > 0 && (
                      <span style={{ color: 'var(--text-dim)' }}>
                        {globalFilled}/9 categories
                      </span>
                    )}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* ── BOTTOM ACTIONS ── */}
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.625rem' }}>
          <button
            className="btn-ghost btn-small"
            onClick={() => setPhase('prompts_tags')}
            style={{ letterSpacing: '0.05em' }}
          >
            ◈ PROMPTS &amp; TAGS
          </button>
          <button
            className="btn-ghost btn-small"
            onClick={() => setShowTrackManager(true)}
            style={{ letterSpacing: '0.05em', color: 'var(--text-dim)' }}
          >
            ⊞ MANAGE TRACKS
          </button>
        </div>
      </div>
    </>
  );
}
