// FIX #1: No useTimer here. elapsedSeconds + isTimerRunning come from App as props.
// FIX #8: Capture wasRunning BEFORE pause fires in dictation flow.
// FIX #9: SpeechRecognition cleanup on component unmount.
// FIX #10: getUserMedia pre-flight before SpeechRecognition — ensures Chrome grants
//          microphone access explicitly, fixing "Recording error: network".
import { useCallback, useState, useRef, useEffect, useMemo } from 'react';
import type {
  TrackAnnotation,
  Phase,
  MarkEntryDraft,
  TimelineEntry,
  RecordingEntry,
} from '../types';
import { MAX_TIMELINE_ROWS } from '../lib/schema';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useAudioDevices } from '../hooks/useAudioDevices';

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

function useDictation(
  onComplete: (transcript: string, timestamp: string, wasRunning: boolean) => void,
  onRecordingReady: (blob: Blob, mimeType: string, timestamp: string, transcript: string) => void,
  onOpenRecordingsPanel: () => void,
) {
  const [state, setState] = useState<DictationState>(INITIAL_DICTATION);
  const recognitionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const noSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isSupported =
    typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  // FIX #9: clean up on unmount
  useEffect(() => {
    return () => {
      if (noSpeechTimerRef.current) clearTimeout(noSpeechTimerRef.current);
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch { /* ignore */ }
        recognitionRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
        mediaRecorderRef.current = null;
      }
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    };
  }, []);

  function begin(capturedTimestamp: string, capturedWasRunning: boolean) {
    setState({ ...INITIAL_DICTATION, status: 'awaiting_manual_pause', capturedTimestamp, capturedWasRunning });
    if (noSpeechTimerRef.current) clearTimeout(noSpeechTimerRef.current);
  }

  async function startRecording() {
    if (!isSupported) {
      setState((p) => ({ ...p, status: 'error', error: 'Speech recognition not supported. Use Chrome or Edge.' }));
      return;
    }

    const capturedTs = state.capturedTimestamp;
    const savedDeviceId = localStorage.getItem('beatpulse_mic_device') ?? '';
    const audioConstraint: MediaTrackConstraints | boolean = savedDeviceId
      ? { deviceId: { exact: savedDeviceId } }
      : true;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
    } catch (err: unknown) {
      if (savedDeviceId && err instanceof DOMException && err.name === 'OverconstrainedError') {
        localStorage.removeItem('beatpulse_mic_device');
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (fallbackErr: unknown) {
          const isDenied = fallbackErr instanceof DOMException && fallbackErr.name === 'NotAllowedError';
          setState((p) => ({
            ...p, status: 'error',
            error: isDenied
              ? 'Microphone access denied. Click the 🔒 icon in the address bar and allow microphone access, then try again.'
              : 'Could not access the microphone. Make sure a microphone is connected.',
          }));
          return;
        }
      } else {
        const isDenied = err instanceof DOMException && err.name === 'NotAllowedError';
        setState((p) => ({
          ...p, status: 'error',
          error: isDenied
            ? 'Microphone access denied. Click the 🔒 icon in the address bar and allow microphone access, then try again.'
            : 'Could not access the microphone. Make sure a microphone is connected.',
        }));
        return;
      }
    }

    micStreamRef.current = stream;

    // MediaRecorder — parallel to SpeechRecognition
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
    const recorder = new MediaRecorder(stream, { mimeType });
    audioChunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data);
    };

    let finalTranscriptSnapshot = '';
    recorder.onstop = () => {
      // Show FINALIZING while blob is assembled (synchronous but gives visual feedback)
      setState((p) => ({ ...p, status: 'finalizing' }));
      const blob = new Blob(audioChunksRef.current, { type: mimeType });
      audioChunksRef.current = [];
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      // Save the recording regardless of whether a transcript was captured
      onRecordingReady(blob, mimeType, capturedTs, finalTranscriptSnapshot);
      // Show AUDIO SAVED for 2 s, then close overlay and open the panel
      setState((p) => ({ ...p, status: 'audio_saved' }));
      setTimeout(() => {
        setState(INITIAL_DICTATION);
        onOpenRecordingsPanel();
      }, 2000);
    };

    recorder.start();
    mediaRecorderRef.current = recorder;

    // SpeechRecognition — parallel
    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognitionRef.current = recognition;
    setState((p) => ({ ...p, status: 'recording', transcript: '', noSpeechHint: false }));

    // After 5 s of no speech, show a subtle mic hint
    if (noSpeechTimerRef.current) clearTimeout(noSpeechTimerRef.current);
    noSpeechTimerRef.current = setTimeout(() => {
      setState((p) => p.status === 'recording' && !p.transcript ? { ...p, noSpeechHint: true } : p);
    }, 5000);

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
      finalTranscriptSnapshot = finalTranscript.trim();
      // Speech detected — cancel the no-speech hint
      if (noSpeechTimerRef.current) { clearTimeout(noSpeechTimerRef.current); noSpeechTimerRef.current = null; }
      setState((p) => ({ ...p, transcript: (finalTranscript + interim).trim(), noSpeechHint: false }));
    };

    const speechErrorMessages: Record<string, string> = {
      'network': 'Network error — open the app on https://localhost:5173 (not http://).',
      'not-allowed': 'Microphone access denied. Click the 🔒 icon in the address bar.',
      'aborted': 'Recording was cancelled.',
      'audio-capture': 'No microphone found.',
      'service-not-allowed': 'Speech service not allowed. Make sure you are on https://.',
    };

    recognition.onerror = (event: any) => {
      recognitionRef.current = null;
      if (event.error === 'no-speech') {
        // Non-fatal — audio is still being recorded; just show the hint
        setState((p) => p.status === 'recording' ? { ...p, noSpeechHint: true } : p);
        return;
      }
      const msg = speechErrorMessages[event.error as string] ?? `Recording error: ${event.error}`;
      setState((p) => ({ ...p, status: 'error', error: msg }));
    };

    recognition.onend = () => {
      // SpeechRecognition ended (e.g. natural timeout) — keep recording, just note transcript
      setState((p) => {
        if (p.status === 'recording') {
          return { ...p, transcript: finalTranscript.trim() };
        }
        return p;
      });
      recognitionRef.current = null;
    };

    recognition.start();
  }

  function stopRecording() {
    if (noSpeechTimerRef.current) { clearTimeout(noSpeechTimerRef.current); noSpeechTimerRef.current = null; }
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    // Stop MediaRecorder last — its onstop fires finalizing → audio_saved → close
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
    }
    mediaRecorderRef.current = null;
  }

  function accept() {
    const { transcript, capturedTimestamp, capturedWasRunning } = state;
    onComplete(transcript, capturedTimestamp, capturedWasRunning);
    setState(INITIAL_DICTATION);
  }

  function cancel() {
    if (noSpeechTimerRef.current) { clearTimeout(noSpeechTimerRef.current); noSpeechTimerRef.current = null; }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      // Detach onstop so cancellation doesn't save the recording
      mediaRecorderRef.current.onstop = null;
      try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
    }
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    setState(INITIAL_DICTATION);
  }

  return { state, isSupported, begin, startRecording, stopRecording, accept, cancel, micStreamRef };
}

