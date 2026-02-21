import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { TrackAnnotation, Phase, TimelineEntry } from '../types';
import { TAG_SUGGESTIONS, SECTION_TYPE_SHORTCUTS } from '../lib/schema';
import { useMicMeter } from '../hooks';
import { WaveformScrubber } from './WaveformScrubber';

// ── Types ──────────────────────────────────────────────────────────────────

interface Props {
  annotation: TrackAnnotation;
  elapsedSeconds: number;
  isTimerRunning: boolean;
  timerStart: () => void;
  timerPause: () => void;
  timerSeek: (seconds: number) => void;
  setPhase: (phase: Phase) => void;
  updateTimeline: (trackId: number, entries: TimelineEntry[]) => void;
  setStatus: (trackId: number, status: TrackAnnotation['status'], extra?: Partial<TrackAnnotation>) => void;
  spotifyToken: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spotifyPlayer: any;
}

interface Toast {
  id: string;
  label: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatMSS(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Flatten TAG_SUGGESTIONS into [category, tags[]] pairs; prepend Sections
const FLOW_TAG_GROUPS: Array<[string, string[]]> = [
  ['Sections', SECTION_TYPE_SHORTCUTS],
  ...Object.entries(TAG_SUGGESTIONS),
];

// ── Mic Level Meter ─────────────────────────────────────────────────────────

function MicLevelMeter({ stream }: { stream: MediaStream | null }) {
  const barLevels = useMicMeter(stream);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const BAR_COUNT = barLevels.length;
    const W = canvas.width;
    const H = canvas.height;
    ctx2d.clearRect(0, 0, W, H);
    const barW = Math.floor((W - BAR_COUNT + 1) / BAR_COUNT);
    for (let i = 0; i < BAR_COUNT; i++) {
      const barH = Math.max(2, Math.floor(barLevels[i] * H));
      ctx2d.fillStyle = 'var(--amber)';
      ctx2d.fillRect(i * (barW + 1), H - barH, barW, barH);
    }
  }, [barLevels]);

  return (
    <canvas
      ref={canvasRef}
      width={400}
      height={32}
      style={{ width: '100%', height: '32px', display: 'block', borderRadius: 'var(--radius)' }}
    />
  );
}

// ── Main component ──────────────────────────────────────────────────────────

