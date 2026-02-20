// FIX #1: No useTimer here. elapsedSeconds + isTimerRunning come from App as props.
// FIX #8: Capture wasRunning BEFORE pause fires in dictation flow.
// FIX #9: SpeechRecognition cleanup on component unmount.
import { useCallback, useState, useRef, useEffect } from 'react';
import type {
  TrackAnnotation,
  Phase,
  MarkEntryDraft,
  TimelineEntry,
} from '../types';
import { MAX_TIMELINE_ROWS } from '../lib/schema';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';

interface Props {
  annotation: TrackAnnotation;
  // FIX #1: Timer props from App — no second timer instance
  elapsedSeconds: number;
  isTimerRunning: boolean;
  timerStart: () => void;
  timerPause: () => void;
  setPhase: (p: Phase) => void;
  setMarkEntryDraft: (d: MarkEntryDraft | null) => void;
  updateTimeline: (trackId: number, entries: TimelineEntry[]) => void;
  setStatus: (trackId: number, status: TrackAnnotation['status'], extra?: Partial<TrackAnnotation>) => void;
  isActive: boolean;
}

function formatMSS(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Dictation hook ─────────────────────────────────────────────────────────
// Uses Web Speech API (SpeechRecognition).
// Spotify iframe cannot be programmatically paused — user must pause manually.
// FIX #8: wasRunning captured at dictate-click time, threaded through state.
// FIX #9: Cleanup on unmount via cleanup effect.

type DictationStatus =
  | 'idle'
  | 'awaiting_manual_pause'
  | 'recording'
  | 'done'
  | 'error';

interface DictationState {
  status: DictationStatus;
  transcript: string;
  capturedTimestamp: string;
  capturedWasRunning: boolean; // FIX #8: timer state at dictate-click time
  error?: string;
}

const INITIAL_DICTATION: DictationState = {
  status: 'idle',
  transcript: '',
  capturedTimestamp: '',
  capturedWasRunning: false,
};

function useDictation(onComplete: (transcript: string, timestamp: string, wasRunning: boolean) => void) {
  const [state, setState] = useState<DictationState>(INITIAL_DICTATION);
  const recognitionRef = useRef<any>(null);

  const isSupported =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  // FIX #9: clean up recognition on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch { /* ignore */ }
        recognitionRef.current = null;
      }
    };
  }, []);

  // Step 1: capture timestamp + wasRunning, show manual-pause prompt
  function begin(capturedTimestamp: string, capturedWasRunning: boolean) {
    setState({ ...INITIAL_DICTATION, status: 'awaiting_manual_pause', capturedTimestamp, capturedWasRunning });
  }

  // Step 2: user confirmed Spotify is paused — start recording
  function startRecording() {
    if (!isSupported) {
      setState((p) => ({
        ...p,
        status: 'error',
        error: 'Speech recognition is not supported in this browser. Use Chrome or Edge.',
      }));
      return;
    }

    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognitionRef.current = recognition;
    setState((p) => ({ ...p, status: 'recording', transcript: '' }));

    let finalTranscript = '';

    recognition.onresult = (event: any) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript + ' ';
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      setState((p) => ({ ...p, transcript: (finalTranscript + interim).trim() }));
    };

    recognition.onerror = (event: any) => {
      recognitionRef.current = null;
      setState((p) => ({
        ...p,
        status: 'error',
        error: `Recording error: ${event.error}`,
      }));
    };

    recognition.onend = () => {
      // Only auto-transition if we're still in recording state (not manually stopped)
      setState((p) => {
        if (p.status === 'recording') {
          return { ...p, status: 'done', transcript: finalTranscript.trim() };
        }
        return p;
      });
      recognitionRef.current = null;
    };

    recognition.start();
  }

  function stopRecording() {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    setState((p) => ({ ...p, status: 'done' }));
  }

  function accept() {
    const { transcript, capturedTimestamp, capturedWasRunning } = state;
    onComplete(transcript, capturedTimestamp, capturedWasRunning);
    setState(INITIAL_DICTATION);
  }

  function cancel() {
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    setState(INITIAL_DICTATION);
  }

  return { state, isSupported, begin, startRecording, stopRecording, accept, cancel };
}

