import { useState, useRef, useEffect, useCallback } from 'react';

const SPEECH_ERROR_MESSAGES: Record<string, string> = {
  'network': 'Network error — open the app on https://localhost:5173 (not http://).',
  'not-allowed': 'Microphone access denied. Click the 🔒 icon in the address bar.',
  'aborted': 'Recording was cancelled.',
  'audio-capture': 'No microphone found.',
  'service-not-allowed': 'Speech service not allowed. Make sure you are on https://.',
};

export interface UseDictationReturn {
  /** Partial + committed transcript being built in real time */
  liveTranscript: string;
  /** Committed final transcript only (no interim) — snapshot for saving */
  finalTranscript: string;
  /** True after 5 s of silence with no speech detected */
  noSpeechHint: boolean;
  /** Start SpeechRecognition against the provided mic stream */
  startDictation: (stream: MediaStream) => void;
  /** Stop SpeechRecognition gracefully */
  stopDictation: () => void;
  /** Reset all transcript state */
  reset: () => void;
  /** Error message if speech recognition fails fatally, or null */
  error: string | null;
}

export function useDictation(): UseDictationReturn {
  const [liveTranscript, setLiveTranscript] = useState('');
  const [finalTranscript, setFinalTranscript] = useState('');
  const [noSpeechHint, setNoSpeechHint] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<any>(null);
  const noSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mutable ref so onresult closure always reads latest value without re-creating handlers
  const finalTranscriptRef = useRef('');

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (noSpeechTimerRef.current) clearTimeout(noSpeechTimerRef.current);
      if (recognitionRef.current) {
        try { recognitionRef.current.stop(); } catch { /* ignore */ }
        recognitionRef.current = null;
      }
    };
  }, []);

  const reset = useCallback(() => {
    if (noSpeechTimerRef.current) { clearTimeout(noSpeechTimerRef.current); noSpeechTimerRef.current = null; }
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    finalTranscriptRef.current = '';
    setLiveTranscript('');
    setFinalTranscript('');
    setNoSpeechHint(false);
    setError(null);
  }, []);

  const stopDictation = useCallback(() => {
    if (noSpeechTimerRef.current) { clearTimeout(noSpeechTimerRef.current); noSpeechTimerRef.current = null; }
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
  }, []);

  const startDictation = useCallback((_stream: MediaStream) => {
    // Reset transcript state for a fresh session
    finalTranscriptRef.current = '';
    setLiveTranscript('');
    setFinalTranscript('');
    setNoSpeechHint(false);
    setError(null);

    const SpeechRecognitionCtor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      setError('Speech recognition not supported. Use Chrome or Edge.');
      return;
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';
    recognitionRef.current = recognition;

    // 5 s silence → show hint
    if (noSpeechTimerRef.current) clearTimeout(noSpeechTimerRef.current);
    noSpeechTimerRef.current = setTimeout(() => {
      // Only show hint if still running and nothing spoken yet
      if (!finalTranscriptRef.current) setNoSpeechHint(true);
    }, 5000);

    recognition.onresult = (event: any) => {
      let interim = '';
      let addedFinal = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          addedFinal += event.results[i][0].transcript + ' ';
        } else {
          interim += event.results[i][0].transcript;
        }
      }
      if (addedFinal) {
        finalTranscriptRef.current = (finalTranscriptRef.current + addedFinal).trimStart();
        setFinalTranscript(finalTranscriptRef.current.trim());
      }
      setLiveTranscript((finalTranscriptRef.current + interim).trim());
      // Speech detected — cancel the no-speech hint
      if (noSpeechTimerRef.current) { clearTimeout(noSpeechTimerRef.current); noSpeechTimerRef.current = null; }
      setNoSpeechHint(false);
    };

    recognition.onerror = (event: any) => {
      recognitionRef.current = null;
      if (event.error === 'no-speech') {
        // Non-fatal — audio is still being recorded; just show the hint
        setNoSpeechHint(true);
        return;
      }
      const msg = SPEECH_ERROR_MESSAGES[event.error as string] ?? `Recording error: ${event.error}`;
      setError(msg);
    };

    recognition.onend = () => {
      // SpeechRecognition ended naturally (timeout / browser limit) — keep final transcript
      recognitionRef.current = null;
    };

    recognition.start();
  }, []);

  return { liveTranscript, finalTranscript, noSpeechHint, startDictation, stopDictation, reset, error };
}
