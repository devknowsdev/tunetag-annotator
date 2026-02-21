import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { RecordingEntry } from '../types';

// ── Whisper transcription ────────────────────────────────────────────────────
const OPENAI_KEY_STORAGE = 'openai_api_key';

async function transcribeWithWhisper(blob: Blob, mimeType: string, apiKey: string): Promise<string> {
  const ext = mimeType.includes('ogg') ? 'ogg' : 'webm';
  const formData = new FormData();
  formData.append('file', new File([blob], `recording.${ext}`, { type: mimeType }));
  formData.append('model', 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any)?.error?.message ?? `HTTP ${res.status}`);
  }
  const json = await res.json() as { text: string };
  return json.text;
}

// ── Save / Discard confirm dialog ────────────────────────────────────────────
interface SaveDiscardDialogProps {
  message: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

function SaveDiscardDialog({ message, onSave, onDiscard, onCancel }: SaveDiscardDialogProps) {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 200,
      background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '1rem',
    }}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border-active)',
        borderRadius: 'var(--radius)', padding: '1.5rem', maxWidth: '360px', width: '100%',
      }}>
        <p className="label" style={{ color: 'var(--amber)', marginBottom: '0.75rem' }}>UNSAVED RECORDING</p>
        <p style={{ color: 'var(--text)', marginBottom: '1.25rem', fontSize: '0.9rem', lineHeight: 1.5 }}>{message}</p>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button className="btn-ghost btn-small" onClick={onCancel}>Cancel</button>
          <button className="btn-ghost btn-small btn-destructive" onClick={onDiscard}>Discard</button>
          <button className="btn-primary btn-small" onClick={onSave}>↓ Save first</button>
        </div>
      </div>
    </div>
  );
}

// ── Static waveform from blob ────────────────────────────────────────────────
function RecordingWaveform({ blob }: { blob: Blob }) {
  const [bars, setBars] = useState<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const arrayBuf = await blob.arrayBuffer();
        const audioCtx = new AudioContext();
        const decoded = await audioCtx.decodeAudioData(arrayBuf);
        await audioCtx.close();
        if (cancelled) return;

        const channel = decoded.getChannelData(0);
        const BAR_COUNT = 60;
        const step = Math.floor(channel.length / BAR_COUNT);
        const result: number[] = [];
        for (let i = 0; i < BAR_COUNT; i++) {
          let rms = 0;
          for (let j = 0; j < step; j++) {
            const v = channel[i * step + j] ?? 0;
            rms += v * v;
          }
          result.push(Math.sqrt(rms / step));
        }
        const max = Math.max(...result, 0.001);
        setBars(result.map((v) => v / max));
      } catch {
        // audio decode failed — no waveform shown
      }
    })();
    return () => { cancelled = true; };
  }, [blob]);

  if (bars.length === 0) return null;

  const W = 300;
  const H = 40;
  const barW = W / bars.length - 0.5;

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ display: 'block', height: '40px', marginBottom: '0.5rem' }}
    >
      {bars.map((v, i) => {
        const barH = Math.max(2, v * H);
        return (
          <rect
            key={i}
            x={i * (barW + 0.5)}
            y={(H - barH) / 2}
            width={barW}
            height={barH}
            rx={1}
            fill="rgba(8,32,48,0.6)"
          />
        );
      })}
    </svg>
  );
}

// ── Recording card ────────────────────────────────────────────────────────────
export interface RecordingCardProps {
  rec: RecordingEntry;
  onDelete: (id: string) => void;
  onUseTranscript: (transcript: string, timestamp: string) => void;
  onUpdateTranscript: (id: string, transcript: string) => void;
}

