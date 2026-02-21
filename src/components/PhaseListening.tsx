// FIX #1: No useTimer here. elapsedSeconds + isTimerRunning come from App as props.
// FIX #8: Capture wasRunning BEFORE pause fires in dictation flow.
// FIX #9: SpeechRecognition cleanup on component unmount.
// FIX #10: getUserMedia pre-flight before SpeechRecognition — ensures Chrome grants
//          microphone access explicitly, fixing "Recording error: network".
import { useState, useRef, useEffect } from 'react';
import type {
  TrackAnnotation,
  Phase,
  MarkEntryDraft,
  TimelineEntry,
  RecordingEntry,
} from '../types';
import { MAX_TIMELINE_ROWS } from '../lib/schema';
import { useKeyboardShortcuts, useMicMeter, useAudioDevices, useAudioRecorder, useDictation } from '../hooks';
import { RecordingsPanel, RecordingCard } from './RecordingsPanel';
import { WaveformScrubber } from './WaveformScrubber';

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
  // Audio recordings
  recordings: RecordingEntry[];
  addRecording: (entry: RecordingEntry) => void;
  deleteRecording: (id: string) => void;
  clearRecordings: () => void;
  // Spotify
  spotifyToken: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spotifyPlayer: any;
  timerSeek: (seconds: number) => void;
}

function formatMSS(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Dictation hook ─────────────────────────────────────────────────────────
type DictationStatus =
  | 'idle'
  | 'awaiting_manual_pause'
  | 'recording'
  | 'finalizing'   // blob is being assembled after MediaRecorder.stop()
  | 'audio_saved'  // shown for 2 s, then panel opens
  | 'done'
  | 'error';

interface DictationState {
  status: DictationStatus;
  transcript: string;
  capturedTimestamp: string;
  capturedWasRunning: boolean;
  noSpeechHint: boolean;   // true after 5 s of silence during recording
  error?: string;
}

const INITIAL_DICTATION: DictationState = {
  status: 'idle',
  transcript: '',
  capturedTimestamp: '',
  capturedWasRunning: false,
  noSpeechHint: false,
};

function useDictationFlow(
  onComplete: (transcript: string, timestamp: string, wasRunning: boolean) => void,
  onRecordingReady: (blob: Blob, mimeType: string, timestamp: string, transcript: string) => void,
  onOpenRecordingsPanel: () => void,
) {
  const [state, setState] = useState<DictationState>(INITIAL_DICTATION);

  // Stable ref so the recorder.onRecordingReady closure reads the latest timestamp
  const capturedTsRef = useRef('');

  const isSupported =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  // ── SpeechRecognition via hook ─────────────────────────────────────────────
  const dictation = useDictation();

  // ── MediaRecorder + mic stream via hook ────────────────────────────────────
  const recorder = useAudioRecorder({
    onRecordingReady: (blob, mimeType) => {
      setState((p) => ({ ...p, status: 'finalizing' }));
      onRecordingReady(blob, mimeType, capturedTsRef.current, dictation.finalTranscript);
      setState((p) => ({ ...p, status: 'audio_saved' }));
      setTimeout(() => {
        setState(INITIAL_DICTATION);
        dictation.reset();
        onOpenRecordingsPanel();
      }, 2000);
    },
  });

  // Expose mic stream for MicLevelMeter (same contract as before)
  const micStreamRef = useRef<MediaStream | null>(null);
  useEffect(() => { micStreamRef.current = recorder.micStream; }, [recorder.micStream]);

  // Mirror speech error into DictationState so the UI can show it
  useEffect(() => {
    if (dictation.error) {
      setState((p) => ({ ...p, status: 'error', error: dictation.error ?? undefined }));
    }
  }, [dictation.error]);

  // Mirror live transcript into DictationState.transcript
  useEffect(() => {
    setState((p) =>
      p.status === 'recording'
        ? { ...p, transcript: dictation.liveTranscript, noSpeechHint: dictation.noSpeechHint }
        : p
    );
  }, [dictation.liveTranscript, dictation.noSpeechHint]);

  function begin(capturedTimestamp: string, capturedWasRunning: boolean) {
    setState({ ...INITIAL_DICTATION, status: 'awaiting_manual_pause', capturedTimestamp, capturedWasRunning });
    dictation.reset();
  }

  async function startRecording() {
    if (!isSupported) {
      setState((p) => ({ ...p, status: 'error', error: 'Speech recognition not supported. Use Chrome or Edge.' }));
      return;
    }

    capturedTsRef.current = state.capturedTimestamp;

    const savedDeviceId = localStorage.getItem('tunetag_mic_device') ?? '';
    const audioConstraint: MediaTrackConstraints | boolean = savedDeviceId
      ? { deviceId: { exact: savedDeviceId } }
      : true;

    const result = await recorder.startRecording(audioConstraint);
    if ('error' in result) {
      if (savedDeviceId) localStorage.removeItem('tunetag_mic_device');
      setState((p) => ({ ...p, status: 'error', error: result.error }));
      return;
    }

    // SpeechRecognition — runs in parallel with MediaRecorder
    dictation.startDictation(result.stream);
    setState((p) => ({ ...p, status: 'recording', transcript: '', noSpeechHint: false }));
  }

  function stopRecording() {
    dictation.stopDictation();
    // Stop MediaRecorder via hook — its onstop fires finalizing → audio_saved → close
    recorder.stopRecording();
  }

  function accept() {
    const { capturedTimestamp, capturedWasRunning } = state;
    onComplete(dictation.finalTranscript || state.transcript, capturedTimestamp, capturedWasRunning);
    setState(INITIAL_DICTATION);
    dictation.reset();
  }

  function cancel() {
    dictation.stopDictation();
    recorder.cancelRecording();
    setState(INITIAL_DICTATION);
    dictation.reset();
  }

  return { state, isSupported, begin, startRecording, stopRecording, accept, cancel, micStreamRef };
}

// ── Mic level meter ─────────────────────────────────────────────────────────
// Reads RMS from an AnalyserNode on the mic stream and renders 20 bars.
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
    for (let i = 0; i < BAR_COUNT; i++) {
      const avg = barLevels[i];
      const barH = Math.max(2, avg * H);
      const x = (i / BAR_COUNT) * W;
      const barW = W / BAR_COUNT - 1;
      ctx2d.fillStyle = avg > 0.05 ? 'rgba(8,32,48,0.8)' : 'rgba(8,32,48,0.2)';
      ctx2d.fillRect(x, H - barH, barW, barH);
    }
  }, [barLevels]);

  if (!stream) return null;

  return (
    <canvas
      ref={canvasRef}
      width={200}
      height={32}
      style={{
        width: '100%',
        height: '32px',
        display: 'block',
        borderRadius: '4px',
        background: 'rgba(8,32,48,0.06)',
        marginBottom: '0.75rem',
      }}
    />
  );
}

