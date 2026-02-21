import { useState, useRef, useEffect, useCallback } from 'react';

export type AudioRecorderStatus = 'idle' | 'recording' | 'finalizing';

interface UseAudioRecorderOptions {
  /** Called once the blob is assembled and the mic is released. */
  onRecordingReady: (blob: Blob, mimeType: string) => void;
}

interface UseAudioRecorderReturn {
  micStream: MediaStream | null;
  status: AudioRecorderStatus;
  startRecording: (audioConstraint?: MediaTrackConstraints | boolean) => Promise<{ stream: MediaStream } | { error: string }>;
  stopRecording: () => void;
  cancelRecording: () => void;
}

export function useAudioRecorder({ onRecordingReady }: UseAudioRecorderOptions): UseAudioRecorderReturn {
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState<AudioRecorderStatus>('idle');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);

  // Stable ref to the callback so the onstop closure never goes stale
  const onRecordingReadyRef = useRef(onRecordingReady);
  useEffect(() => { onRecordingReadyRef.current = onRecordingReady; }, [onRecordingReady]);

  // Release mic tracks and clear internal refs
  function releaseMic() {
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    setMicStream(null);
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        // Detach onstop so cancel on unmount never fires the callback
        mediaRecorderRef.current.onstop = null;
        try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
        mediaRecorderRef.current = null;
      }
      audioChunksRef.current = [];
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    };
  }, []);

  const startRecording = useCallback(async (
    audioConstraint: MediaTrackConstraints | boolean = true,
  ): Promise<{ stream: MediaStream } | { error: string }> => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
    } catch (err) {
      if (
        audioConstraint !== true &&
        err instanceof DOMException &&
        err.name === 'OverconstrainedError'
      ) {
        // Saved device no longer available — fall back to default mic
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (fallbackErr) {
          const isDenied =
            fallbackErr instanceof DOMException && fallbackErr.name === 'NotAllowedError';
          return {
            error: isDenied
              ? 'Microphone access denied. Click the 🔒 icon in the address bar and allow microphone access, then try again.'
              : 'Could not access the microphone. Make sure a microphone is connected.',
          };
        }
      } else {
        const isDenied = err instanceof DOMException && err.name === 'NotAllowedError';
        return {
          error: isDenied
            ? 'Microphone access denied. Click the 🔒 icon in the address bar and allow microphone access, then try again.'
            : 'Could not access the microphone. Make sure a microphone is connected.',
        };
      }
    }

    micStreamRef.current = stream;
    setMicStream(stream);

    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';
    const recorder = new MediaRecorder(stream, { mimeType });
    audioChunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data);
    };

    recorder.onstop = () => {
      setStatus('finalizing');
      const blob = new Blob(audioChunksRef.current, { type: mimeType });
      audioChunksRef.current = [];
      releaseMic();
      onRecordingReadyRef.current(blob, mimeType);
      setStatus('idle');
    };

    recorder.start();
    mediaRecorderRef.current = recorder;
    setStatus('recording');

    return { stream };
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
    }
    mediaRecorderRef.current = null;
  }, []);

  const cancelRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      // Detach onstop so cancellation never fires the callback
      mediaRecorderRef.current.onstop = null;
      try { mediaRecorderRef.current.stop(); } catch { /* ignore */ }
    }
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    releaseMic();
    setStatus('idle');
  }, []);

  return { micStream, status, startRecording, stopRecording, cancelRecording };
}