export function RecordingCard({ rec, onDelete, onUseTranscript, onUpdateTranscript }: RecordingCardProps) {
  const [whisperState, setWhisperState] = useState<'idle' | 'key_prompt' | 'loading' | 'error'>('idle');
  const [whisperError, setWhisperError] = useState('');
  const [keyInput, setKeyInput] = useState('');

  function handleDownload() {
    const ext = rec.mimeType.includes('ogg') ? 'ogg' : 'webm';
    const a = document.createElement('a');
    a.href = rec.audioUrl;
    a.download = `${rec.timestamp.replace(':', '-')}_${rec.id.slice(0, 6)}.${ext}`;
    a.click();
  }

  async function handleTranscribe() {
    const storedKey = sessionStorage.getItem(OPENAI_KEY_STORAGE) ?? '';
    if (!storedKey) {
      setWhisperState('key_prompt');
      return;
    }
    await runWhisper(storedKey);
  }

  async function runWhisper(key: string) {
    setWhisperState('loading');
    setWhisperError('');
    try {
      const text = await transcribeWithWhisper(rec.audioBlob, rec.mimeType, key);
      onUpdateTranscript(rec.id, text);
      setWhisperState('idle');
    } catch (e: unknown) {
      setWhisperError(e instanceof Error ? e.message : 'Transcription failed.');
      setWhisperState('error');
    }
  }

  function handleKeyConfirm() {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    sessionStorage.setItem(OPENAI_KEY_STORAGE, trimmed);
    setKeyInput('');
    runWhisper(trimmed);
  }

  return (
    <div className="recording-card">
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <span className="timestamp-label">🎙 {rec.timestamp}</span>
        <div style={{ display: 'flex', gap: '0.375rem' }}>
          {rec.transcript && (
            <button
              className="btn-ghost btn-small"
              onClick={() => onUseTranscript(rec.transcript, rec.timestamp)}
              title="Send transcript to mark entry"
            >
              USE TRANSCRIPT
            </button>
          )}
          <button className="btn-ghost btn-small" onClick={handleDownload} title="Download audio">↓</button>
          <button className="icon-btn icon-btn--danger" onClick={() => onDelete(rec.id)} title="Delete recording">×</button>
        </div>
      </div>

      {/* Waveform */}
      <RecordingWaveform blob={rec.audioBlob} />

      {/* Audio player */}
      <audio
        controls
        src={rec.audioUrl}
        style={{ width: '100%', height: '36px', marginBottom: '0.5rem' }}
      />

      {/* Transcript */}
      {rec.transcript ? (
        <p style={{
          fontFamily: 'var(--font-serif)', fontSize: '0.85rem',
          color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '0.5rem',
        }}>
          {rec.transcript}
        </p>
      ) : (
        <p style={{
          fontFamily: 'var(--font-mono)', fontSize: '0.75rem',
          color: 'var(--text-dim)', marginBottom: '0.5rem', fontStyle: 'italic',
        }}>
          No transcript captured — audio saved
        </p>
      )}

      {/* Whisper transcription */}
      {whisperState === 'idle' && (
        <button
          className="btn-ghost btn-small"
          style={{ fontSize: '0.7rem', marginTop: '0.25rem' }}
          onClick={handleTranscribe}
        >
          ✦ Transcribe (Whisper)
        </button>
      )}
      {whisperState === 'key_prompt' && (
        <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.375rem', alignItems: 'center' }}>
          <input
            type="password"
            className="text-input"
            placeholder="OpenAI API key (sk-…)"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleKeyConfirm(); }}
            style={{ fontSize: '0.8rem', padding: '0.375rem 0.5rem' }}
            autoFocus
          />
          <button className="btn-primary btn-small" onClick={handleKeyConfirm}>→</button>
          <button className="btn-ghost btn-small" onClick={() => setWhisperState('idle')}>✕</button>
        </div>
      )}
      {whisperState === 'loading' && (
        <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--text-dim)', marginTop: '0.25rem' }}>
          Transcribing…
        </p>
      )}
      {whisperState === 'error' && (
        <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.7rem', color: 'var(--error)', marginTop: '0.25rem' }}>
          {whisperError} — <button className="btn-link" style={{ fontSize: '0.7rem' }} onClick={() => setWhisperState('idle')}>dismiss</button>
        </p>
      )}
    </div>
  );
}

// ── RecordingsPanel ───────────────────────────────────────────────────────────
export interface RecordingsPanelProps {
  recordings: RecordingEntry[];
  isOpen: boolean;
  onToggle: () => void;
  onDelete: (id: string) => void;
  onDeleteAllTrack: (trackId: number) => void;
  onDeleteSession: () => void;
  onUseTranscript: (transcript: string, timestamp: string) => void;
  currentTrackId: number;
  /** When true, imperatively opens the panel (e.g. after a recording is saved). */
  forceOpen?: boolean;
}