// ── Dictation overlay ────────────────────────────────────────────────────────
// Rendered identically in both classic and fullscreen layouts.
interface DictationOverlayProps {
  state: DictationState;
  micStream: MediaStream | null;
  micDevices: MediaDeviceInfo[];
  selectedMicId: string;
  setSelectedMicId: (id: string) => void;
  onCancel: () => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onAccept: () => void;
}

function DictationOverlay({
  state, micStream, micDevices, selectedMicId, setSelectedMicId,
  onCancel, onStartRecording, onStopRecording, onAccept,
}: DictationOverlayProps) {
  if (state.status === 'idle') return null;

  return (
    <div className="dictation-overlay">
      {state.status === 'awaiting_manual_pause' && (
        <div className="dictation-card">
          <p className="label" style={{ color: 'var(--amber)', marginBottom: '0.75rem' }}>🎙 DICTATE</p>
          <p style={{ color: 'var(--text)', marginBottom: '0.75rem', lineHeight: 1.6 }}>
            Spotify can't be paused automatically — please pause your playback now,
            then press <strong>Start Recording</strong>.
          </p>
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
            Timestamp captured: {state.capturedTimestamp}
          </p>
          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{
              display: 'block', fontFamily: 'var(--font-mono)', fontSize: '0.7rem',
              letterSpacing: '0.08em', color: 'var(--text-dim)', marginBottom: '0.375rem',
            }}>
              MICROPHONE INPUT
            </label>
            <select
              className="text-input"
              value={selectedMicId}
              onChange={(e) => setSelectedMicId(e.target.value)}
              style={{ cursor: 'pointer', fontSize: '0.875rem' }}
            >
              <option value="">Default (system)</option>
              {micDevices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${d.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn-ghost" onClick={onCancel}>Cancel</button>
            <button className="btn-primary" onClick={onStartRecording}>● Start Recording</button>
          </div>
        </div>
      )}

      {state.status === 'recording' && (
        <div className="dictation-card">
          <p className="label" style={{ color: 'var(--error)', marginBottom: '0.5rem' }}>● RECORDING…</p>
          <MicLevelMeter stream={micStream} />
          <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.68rem', color: 'var(--text-dim)', letterSpacing: '0.06em', marginBottom: '0.25rem' }}>
            LIVE TRANSCRIPT (BROWSER SPEECH RECOGNITION)
          </p>
          <p style={{ color: state.transcript ? 'var(--text)' : 'var(--text-muted)', minHeight: '3rem', fontFamily: 'var(--font-serif)', lineHeight: 1.6, marginBottom: '0.5rem' }}>
            {state.transcript || 'Listening…'}
          </p>
          {state.noSpeechHint && !state.transcript && (
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-dim)', fontStyle: 'italic', marginBottom: '0.75rem' }}>
              Speak clearly into your microphone…
            </p>
          )}
          <button className="btn-primary" onClick={onStopRecording}>■ Stop Recording</button>
        </div>
      )}

      {state.status === 'finalizing' && (
        <div className="dictation-card">
          <p className="label" style={{ color: 'var(--amber)', marginBottom: '0.75rem' }}>⏳ FINALIZING RECORDING…</p>
        </div>
      )}

      {state.status === 'audio_saved' && (
        <div className="dictation-card">
          <p className="label" style={{ color: 'var(--success)', marginBottom: '0.75rem' }}>AUDIO SAVED ✓</p>
          {!state.transcript && (
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Audio saved — no transcript captured
            </p>
          )}
        </div>
      )}

      {state.status === 'done' && (
        <div className="dictation-card">
          <p className="label" style={{ color: 'var(--success)', marginBottom: '0.75rem' }}>✓ TRANSCRIPT READY</p>
          <p style={{ color: 'var(--text)', fontFamily: 'var(--font-serif)', lineHeight: 1.6, marginBottom: '1rem' }}>
            {state.transcript || <span style={{ color: 'var(--text-muted)' }}>Audio saved — no transcript captured</span>}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn-ghost" onClick={onCancel}>Discard</button>
            <button className="btn-primary" disabled={!state.transcript} onClick={onAccept}>
              Use Transcript →
            </button>
          </div>
        </div>
      )}

      {state.status === 'error' && (
        <div className="dictation-card">
          <p className="label" style={{ color: 'var(--error)', marginBottom: '0.75rem' }}>DICTATION ERROR</p>
          <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{state.error}</p>
          <button className="btn-ghost" onClick={onCancel}>Dismiss</button>
        </div>
      )}
    </div>
  );
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
  recordings,
  addRecording,
  deleteRecording,
  clearRecordings,
  spotifyToken,
  spotifyPlayer,
  timerSeek,
}: Props) {
  const track = annotation.track;
  const timeline = annotation.timeline;
  const atCap = timeline.length >= MAX_TIMELINE_ROWS;

  // Mic device selector
  const { devices: micDevices, selectedDeviceId: selectedMicId, setSelectedDeviceId: setSelectedMicId } = useAudioDevices();

  // Panel open state + imperatively open trigger (after recording saved)
  const [recordingsPanelOpen, setRecordingsPanelOpen] = useState(false);
  const [openPanelTrigger, setOpenPanelTrigger] = useState(0);

  // ── MARK THIS MOMENT ──────────────────────────────────────────────────────
  function handleMark() {
    if (!isActive) return;
    if (dictation.state.status !== 'idle') return;
    if (atCap) return;
    const wasRunning = isTimerRunning;
    timerPause();
    const timestamp = formatMSS(elapsedSeconds);
    setMarkEntryDraft({
      mode: 'new', timestamp, sectionType: '', narrative: '', narrativeRaw: '',
      tags: '', wasTimerRunning: wasRunning,
    });
    setPhase('mark_entry');
  }

  // ── EDIT ENTRY ────────────────────────────────────────────────────────────
  function handleEdit(entry: TimelineEntry) {
    if (!isActive) return;
    const wasRunning = isTimerRunning;
    timerPause();
    setMarkEntryDraft({
      mode: 'edit', entryId: entry.id, timestamp: entry.timestamp,
      sectionType: entry.sectionType, narrative: entry.narrative,
      narrativeRaw: entry.narrativeRaw, tags: entry.tags, wasTimerRunning: wasRunning,
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
    const reason = window.prompt('Reason for skipping (optional — press OK to skip without reason):', '');
    if (reason === null) return;
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
  const dictation = useDictationFlow(
    (transcript, timestamp, capturedWasRunning) => {
      setMarkEntryDraft({
        mode: 'new', timestamp, sectionType: '',
        narrative: transcript, narrativeRaw: transcript,
        tags: '', wasTimerRunning: capturedWasRunning,
        isDictated: true, dictationTranscript: transcript,
      });
      setPhase('mark_entry');
    },
    (blob, mimeType, timestamp, transcript) => {
      addRecording({
        id: crypto.randomUUID(),
        trackId: track.id,
        timestamp,
        createdAt: Date.now(),
        audioBlob: blob,
        audioUrl: URL.createObjectURL(blob),
        // Save even if transcript is empty — non-fatal transcript failure
        transcript,
        mimeType,
      });
    },
    () => setOpenPanelTrigger((n) => n + 1),
  );

  function handleDictateClick() {
    if (!isActive) return;
    if (atCap || dictation.state.status !== 'idle') return;
    const wasRunning = isTimerRunning;
    timerPause();
    dictation.begin(formatMSS(elapsedSeconds), wasRunning);
  }

  // ── USE TRANSCRIPT from recordings panel ──────────────────────────────────
  function handleUseTranscript(transcript: string, timestamp: string) {
    timerPause();
    setMarkEntryDraft({
      mode: 'new', timestamp, sectionType: '',
      narrative: transcript, narrativeRaw: transcript,
      tags: '', wasTimerRunning: isTimerRunning,
      isDictated: true, dictationTranscript: transcript,
    });
    setPhase('mark_entry');
  }

  // Timer display
  const isWarning = elapsedSeconds >= 20 * 60;
  const timerColor = !isTimerRunning ? 'var(--text-muted)' : isWarning ? 'var(--error)' : 'var(--amber)';

  // ── Spotify sync helpers ───────────────────────────────────────────────────
  function spotifyPlay() {
    if (spotifyPlayer?.isReady) spotifyPlayer.play().catch(() => {});
  }
  function spotifyPause() {
    if (spotifyPlayer?.isReady) spotifyPlayer.pause().catch(() => {});
  }
  function spotifySeek(seconds: number) {
    if (spotifyPlayer?.isReady) spotifyPlayer.seek(Math.max(0, seconds) * 1000).catch(() => {});
  }

  function toggleTimer() {
    if (isTimerRunning) {
      timerPause();
      spotifyPause();
    } else {
      timerStart();
      spotifyPlay();
    }
  }

  function seekRelative(deltaSecs: number) {
    const next = Math.max(0, elapsedSeconds + deltaSecs);
    timerSeek(next);
    if (isTimerRunning) timerStart();
    spotifySeek(next);
  }

  const displayEntries = [...timeline].reverse();

  // ── VIEW MODE ──────────────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState<'classic' | 'fullscreen'>('classic');
  const [fsTimelineOpen, setFsTimelineOpen] = useState(false);
  const [fsRecordingsOpen, setFsRecordingsOpen] = useState(false);

  // ── FULLSCREEN RENDER ──────────────────────────────────────────────────────
  if (viewMode === 'fullscreen') {
    const trackRecordingsFs = recordings.filter((r) => r.trackId === track.id);

    return (
      <div style={{
        position: 'fixed', inset: 0,
        background: 'var(--bg)',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
        fontFamily: 'var(--font-mono)',
        zIndex: 50,
      }}>
        {/* ── FS TOP BAR ── */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.625rem 1rem',
          background: 'var(--surface)',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0, gap: '1rem',
        }}>
          {/* Track info */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{
              fontFamily: 'var(--font-display)', fontStyle: 'italic',
              fontSize: '1rem', fontWeight: 600,
              color: 'var(--text)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              margin: 0,
            }}>
              {track.name}
            </p>
            <p style={{
              fontFamily: 'var(--font-mono)', fontSize: '0.72rem',
              color: 'var(--text-muted)', margin: 0,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {track.artist}
            </p>
          </div>

          {/* Elapsed time — large amber */}
          <button
            onClick={toggleTimer}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              fontFamily: 'var(--font-mono)', fontSize: '1.75rem', fontWeight: 700,
              color: timerColor, padding: 0, flexShrink: 0,
            }}
            title={isTimerRunning ? 'Pause' : 'Resume'}
          >
            {formatMSS(elapsedSeconds)}
          </button>

          {/* Right controls */}
          <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0, alignItems: 'center' }}>
            <button
              className="btn-ghost"
              onClick={() => setViewMode('classic')}
              style={{ fontSize: '0.72rem', letterSpacing: '0.05em', padding: '0.3rem 0.6rem' }}
            >
              ⊠ EXIT FULL
            </button>
            <button
              className="btn-ghost"
              onClick={() => setPhase('flow')}
              style={{ fontSize: '0.72rem', letterSpacing: '0.05em', padding: '0.3rem 0.6rem' }}
            >
              ⟩ FLOW
            </button>
            <button
              className="btn-primary"
              disabled={timeline.length === 0}
              onClick={handleDone}
              style={{ fontSize: '0.72rem', padding: '0.3rem 0.75rem' }}
            >
              DONE →
            </button>
          </div>
        </div>

        {/* ── FS WAVEFORM SCRUBBER ── */}
        <div style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
          <WaveformScrubber
            spotifyTrackId={track.spotifyId}
            spotifyToken={spotifyToken}
            elapsedSeconds={elapsedSeconds}
            durationSeconds={(annotation.track as any).durationSeconds ?? 300}
            onSeek={(secs) => {
              timerSeek(secs);
              if (isTimerRunning) timerStart();
              if (spotifyPlayer?.isReady) spotifyPlayer.seek(secs * 1000).catch(() => {});
            }}
          />
        </div>

        {/* ── FS SCROLLABLE BODY ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', paddingBottom: '0' }}>

          {/* Dictation overlay */}
          <DictationOverlay
            state={dictation.state}
            micStream={dictation.micStreamRef.current}
            micDevices={micDevices}
            selectedMicId={selectedMicId}
            setSelectedMicId={setSelectedMicId}
            onCancel={dictation.cancel}
            onStartRecording={dictation.startRecording}
            onStopRecording={dictation.stopRecording}
            onAccept={dictation.accept}
          />

          {/* ── FS TRANSPORT ROW ── */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            gap: '1.5rem', marginBottom: '1.25rem',
          }}>
            <button
              aria-label="Back 10 seconds"
              style={fsTransportBtn}
              onClick={() => seekRelative(-10)}
            >
              ⏮ −10s
            </button>
            <button
              aria-label={isTimerRunning ? 'Pause' : 'Play'}
              onClick={toggleTimer}
              style={{
                ...fsTransportBtn,
                minWidth: '68px', minHeight: '68px',
                fontSize: '1.75rem',
                background: 'var(--amber)', color: 'var(--bg)',
                border: 'none', borderRadius: '50%',
              }}
            >
              {isTimerRunning ? '⏸' : '▶'}
            </button>
            <button
              aria-label="Forward 10 seconds"
              style={fsTransportBtn}
              onClick={() => seekRelative(10)}
            >
              +10s ⏭
            </button>
          </div>

          {/* ── FS MIC METER — only when recording ── */}
          {dictation.state.status === 'recording' && dictation.micStreamRef.current && (
            <div style={{ marginBottom: '1.25rem' }}>
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', letterSpacing: '0.08em', marginBottom: '0.375rem' }}>
                MIC
              </p>
              <MicLevelMeter stream={dictation.micStreamRef.current} />
            </div>
          )}

          {/* ── FS TAG / MARK GRID ── */}
          <div style={{ marginBottom: '1rem' }}>
            <p style={{
              fontFamily: 'var(--font-mono)', fontSize: '0.65rem',
              color: 'var(--text-dim)', letterSpacing: '0.08em',
              textTransform: 'uppercase', marginBottom: '0.625rem',
            }}>
              MARK A MOMENT
            </p>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
              gap: '0.5rem',
            }}>
              <button
                onClick={handleMark}
                disabled={atCap || dictation.state.status !== 'idle'}
                style={{
                  minHeight: '44px',
                  background: atCap ? 'var(--surface)' : 'var(--amber)',
                  color: atCap ? 'var(--text-dim)' : 'var(--bg)',
                  border: '1px solid var(--border-active)',
                  borderRadius: 'var(--radius-pill)',
                  fontFamily: 'var(--font-mono)', fontSize: '0.8rem',
                  letterSpacing: '0.04em', cursor: atCap ? 'not-allowed' : 'pointer',
                  padding: '0.25rem 0.75rem',
                }}
                title={atCap ? 'Maximum 10 sections reached' : undefined}
              >
                ⏺ MARK
              </button>
              <button
                onClick={handleDictateClick}
                disabled={atCap || dictation.state.status !== 'idle'}
                style={{
                  minHeight: '44px',
                  background: 'var(--surface)',
                  border: '1px solid var(--border-active)',
                  borderRadius: 'var(--radius-pill)',
                  color: 'var(--text)',
                  fontFamily: 'var(--font-mono)', fontSize: '0.8rem',
                  letterSpacing: '0.04em', cursor: 'pointer',
                  padding: '0.25rem 0.75rem',
                }}
              >
                🎙 DICTATE
              </button>
            </div>
            {atCap && (
              <p style={{ color: 'var(--amber)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', marginTop: '0.5rem' }}>
                10/10 sections — edit or remove to add more
              </p>
            )}
          </div>
        </div>

        {/* ── FS TIMELINE DRAWER (above toolbar) ── */}
        {fsTimelineOpen && (
          <div style={{
            flexShrink: 0,
            background: 'var(--surface)',
            borderTop: '1px solid var(--border)',
            maxHeight: '45vh', overflowY: 'auto',
            padding: '0.75rem 1rem 1rem',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-dim)', letterSpacing: '0.06em' }}>
                TIMELINE — {timeline.length} entries
              </span>
              <button
                onClick={() => setFsTimelineOpen(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: '1rem' }}
              >
                ✕
              </button>
            </div>
            {displayEntries.length === 0 ? (
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                No entries yet.
              </p>
            ) : (
              displayEntries.map((entry) => (
                <div key={entry.id} className="timeline-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <span className="timestamp-label">{entry.timestamp}</span>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button className="icon-btn" onClick={() => { setFsTimelineOpen(false); handleEdit(entry); }} title="Edit">✎</button>
                      <button className="icon-btn icon-btn--danger" onClick={() => handleDelete(entry.id)} title="Delete">×</button>
                    </div>
                  </div>
                  <p className="timeline-section-type">{entry.sectionType}</p>
                  <p className="timeline-narrative">{entry.narrative}</p>
                  {entry.tags && <p className="timeline-tags">{entry.tags}</p>}
                  {entry.isDictated && <span className="dictated-badge">🎙 dictated</span>}
                </div>
              ))
            )}
          </div>
        )}

        {/* ── FS RECORDINGS DRAWER (above toolbar) ── */}
        {fsRecordingsOpen && (
          <div style={{
            flexShrink: 0,
            background: 'var(--surface)',
            borderTop: '1px solid var(--border)',
            maxHeight: '45vh', overflowY: 'auto',
            padding: '0.75rem 1rem 1rem',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-dim)', letterSpacing: '0.06em' }}>
                RECORDINGS — {trackRecordingsFs.length} for this track
              </span>
              <button
                onClick={() => setFsRecordingsOpen(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: '1rem' }}
              >
                ✕
              </button>
            </div>
            {trackRecordingsFs.length === 0 ? (
              <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-dim)', fontStyle: 'italic' }}>
                No recordings yet.
              </p>
            ) : (
              trackRecordingsFs.map((rec) => (
                <RecordingCard
                  key={rec.id}
                  rec={rec}
                  onDelete={deleteRecording}
                  onUseTranscript={(t, ts) => { setFsRecordingsOpen(false); handleUseTranscript(t, ts); }}
                  onUpdateTranscript={() => { /* transcript updates handled inside RecordingsPanel */ }}
                />
              ))
            )}
          </div>
        )}

        {/* ── FS FIXED BOTTOM TOOLBAR ── */}
        <div style={{
          flexShrink: 0,
          background: 'var(--surface)',
          borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '0.625rem 1rem',
          gap: '0.5rem',
        }}>
          {/* Left: Dictate */}
          <button
            className="btn-ghost"
            onClick={handleDictateClick}
            disabled={atCap || dictation.state.status !== 'idle'}
            style={{ fontSize: '0.78rem', minHeight: '44px', flex: 1 }}
          >
            🎙 DICTATE
          </button>

          {/* Centre: Recordings toggle */}
          <button
            className="btn-ghost"
            onClick={() => { setFsRecordingsOpen((v) => !v); setFsTimelineOpen(false); }}
            style={{ fontSize: '0.78rem', minHeight: '44px', flex: 1 }}
          >
            {fsRecordingsOpen ? '▾ ' : '▴ '}
            REC
            {trackRecordingsFs.length > 0 && ` (${trackRecordingsFs.length})`}
          </button>

          {/* Right: Timeline toggle */}
          <button
            className="btn-ghost"
            onClick={() => { setFsTimelineOpen((v) => !v); setFsRecordingsOpen(false); }}
            style={{ fontSize: '0.78rem', minHeight: '44px', flex: 1 }}
          >
            {fsTimelineOpen ? '▾ ' : '▴ '}
            TIMELINE ({timeline.length})
          </button>
        </div>

      </div>
    );
  }

  // ── CLASSIC RENDER ─────────────────────────────────────────────────────────
  return (
    <div className="phase-listening">
      {/* Sticky top bar */}
      <div className="listening-topbar">
        <div style={{ borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: '0.75rem' }}>
          <iframe
            src={`https://open.spotify.com/embed/track/${track.spotifyId}?utm_source=generator&theme=0`}
            width="100%" height="152" frameBorder="0"
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
            loading="lazy"
            title={`${track.artist} - ${track.name}`}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <p className="label" style={{ color: 'var(--amber)', margin: 0 }}>
            TRACK {track.id} — PART 1 · TIMELINE
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.25rem' }}>
            <button
              onClick={toggleTimer}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-mono)', fontSize: '1.5rem',
                color: timerColor, transition: 'color 200ms', padding: 0,
              }}
              title={isTimerRunning ? 'Click to pause' : 'Click to resume'}
            >
              {formatMSS(elapsedSeconds)}
              {isWarning && isTimerRunning && (
                <span style={{ fontSize: '0.75rem', marginLeft: '0.5rem' }}>⚠ 20 MIN</span>
              )}
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: atCap ? 'var(--amber)' : 'var(--text-dim)' }}>
                {timeline.length} / {MAX_TIMELINE_ROWS}
              </span>
              <span className="kbd-hint">M to mark</span>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="listening-main">
        {/* Dictation overlay */}
        <DictationOverlay
          state={dictation.state}
          micStream={dictation.micStreamRef.current}
          micDevices={micDevices}
          selectedMicId={selectedMicId}
          setSelectedMicId={setSelectedMicId}
          onCancel={dictation.cancel}
          onStartRecording={dictation.startRecording}
          onStopRecording={dictation.stopRecording}
          onAccept={dictation.accept}
        />

        {/* Mark + Dictate buttons */}
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
            <p style={{ textAlign: 'center', color: 'var(--amber)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', marginTop: '0.5rem' }}>
              10/10 sections — edit or remove to add more
            </p>
          )}
        </div>

        {/* Recordings panel */}
        <RecordingsPanel
          recordings={recordings}
          currentTrackId={track.id}
          isOpen={recordingsPanelOpen}
          onToggle={() => setRecordingsPanelOpen((v) => !v)}
          onDelete={deleteRecording}
          onDeleteAllTrack={(trackId) => {
            recordings
              .filter((r) => r.trackId === trackId)
              .forEach((r) => deleteRecording(r.id));
          }}
          onDeleteSession={clearRecordings}
          onUseTranscript={handleUseTranscript}
          forceOpen={openPanelTrigger > 0}
        />

        {/* Timeline entries */}
        <div style={{ padding: '0.5rem 1rem 9rem' }}>
          {displayEntries.length === 0 && (
            <p style={{
              textAlign: 'center', color: 'var(--text-dim)', fontFamily: 'var(--font-mono)',
              fontSize: '0.8125rem', marginTop: '1.5rem',
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
          <button className="btn-ghost" onClick={() => { timerPause(); setPhase('select'); }}>← Menu</button>
          <button className="btn-ghost btn-destructive" onClick={handleSkip}>SKIP THIS TRACK</button>
          <button className="btn-ghost" onClick={() => setPhase('flow')}>⟩ FLOW MODE</button>
          <button className="btn-ghost" onClick={() => setViewMode('fullscreen')}>⛶ FULL</button>
        </div>
        <button className="btn-primary" disabled={timeline.length === 0} onClick={handleDone}>
          DONE — PART 2 →
        </button>
      </div>
    </div>
  );
}

// ── Shared style object for fullscreen transport buttons ───────────────────
const fsTransportBtn: React.CSSProperties = {
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