// ── Mic level meter ─────────────────────────────────────────────────────────
// Reads RMS from an AnalyserNode on the mic stream and renders 20 bars.
function MicLevelMeter({ stream }: { stream: MediaStream | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const bufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  useEffect(() => {
    if (!stream) return;

    const audioCtx = new AudioContext();
    ctxRef.current = audioCtx;
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyserRef.current = analyser;
    bufRef.current = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;

    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    const BAR_COUNT = 20;
    const INTERVAL = 1000 / 15; // ~15 fps
    let last = 0;

    function draw(now: number) {
      if (now - last < INTERVAL) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      last = now;

      const canvas = canvasRef.current;
      if (!canvas || !analyserRef.current || !bufRef.current) {
        rafRef.current = requestAnimationFrame(draw);
        return;
      }
      analyserRef.current.getByteFrequencyData(bufRef.current);

      const step = Math.floor(bufRef.current.length / BAR_COUNT);
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) { rafRef.current = requestAnimationFrame(draw); return; }

      const W = canvas.width;
      const H = canvas.height;
      ctx2d.clearRect(0, 0, W, H);

      for (let i = 0; i < BAR_COUNT; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += bufRef.current[i * step + j];
        const avg = sum / step / 255;
        const barH = Math.max(2, avg * H);
        const x = (i / BAR_COUNT) * W;
        const barW = W / BAR_COUNT - 1;
        ctx2d.fillStyle = avg > 0.05 ? 'rgba(8,32,48,0.8)' : 'rgba(8,32,48,0.2)';
        ctx2d.fillRect(x, H - barH, barW, barH);
      }

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      audioCtx.close();
      ctxRef.current = null;
      analyserRef.current = null;
      bufRef.current = null;
    };
  }, [stream]);

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

// ── Static waveform from blob ────────────────────────────────────────────────
// Decodes the audio blob and renders a 60-bar SVG waveform.
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

// ── Save / discard confirm dialog ────────────────────────────────────────────
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

// ── Recording card ───────────────────────────────────────────────────────────
interface RecordingCardProps {
  rec: RecordingEntry;
  onDelete: (id: string) => void;
  onUseTranscript: (transcript: string, timestamp: string) => void;
  onUpdateTranscript: (id: string, transcript: string) => void;
}

function RecordingCard({ rec, onDelete, onUseTranscript, onUpdateTranscript }: RecordingCardProps) {
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

// ── Recordings panel ─────────────────────────────────────────────────────────
interface RecordingsPanelProps {
  recordings: RecordingEntry[];
  trackId: number;
  onDelete: (id: string) => void;
  onDeleteAllTrack: () => void;
  onDeleteSession: () => void;
  onUseTranscript: (transcript: string, timestamp: string) => void;
  onUpdateTranscript: (id: string, transcript: string) => void;
  /** When true, the panel opens imperatively (e.g. after a recording is saved). */
  forceOpen?: boolean;
}

function RecordingsPanel({
  recordings, trackId, onDelete, onDeleteAllTrack, onDeleteSession,
  onUseTranscript, onUpdateTranscript, forceOpen,
}: RecordingsPanelProps) {
  const [open, setOpen] = useState(false);

  // Open panel when requested imperatively (e.g. after recording saved)
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  const [dialog, setDialog] = useState<null | {
    message: string;
    onSave: () => void;
    onDiscard: () => void;
  }>(null);

  const trackRecordings = recordings.filter((r) => r.trackId === trackId);
  const sessionCount = recordings.length;

  // Auto-expand when a new recording is added
  const prevCountRef = useRef(trackRecordings.length);
  useEffect(() => {
    if (trackRecordings.length > prevCountRef.current) {
      setOpen(true);
    }
    prevCountRef.current = trackRecordings.length;
  }, [trackRecordings.length]);

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
      // Audio file
      const audioHandle = await dirHandle.getFileHandle(`${base}.${ext}`, { create: true });
      const audioWriter = await audioHandle.createWritable();
      await audioWriter.write(rec.audioBlob);
      await audioWriter.close();
      // Transcript sidecar
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
    const rec = recordings.find((r) => r.id === id);
    if (!rec) return;
    promptDelete(
      'Save this recording to your computer before deleting?',
      [rec],
      () => onDelete(id),
    );
  }

  function handleDeleteAllTrack() {
    if (trackRecordings.length === 0) return;
    promptDelete(
      `Save ${trackRecordings.length} recording(s) for this track before deleting?`,
      trackRecordings,
      onDeleteAllTrack,
    );
  }

  function handleDeleteSession() {
    if (recordings.length === 0) return;
    promptDelete(
      `Save all ${recordings.length} session recording(s) before deleting?`,
      recordings,
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
          onClick={() => setOpen((v) => !v)}
          className="accordion-header"
          style={{ width: '100%', marginBottom: open ? '0.5rem' : 0 }}
        >
          <span className="label" style={{ flex: 1, textAlign: 'left', color: 'var(--amber)' }}>
            RECORDINGS ({trackRecordings.length})
          </span>
          <span style={{ color: 'var(--text-dim)', fontSize: '0.75rem' }}>{open ? '▲' : '▼'}</span>
        </button>

        {open && (
          <div>
            {/* Session-only notice — shown once, subtly */}
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
                onUpdateTranscript={onUpdateTranscript}
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
}: Props) {
  const track = annotation.track;
  const timeline = annotation.timeline;
  const atCap = timeline.length >= MAX_TIMELINE_ROWS;

  // Mic device selector
  const { devices: micDevices, selectedDeviceId: selectedMicId, setSelectedDeviceId: setSelectedMicId } = useAudioDevices();

  // Used to imperatively open the recordings panel after a recording is saved
  const [openPanelTrigger, setOpenPanelTrigger] = useState(0);

  // Recording transcripts can be updated after Whisper
  const [transcriptOverrides, setTranscriptOverrides] = useState<Record<string, string>>({});

  const handleUpdateTranscript = useCallback((id: string, text: string) => {
    setTranscriptOverrides((prev) => ({ ...prev, [id]: text }));
  }, []);

  // Merge transcript overrides into recordings for display
  const enrichedRecordings = useMemo(
    () => recordings.map((r) => transcriptOverrides[r.id] !== undefined
      ? { ...r, transcript: transcriptOverrides[r.id] }
      : r
    ),
    [recordings, transcriptOverrides],
  );

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
  const dictation = useDictation(
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

  function toggleTimer() {
    if (isTimerRunning) timerPause();
    else timerStart();
  }

  const displayEntries = [...timeline].reverse();

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
        {dictation.state.status !== 'idle' && (
          <div className="dictation-overlay">
            {dictation.state.status === 'awaiting_manual_pause' && (
              <div className="dictation-card">
                <p className="label" style={{ color: 'var(--amber)', marginBottom: '0.75rem' }}>🎙 DICTATE</p>
                <p style={{ color: 'var(--text)', marginBottom: '0.75rem', lineHeight: 1.6 }}>
                  Spotify can't be paused automatically — please pause your playback now,
                  then press <strong>Start Recording</strong>.
                </p>
                <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', color: 'var(--text-muted)', marginBottom: '1.25rem' }}>
                  Timestamp captured: {dictation.state.capturedTimestamp}
                </p>

                {/* Mic selector */}
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
                  <button className="btn-ghost" onClick={dictation.cancel}>Cancel</button>
                  <button className="btn-primary" onClick={dictation.startRecording}>● Start Recording</button>
                </div>
              </div>
            )}

            {dictation.state.status === 'recording' && (
              <div className="dictation-card">
                <p className="label" style={{ color: 'var(--error)', marginBottom: '0.5rem' }}>● RECORDING…</p>
                {/* Live mic level meter */}
                <MicLevelMeter stream={dictation.micStreamRef.current} />
                {/* Live transcript */}
                <p style={{
                  fontFamily: 'var(--font-mono)', fontSize: '0.68rem',
                  color: 'var(--text-dim)', letterSpacing: '0.06em',
                  marginBottom: '0.25rem',
                }}>
                  LIVE TRANSCRIPT (BROWSER SPEECH RECOGNITION)
                </p>
                <p style={{
                  color: dictation.state.transcript ? 'var(--text)' : 'var(--text-muted)',
                  minHeight: '3rem', fontFamily: 'var(--font-serif)', lineHeight: 1.6, marginBottom: '0.5rem',
                }}>
                  {dictation.state.transcript || 'Listening…'}
                </p>
                {dictation.state.noSpeechHint && !dictation.state.transcript && (
                  <p style={{
                    fontFamily: 'var(--font-mono)', fontSize: '0.75rem',
                    color: 'var(--text-dim)', fontStyle: 'italic', marginBottom: '0.75rem',
                  }}>
                    Speak clearly into your microphone…
                  </p>
                )}
                <button className="btn-primary" onClick={dictation.stopRecording}>■ Stop Recording</button>
              </div>
            )}

            {dictation.state.status === 'finalizing' && (
              <div className="dictation-card">
                <p className="label" style={{ color: 'var(--amber)', marginBottom: '0.75rem' }}>⏳ FINALIZING RECORDING…</p>
              </div>
            )}

            {dictation.state.status === 'audio_saved' && (
              <div className="dictation-card">
                <p className="label" style={{ color: 'var(--success)', marginBottom: '0.75rem' }}>AUDIO SAVED ✓</p>
                {!dictation.state.transcript && (
                  <p style={{
                    fontFamily: 'var(--font-mono)', fontSize: '0.8rem',
                    color: 'var(--text-muted)', fontStyle: 'italic',
                  }}>
                    Audio saved — no transcript captured
                  </p>
                )}
              </div>
            )}

            {dictation.state.status === 'done' && (
              <div className="dictation-card">
                <p className="label" style={{ color: 'var(--success)', marginBottom: '0.75rem' }}>✓ TRANSCRIPT READY</p>
                <p style={{
                  color: 'var(--text)', fontFamily: 'var(--font-serif)', lineHeight: 1.6, marginBottom: '1rem',
                }}>
                  {dictation.state.transcript || <span style={{ color: 'var(--text-muted)' }}>Audio saved — no transcript captured</span>}
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
                <p className="label" style={{ color: 'var(--error)', marginBottom: '0.75rem' }}>DICTATION ERROR</p>
                <p style={{ color: 'var(--text-muted)', marginBottom: '1rem' }}>{dictation.state.error}</p>
                <button className="btn-ghost" onClick={dictation.cancel}>Dismiss</button>
              </div>
            )}
          </div>
        )}

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
          recordings={enrichedRecordings}
          trackId={track.id}
          onDelete={deleteRecording}
          onDeleteAllTrack={() => {
            enrichedRecordings
              .filter((r) => r.trackId === track.id)
              .forEach((r) => deleteRecording(r.id));
          }}
          onDeleteSession={clearRecordings}
          onUseTranscript={handleUseTranscript}
          onUpdateTranscript={handleUpdateTranscript}
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
        </div>
        <button className="btn-primary" disabled={timeline.length === 0} onClick={handleDone}>
          DONE — PART 2 →
        </button>
      </div>
    </div>
  );
}