export function RecordingsPanel({
  recordings,
  isOpen,
  onToggle,
  onDelete,
  onDeleteAllTrack,
  onDeleteSession,
  onUseTranscript,
  currentTrackId,
  forceOpen,
}: RecordingsPanelProps) {
  // Transcript overrides (Whisper results applied after the fact)
  const [transcriptOverrides, setTranscriptOverrides] = useState<Record<string, string>>({});

  const handleUpdateTranscript = useCallback((id: string, text: string) => {
    setTranscriptOverrides((prev) => ({ ...prev, [id]: text }));
  }, []);

  const enrichedRecordings = useMemo(
    () => recordings.map((r) =>
      transcriptOverrides[r.id] !== undefined ? { ...r, transcript: transcriptOverrides[r.id] } : r
    ),
    [recordings, transcriptOverrides],
  );

  const trackRecordings = enrichedRecordings.filter((r) => r.trackId === currentTrackId);
  const sessionCount = recordings.length;

  const [dialog, setDialog] = useState<null | {
    message: string;
    onSave: () => void;
    onDiscard: () => void;
  }>(null);

  // Imperatively open when forceOpen fires (e.g. after recording saved)
  const prevForceOpenRef = useRef(forceOpen);
  useEffect(() => {
    if (forceOpen && forceOpen !== prevForceOpenRef.current && !isOpen) {
      onToggle();
    }
    prevForceOpenRef.current = forceOpen;
  }, [forceOpen, isOpen, onToggle]);

  // Auto-expand when a new recording is added for this track
  const prevTrackCountRef = useRef(trackRecordings.length);
  useEffect(() => {
    if (trackRecordings.length > prevTrackCountRef.current && !isOpen) {
      onToggle();
    }
    prevTrackCountRef.current = trackRecordings.length;
  }, [trackRecordings.length, isOpen, onToggle]);

  // Warn on page unload if there are unsaved recordings
  useEffect(() => {
    if (recordings.length === 0) return;
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = 'You have unsaved recordings — they will be lost if you leave.';
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [recordings.length]);

  async function saveToFolder(recsToSave: RecordingEntry[]) {
    if (!('showDirectoryPicker' in window)) {
      alert('Folder save requires Chrome or Edge.');
      return;
    }
    let dirHandle: FileSystemDirectoryHandle;
    try {
      dirHandle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
    } catch {
      return; // user cancelled
    }
    for (const rec of recsToSave) {
      const ext = rec.mimeType.includes('ogg') ? 'ogg' : 'webm';
      const base = `${rec.timestamp.replace(':', '-')}_${rec.id.slice(0, 6)}`;
      const audioHandle = await dirHandle.getFileHandle(`${base}.${ext}`, { create: true });
      const audioWriter = await audioHandle.createWritable();
      await audioWriter.write(rec.audioBlob);
      await audioWriter.close();
      if (rec.transcript) {
        const txtHandle = await dirHandle.getFileHandle(`${base}.txt`, { create: true });
        const txtWriter = await txtHandle.createWritable();
        await txtWriter.write(rec.transcript);
        await txtWriter.close();
      }
    }
  }

  function promptDelete(message: string, recsToSave: RecordingEntry[], onDiscard: () => void) {
    setDialog({
      message,
      onSave: async () => {
        setDialog(null);
        await saveToFolder(recsToSave);
        onDiscard();
      },
      onDiscard: () => {
        setDialog(null);
        onDiscard();
      },
    });
  }

  function handleDeleteSingle(id: string) {
    const rec = enrichedRecordings.find((r) => r.id === id);
    if (!rec) return;
    promptDelete('Save this recording to your computer before deleting?', [rec], () => onDelete(id));
  }

  function handleDeleteAllTrack() {
    if (trackRecordings.length === 0) return;
    promptDelete(
      `Save ${trackRecordings.length} recording(s) for this track before deleting?`,
      trackRecordings,
      () => onDeleteAllTrack(currentTrackId),
    );
  }

  function handleDeleteSession() {
    if (recordings.length === 0) return;
    promptDelete(
      `Save all ${recordings.length} session recording(s) before deleting?`,
      enrichedRecordings,
      onDeleteSession,
    );
  }

  if (trackRecordings.length === 0) return null;

  return (
    <>
      {dialog && (
        <SaveDiscardDialog
          message={dialog.message}
          onSave={dialog.onSave}
          onDiscard={dialog.onDiscard}
          onCancel={() => setDialog(null)}
        />
      )}

      <div style={{ padding: '0 1rem', marginBottom: '0.5rem' }}>
        {/* Collapsible header */}
        <button
          onClick={onToggle}
          className="accordion-header"
          style={{ width: '100%', marginBottom: isOpen ? '0.5rem' : 0 }}
        >
          <span className="label" style={{ flex: 1, textAlign: 'left', color: 'var(--amber)' }}>
            RECORDINGS ({trackRecordings.length})
          </span>
          <span style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>{isOpen ? '▲' : '▼'}</span>
        </button>

        {isOpen && (
          <div>
            {/* Session-only notice */}
            <p style={{
              fontFamily: 'var(--font-mono)', fontSize: '0.7rem',
              color: 'var(--text-dim)', marginBottom: '0.75rem',
              fontStyle: 'italic', lineHeight: 1.4,
            }}>
              Recordings are session-only and will be lost on page refresh unless saved.
            </p>

            {/* Recording cards */}
            {trackRecordings.map((rec) => (
              <RecordingCard
                key={rec.id}
                rec={rec}
                onDelete={handleDeleteSingle}
                onUseTranscript={onUseTranscript}
                onUpdateTranscript={handleUpdateTranscript}
              />
            ))}

            {/* Bulk actions */}
            <div style={{ display: 'flex', gap: '0.375rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
              <button
                className="btn-ghost btn-small"
                onClick={() => saveToFolder(trackRecordings)}
                title={'showDirectoryPicker' in window ? undefined : 'Requires Chrome or Edge'}
              >
                ↓ Save to folder
              </button>
              <button className="btn-ghost btn-small btn-destructive" onClick={handleDeleteAllTrack}>
                Delete this track
              </button>
              {sessionCount > trackRecordings.length && (
                <button className="btn-ghost btn-small btn-destructive" onClick={handleDeleteSession}>
                  Delete session ({sessionCount})
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