// ── PhaseListening ─────────────────────────────────────────────────────────
export function PhaseListening({
  annotation,
  elapsedSeconds,
  isTimerRunning,
  timerStart,
  timerPause,
  setPhase,
  setMarkEntryDraft,
  updateTimeline,
  setStatus,
  isActive,
}: Props) {
  const track = annotation.track;
  const timeline = annotation.timeline;
  const atCap = timeline.length >= MAX_TIMELINE_ROWS;

  // ── MARK THIS MOMENT ──────────────────────────────────────────────────────
  function handleMark() {
    if (!isActive) return;
    if (dictation.state.status !== 'idle') return;
    if (atCap) return;
    // FIX: Capture wasRunning BEFORE pausing
    const wasRunning = isTimerRunning;
    timerPause();

    const timestamp = formatMSS(elapsedSeconds);
    setMarkEntryDraft({
      mode: 'new',
      timestamp,
      sectionType: '',
      narrative: '',
      narrativeRaw: '',
      tags: '',
      wasTimerRunning: wasRunning,
    });
    setPhase('mark_entry');
  }

  // ── EDIT ENTRY ────────────────────────────────────────────────────────────
  function handleEdit(entry: TimelineEntry) {
    if (!isActive) return;
    const wasRunning = isTimerRunning;
    timerPause();
    setMarkEntryDraft({
      mode: 'edit',
      entryId: entry.id,
      timestamp: entry.timestamp,
      sectionType: entry.sectionType,
      narrative: entry.narrative,
      narrativeRaw: entry.narrativeRaw,
      tags: entry.tags,
      wasTimerRunning: wasRunning,
    });
    setPhase('mark_entry');
  }

  // ── DELETE ENTRY ──────────────────────────────────────────────────────────
  function handleDelete(entryId: string) {
    if (!window.confirm('Remove this section?')) return;
    updateTimeline(track.id, timeline.filter((e) => e.id !== entryId));
  }

  // ── SKIP ──────────────────────────────────────────────────────────────────
  function handleSkip() {
    const reason = window.prompt(
      'Reason for skipping (optional — press OK to skip without reason):',
      ''
    );
    if (reason === null) return; // user pressed Cancel
    timerPause();
    setStatus(track.id, 'skipped', { skipReason: reason || undefined });
    setPhase('select');
  }

  // ── DONE ──────────────────────────────────────────────────────────────────
  function handleDone() {
    if (timeline.length === 0) return;
    timerPause();
    setPhase('global');
  }

  // ── KEYBOARD SHORTCUTS ────────────────────────────────────────────────────
  useKeyboardShortcuts(isActive ? [{ key: 'm', handler: handleMark }] : []);

  // Spacebar to pause/resume — skip when focus is inside a text field.
  useEffect(() => {
    if (!isActive) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.code !== 'Space') return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      if (isTimerRunning) timerPause();
      else timerStart();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, isTimerRunning, timerPause, timerStart]);

  // ── DICTATION ─────────────────────────────────────────────────────────────
  // FIX #8: wasRunning captured at click time in begin(), threaded through state
  const dictation = useDictation((transcript, timestamp, capturedWasRunning) => {
    // When transcript is accepted, open MarkEntry with it pre-filled.
    // Use capturedWasRunning (from dictate-click time), NOT current isTimerRunning
    // which is already false because we paused it at dictate-click.
    setMarkEntryDraft({
      mode: 'new',
      timestamp,
      sectionType: '',
      narrative: transcript,
      narrativeRaw: transcript,
      tags: '',
      wasTimerRunning: capturedWasRunning,
      isDictated: true,
      dictationTranscript: transcript,
    });
    setPhase('mark_entry');
  });

  function handleDictateClick() {
    if (!isActive) return;
    if (atCap || dictation.state.status !== 'idle') return;
    // FIX #8: capture wasRunning BEFORE timerPause()
    const wasRunning = isTimerRunning;
    timerPause();
    const timestamp = formatMSS(elapsedSeconds);
    dictation.begin(timestamp, wasRunning);
  }

  // Timer display colour
  const isWarning = elapsedSeconds >= 20 * 60;
  const timerColor = !isTimerRunning
    ? 'var(--text-muted)'
    : isWarning
    ? 'var(--error)'
    : 'var(--amber)';

  function toggleTimer() {
    if (isTimerRunning) timerPause();
    else timerStart();
  }

  // Reverse-chronological display
  const displayEntries = [...timeline].reverse();

  return (
    <div className="phase-listening">
      {/* Sticky top bar */}
      <div className="listening-topbar">
        {/* Spotify embed — full track card, same as PhaseReady */}
        <div style={{ borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: '0.75rem' }}>
          <iframe
            src={`https://open.spotify.com/embed/track/${track.spotifyId}?utm_source=generator&theme=0`}
            width="100%"
            height="152"
            frameBorder="0"
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            loading="lazy"
            title={`${track.artist} - ${track.name}`}
          />
        </div>

        {/* Timer row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="label" style={{ color: 'var(--amber)', margin: 0 }}>
            TRACK {track.id} — PART 1 · TIMELINE
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.25rem' }}>
            <button
              onClick={toggleTimer}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
                fontSize: '1.5rem',
                color: timerColor,
                transition: 'color 200ms',
                padding: 0,
              }}
              title={isTimerRunning ? 'Click to pause' : 'Click to resume'}
            >
              {formatMSS(elapsedSeconds)}
              {isWarning && isTimerRunning && (
                <span style={{ fontSize: '0.75rem', marginLeft: '0.5rem' }}>⚠ 20 MIN</span>
              )}
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '0.75rem',
                color: atCap ? 'var(--amber)' : 'var(--text-dim)',
              }}>
                {timeline.length} / {MAX_TIMELINE_ROWS}
              </span>
              <span className="kbd-hint">M to mark</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="listening-main">
        {/* Dictation flow overlay */}
        {dictation.state.status !== 'idle' && (
          <div className="dictation-overlay">
            {dictation.state.status === 'awaiting_manual_pause' && (
              <div className="dictation-card">
                <p className="label" style={{ color: 'var(--amber)', marginBottom: '0.75rem' }}>
                  🎙 DICTATE
                </p>
                <p style={{ color: 'var(--text)', marginBottom: '0.75rem', lineHeight: 1.6 }}>
                  Spotify can't be paused automatically — please pause your playback now,
                  then press <strong>Start Recording</strong>.
                </p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
                  Timestamp captured: {dictation.state.capturedTimestamp}
                </p>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn-ghost" onClick={dictation.cancel}>Cancel</button>
                  <button className="btn-primary" onClick={dictation.startRecording}>
                    ● Start Recording
                  </button>
                </div>
              </div>
            )}

            {dictation.state.status === 'recording' && (
              <div className="dictation-card">
                <p className="label" style={{ color: 'var(--error)', marginBottom: '0.75rem' }}>
                  ● RECORDING…
                </p>
                <p style={{
                  color: dictation.state.transcript ? 'var(--text)' : 'var(--text-muted)',
                  minHeight: '3rem',
                  fontFamily: 'var(--font-serif)',
                  lineHeight: 1.6,
                  marginBottom: '1rem',
                }}>
                  {dictation.state.transcript || 'Listening…'}
                </p>
                <button className="btn-primary" onClick={dictation.stopRecording}>
                  ■ Stop Recording
                </button>
              </div>
            )}

            {dictation.state.status === 'done' && (
              <div className="dictation-card">
                <p className="label" style={{ color: 'var(--success)', marginBottom: '0.75rem' }}>
                  ✓ TRANSCRIPT READY
                </p>
                <p style={{
                  color: 'var(--text)',
                  fontFamily: 'var(--font-serif)',
                  lineHeight: 1.6,
                  marginBottom: '1rem',
                }}>
                  {dictation.state.transcript || (
                    <span style={{ color: 'var(--text-muted)' }}>No speech detected.</span>
                  )}
                </p>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn-ghost" onClick={dictation.cancel}>Discard</button>
                  <button
                    className="btn-primary"
                    disabled={!dictation.state.transcript}
                    onClick={dictation.accept}
                  >
                    Use Transcript →
                  </button>
                </div>
              </div>
            )}

            {dictation.state.status === 'error' && (
              <div className="dictation-card">
                <p className="label" style={{ color: 'var(--error)', marginBottom: '0.75rem' }}>
                  DICTATION ERROR
                </p>
                <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>
                  {dictation.state.error}
                </p>
                <button className="btn-ghost" onClick={dictation.cancel}>Dismiss</button>
              </div>
            )}
          </div>
        )}

        {/* MARK THIS MOMENT + DICTATE */}
        <div style={{ padding: '1.25rem 1rem 0.5rem' }}>
          <button
            className={`mark-button ${isTimerRunning && !atCap ? 'mark-button--pulsing' : ''}`}
            onClick={handleMark}
            disabled={atCap}
            title={atCap ? 'Maximum 10 sections reached — edit or remove a section to add more' : ''}
          >
            ⏺ MARK THIS MOMENT
          </button>

          <button
            className="btn-ghost dictate-btn"
            onClick={handleDictateClick}
            disabled={atCap || dictation.state.status !== 'idle'}
            style={{ width: '100%', marginTop: '0.5rem', fontSize: '0.875rem' }}
            title={atCap ? 'Maximum 10 sections reached' : 'Record voice note — transcript opens in editor'}
          >
            🎙 Dictate
          </button>

          {atCap && (
            <p style={{
              textAlign: 'center',
              color: 'var(--amber)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.75rem',
              marginTop: '0.5rem',
            }}>
              10/10 sections — edit or remove to add more
            </p>
          )}
        </div>

        {/* Timeline entries (reverse chronological) */}
        <div style={{ padding: '0.5rem 1rem 9rem' }}>
          {displayEntries.length === 0 && (
            <p style={{
              textAlign: 'center',
              color: 'var(--text-dim)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.8125rem',
              marginTop: '1.5rem',
            }}>
              No sections yet — press Mark when something changes
            </p>
          )}
          {displayEntries.map((entry) => (
            <div key={entry.id} className="timeline-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span className="timestamp-label">{entry.timestamp}</span>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="icon-btn" onClick={() => handleEdit(entry)} title="Edit">✎</button>
                  <button className="icon-btn icon-btn--danger" onClick={() => handleDelete(entry.id)} title="Delete">×</button>
                </div>
              </div>
              <p className="timeline-section-type">{entry.sectionType}</p>
              <p className="timeline-narrative">{entry.narrative}</p>
              {entry.tags && <p className="timeline-tags">{entry.tags}</p>}
              {entry.isDictated && <span className="dictated-badge">🎙 dictated</span>}
            </div>
          ))}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="listening-bottombar">
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn-ghost" onClick={() => { timerPause(); setPhase('select'); }}>
            ← Menu
          </button>
          <button className="btn-ghost btn-destructive" onClick={handleSkip}>
            SKIP THIS TRACK
          </button>
        </div>
        <button className="btn-primary" disabled={timeline.length === 0} onClick={handleDone}>
          DONE — PART 2 →
        </button>
      </div>
    </div>
  );
}