export function PhaseFlow({
  annotation,
  elapsedSeconds,
  isTimerRunning,
  timerStart,
  timerPause,
  timerSeek,
  setPhase,
  updateTimeline,
  spotifyToken: _spotifyToken,
  spotifyPlayer,
}: Props) {
  const trackId = annotation.track.id;
  const timeline = annotation.timeline;

  // ── Mic stream (for meter) ─────────────────────────────────────────────
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let active = true;
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then((s) => {
        if (!active) { s.getTracks().forEach((t) => t.stop()); return; }
        micStreamRef.current = s;
        setMicStream(s);
      })
      .catch(() => { /* mic denied — meter simply won't show */ });
    return () => {
      active = false;
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    };
  }, []);

  // ── Smart Dictate ──────────────────────────────────────────────────────
  const speechSupported =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  const [smartDictateOn, setSmartDictateOn] = useState(false);
  const [speechToTextOn, setSpeechToTextOn] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [finalText, setFinalText] = useState('');
  const finalFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recognitionRef = useRef<any>(null);

  // Single shared recognition — handles both Smart Dictate and Speech-to-Text
  const startRecognition = useCallback(() => {
    if (!speechSupported) return;
    if (recognitionRef.current) return; // already running

    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new SpeechRecognitionCtor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    recognitionRef.current = rec;

    rec.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const text = event.results[i][0].transcript.trim();
          if (!text) continue;

          // Smart Dictate: append as timeline entry immediately
          if (smartDictateOn) {
            const entry: TimelineEntry = {
              id: crypto.randomUUID(),
              timestamp: formatMSS(elapsedSeconds),
              sectionType: 'Note',
              narrative: text,
              narrativeRaw: text,
              tags: '',
              wasPolished: false,
              isDictated: true,
            };
            updateTimeline(trackId, [...annotation.timeline, entry]);
          }

          // Speech-to-Text display
          setFinalText(text);
          if (finalFadeTimerRef.current) clearTimeout(finalFadeTimerRef.current);
          finalFadeTimerRef.current = setTimeout(() => setFinalText(''), 4000);
          setInterimText('');
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      setInterimText(interim);
    };

    rec.onerror = () => {
      recognitionRef.current = null;
    };

    rec.onend = () => {
      recognitionRef.current = null;
      // Auto-restart if either mode is still on
      if (smartDictateOn || speechToTextOn) {
        startRecognition();
      }
    };

    rec.start();
  }, [speechSupported, smartDictateOn, speechToTextOn, elapsedSeconds, updateTimeline, trackId, annotation.timeline]);

  const stopRecognition = useCallback(() => {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    setInterimText('');
  }, []);

  // Start / stop recognition when toggles change
  useEffect(() => {
    if (smartDictateOn || speechToTextOn) {
      startRecognition();
    } else {
      stopRecognition();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smartDictateOn, speechToTextOn]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopRecognition();
      if (finalFadeTimerRef.current) clearTimeout(finalFadeTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Toast notifications ────────────────────────────────────────────────
  const [toasts, setToasts] = useState<Toast[]>([]);

  function showToast(label: string) {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, label }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 1500);
  }

  // ── Tag tap ────────────────────────────────────────────────────────────
  function handleTagTap(tagName: string) {
    const entry: TimelineEntry = {
      id: crypto.randomUUID(),
      timestamp: formatMSS(elapsedSeconds),
      sectionType: tagName,
      narrative: '',
      narrativeRaw: '',
      tags: '',
      wasPolished: false,
    };
    updateTimeline(trackId, [...annotation.timeline, entry]);
    showToast(`✓ ${tagName}`);
  }

  // ── Timeline drawer ────────────────────────────────────────────────────
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Newest-first view of timeline
  const timelineDesc = useMemo(
    () => [...timeline].reverse(),
    [timeline]
  );

  // ── Spotify sync helpers ────────────────────────────────────────────────
  function spotifyPlay() {
    if (spotifyPlayer?.isReady) spotifyPlayer.play().catch(() => {});
  }
  function spotifyPause() {
    if (spotifyPlayer?.isReady) spotifyPlayer.pause().catch(() => {});
  }
  function spotifySeekMs(ms: number) {
    if (spotifyPlayer?.isReady) spotifyPlayer.seek(Math.max(0, ms)).catch(() => {});
  }

  function handlePlayPause() {
    if (isTimerRunning) {
      timerPause();
      spotifyPause();
    } else {
      timerStart();
      spotifyPlay();
    }
  }

  function handleSeek(deltaSecs: number) {
    const next = Math.max(0, elapsedSeconds + deltaSecs);
    timerSeek(next);
    if (isTimerRunning) timerStart();
    spotifySeekMs(next * 1000);
  }

  // ── Progress bar ───────────────────────────────────────────────────────
  const durationSeconds = (annotation.track as any).durationSeconds ?? 300;
  const progressFraction = Math.min(1, elapsedSeconds / durationSeconds);

  // ── Elapsed seconds ref for use inside recognition callback ───────────
  const elapsedRef = useRef(elapsedSeconds);
  elapsedRef.current = elapsedSeconds;

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--bg)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      fontFamily: 'var(--font-mono)',
    }}>

      {/* ── TOP BAR ── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0.75rem 1rem',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        gap: '1rem',
      }}>
        {/* Track info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            fontFamily: 'var(--font-mono)', fontSize: '0.7rem',
            color: 'var(--text-dim)', letterSpacing: '0.08em',
            marginBottom: '0.125rem', textTransform: 'uppercase',
          }}>
            FLOW MODE
          </p>
          <p style={{
            fontFamily: 'var(--font-serif)', fontSize: '0.95rem',
            color: 'var(--text)', fontWeight: 600,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {annotation.track.name}
          </p>
          <p style={{
            fontFamily: 'var(--font-mono)', fontSize: '0.75rem',
            color: 'var(--text-muted)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {annotation.track.artist}
          </p>
        </div>

        {/* Elapsed time */}
        <div style={{
          fontFamily: 'var(--font-mono)',
          fontSize: '2rem', fontWeight: 700,
          color: 'var(--amber)',
          letterSpacing: '0.04em',
          flexShrink: 0,
        }}>
          {formatMSS(elapsedSeconds)}
        </div>

        {/* Exit */}
        <div style={{ flexShrink: 0 }}>
          <button
            onClick={() => { timerPause(); setPhase('listening'); }}
            style={{
              background: 'transparent',
              border: '1px solid var(--border-active)',
              borderRadius: 'var(--radius)',
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.7rem',
              letterSpacing: '0.06em',
              padding: '0.375rem 0.75rem',
              cursor: 'pointer',
            }}
          >
            EXIT FLOW MODE
          </button>
        </div>
      </div>

      {/* ── WAVEFORM SCRUBBER ── */}
      <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <WaveformScrubber
          spotifyTrackId={annotation.track.spotifyId}
          spotifyToken={_spotifyToken}
          elapsedSeconds={elapsedSeconds}
          durationSeconds={durationSeconds}
          onSeek={(secs) => {
            timerSeek(secs);
            if (isTimerRunning) timerStart();
            spotifySeekMs(secs * 1000);
          }}
        />
      </div>

      {/* ── SCROLLABLE BODY ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '1rem' }}>

        {/* ── TRANSPORT ROW ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: '1.5rem', marginBottom: '1.25rem',
        }}>
          <button
            aria-label="Back 10 seconds"
            onClick={() => handleSeek(-10)}
            style={transportBtnStyle}
          >
            ⏮ −10s
          </button>

          <button
            aria-label={isTimerRunning ? 'Pause' : 'Play'}
            onClick={handlePlayPause}
            style={{
              ...transportBtnStyle,
              minWidth: '72px', minHeight: '72px',
              fontSize: '1.75rem',
              background: 'var(--amber)',
              color: 'var(--bg)',
              border: 'none',
              borderRadius: '50%',
            }}
          >
            {isTimerRunning ? '⏸' : '▶'}
          </button>

          <button
            aria-label="Forward 10 seconds"
            onClick={() => handleSeek(10)}
            style={transportBtnStyle}
          >
            +10s ⏭
          </button>
        </div>

        {/* ── MIC METER ── */}
        <div style={{ marginBottom: '1.25rem' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.625rem',
            marginBottom: '0.375rem',
          }}>
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: '0.65rem',
              color: 'var(--text-dim)', letterSpacing: '0.08em',
            }}>
              MIC
            </span>
            {!micStream && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                (no access)
              </span>
            )}
          </div>
          <MicLevelMeter stream={micStream} />
        </div>

        {/* ── SMART DICTATE + SPEECH-TO-TEXT TOGGLES ── */}
        <div style={{
          display: 'flex', gap: '0.75rem', flexWrap: 'wrap',
          marginBottom: '1.25rem',
        }}>
          {speechSupported && (
            <button
              onClick={() => setSmartDictateOn((v) => !v)}
              style={{
                ...pillToggleStyle,
                background: smartDictateOn ? 'var(--amber)' : 'var(--surface)',
                color: smartDictateOn ? 'var(--bg)' : 'var(--text)',
                border: `1px solid ${smartDictateOn ? 'var(--amber)' : 'var(--border-active)'}`,
              }}
            >
              <span style={{
                display: 'inline-block',
                width: '8px', height: '8px', borderRadius: '50%',
                background: smartDictateOn ? 'var(--bg)' : 'var(--error)',
                marginRight: '0.5rem',
                animation: smartDictateOn ? 'flow-pulse 1.2s ease-in-out infinite' : 'none',
              }} />
              SMART DICTATE
            </button>
          )}

          {speechSupported && (
            <button
              onClick={() => setSpeechToTextOn((v) => !v)}
              style={{
                ...pillToggleStyle,
                background: speechToTextOn ? 'var(--amber)' : 'var(--surface)',
                color: speechToTextOn ? 'var(--bg)' : 'var(--text)',
                border: `1px solid ${speechToTextOn ? 'var(--amber)' : 'var(--border-active)'}`,
              }}
            >
              ◎ SPEECH TO TEXT
            </button>
          )}
        </div>

        {/* ── SPEECH-TO-TEXT TRANSCRIPT BOX ── */}
        {speechToTextOn && (
          <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            padding: '0.75rem 1rem',
            marginBottom: '1.25rem',
            minHeight: '3rem',
            fontFamily: 'var(--font-serif)',
            fontSize: '0.9rem',
            lineHeight: 1.6,
          }}>
            {finalText && (
              <span style={{ color: 'var(--text)' }}>{finalText} </span>
            )}
            {interimText && (
              <span style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>{interimText}</span>
            )}
            {!finalText && !interimText && (
              <span style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>Listening…</span>
            )}
          </div>
        )}

        {/* ── TAG BUTTONS ── */}
        <div style={{ marginBottom: '1.5rem' }}>
          {FLOW_TAG_GROUPS.map(([category, tags]) => (
            <div key={category} style={{ marginBottom: '1rem' }}>
              <p style={{
                fontFamily: 'var(--font-mono)', fontSize: '0.65rem',
                color: 'var(--text-dim)', letterSpacing: '0.08em',
                textTransform: 'uppercase', marginBottom: '0.5rem',
              }}>
                {category}
              </p>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                gap: '0.5rem',
              }}>
                {tags.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => handleTagTap(tag)}
                    style={tagPillStyle}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── TIMELINE DRAWER TOGGLE ── */}
      <div style={{
        flexShrink: 0,
        borderTop: '1px solid var(--border)',
        background: 'var(--surface)',
      }}>
        <button
          onClick={() => setDrawerOpen((v) => !v)}
          style={{
            width: '100%',
            background: 'transparent',
            border: 'none',
            color: 'var(--text)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8rem',
            letterSpacing: '0.06em',
            padding: '0.75rem 1rem',
            textAlign: 'left',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span>TIMELINE ({timeline.length})</span>
          <span style={{ color: 'var(--text-dim)' }}>{drawerOpen ? '▾' : '▴'}</span>
        </button>

        {/* Drawer contents */}
        {drawerOpen && (
          <div style={{
            maxHeight: '260px',
            overflowY: 'auto',
            padding: '0 1rem 1rem',
            borderTop: '1px solid var(--border)',
          }}>
            {timelineDesc.length === 0 ? (
              <p style={{
                fontFamily: 'var(--font-mono)', fontSize: '0.8rem',
                color: 'var(--text-dim)', fontStyle: 'italic',
                paddingTop: '0.75rem',
              }}>
                No entries yet. Tap a tag above to log a moment.
              </p>
            ) : (
              timelineDesc.map((entry) => (
                <div key={entry.id} style={{
                  display: 'flex', gap: '0.75rem', alignItems: 'baseline',
                  padding: '0.375rem 0',
                  borderBottom: '1px solid var(--border)',
                  fontFamily: 'var(--font-mono)', fontSize: '0.78rem',
                }}>
                  <span style={{ color: 'var(--amber)', flexShrink: 0 }}>
                    {entry.timestamp}
                  </span>
                  <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                    {entry.sectionType || '—'}
                  </span>
                  <span style={{
                    color: 'var(--text)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {entry.narrative || ''}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* ── TOAST OVERLAY ── */}
      <div style={{
        position: 'fixed', top: '5rem', right: '1rem',
        display: 'flex', flexDirection: 'column', gap: '0.5rem',
        zIndex: 200, pointerEvents: 'none',
      }}>
        {toasts.map((t) => (
          <div key={t.id} style={{
            background: 'var(--amber)',
            color: 'var(--bg)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.8rem',
            letterSpacing: '0.04em',
            padding: '0.375rem 0.875rem',
            borderRadius: 'var(--radius-pill)',
            boxShadow: '0 2px 8px var(--amber-glow)',
            animation: 'flow-toast-in 0.15s ease',
          }}>
            {t.label}
          </div>
        ))}
      </div>

      {/* ── KEYFRAME ANIMATIONS (injected once) ── */}
      <style>{`
        @keyframes flow-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        @keyframes flow-toast-in {
          from { opacity: 0; transform: translateX(12px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}

// ── Shared style objects ──────────────────────────────────────────────────────

const transportBtnStyle: React.CSSProperties = {
  minWidth: '64px',
  minHeight: '44px',
  background: 'var(--surface)',
  border: '1px solid var(--border-active)',
  borderRadius: 'var(--radius)',
  color: 'var(--text)',
  fontFamily: 'var(--font-mono)',
  fontSize: '0.85rem',
  letterSpacing: '0.04em',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0 0.75rem',
};

const pillToggleStyle: React.CSSProperties = {
  minHeight: '44px',
  borderRadius: 'var(--radius-pill)',
  fontFamily: 'var(--font-mono)',
  fontSize: '0.75rem',
  letterSpacing: '0.06em',
  padding: '0 1.125rem',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  transition: 'background var(--transition), color var(--transition)',
};

const tagPillStyle: React.CSSProperties = {
  minHeight: '44px',
  background: 'var(--surface)',
  border: '1px solid var(--border-active)',
  borderRadius: 'var(--radius-pill)',
  color: 'var(--text)',
  fontFamily: 'var(--font-mono)',
  fontSize: '0.78rem',
  letterSpacing: '0.03em',
  padding: '0.25rem 0.75rem',
  cursor: 'pointer',
  textAlign: 'center',
  transition: 'background var(--transition)',
  wordBreak: 'break-word',
};
