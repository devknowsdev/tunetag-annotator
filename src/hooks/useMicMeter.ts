import { useEffect, useRef, useState } from 'react';

const BAR_COUNT = 20;
const INTERVAL = 1000 / 15; // ~15 fps

/**
 * Measures microphone volume from a MediaStream using Web Audio API.
 * Returns `barLevels`: 20 normalised values (0–1) updated at ~15 fps.
 * Cleans up the AudioContext when stream becomes null or on unmount.
 */
export function useMicMeter(stream: MediaStream | null): number[] {
  const [barLevels, setBarLevels] = useState<number[]>(Array(BAR_COUNT).fill(0));

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const bufRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!stream) {
      setBarLevels(Array(BAR_COUNT).fill(0));
      return;
    }

    const audioCtx = new AudioContext();
    audioCtxRef.current = audioCtx;

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyserRef.current = analyser;
    bufRef.current = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;

    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);

    let last = 0;

    function tick(now: number) {
      if (now - last >= INTERVAL) {
        last = now;
        const analyserNode = analyserRef.current;
        const buf = bufRef.current;
        if (analyserNode && buf) {
          analyserNode.getByteFrequencyData(buf);
          const step = Math.floor(buf.length / BAR_COUNT);
          const levels: number[] = [];
          for (let i = 0; i < BAR_COUNT; i++) {
            let sum = 0;
            for (let j = 0; j < step; j++) sum += buf[i * step + j];
            levels.push(sum / step / 255);
          }
          setBarLevels(levels);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      source.disconnect();
      void audioCtx.close();
      audioCtxRef.current = null;
      analyserRef.current = null;
      bufRef.current = null;
    };
  }, [stream]);

  return barLevels;
}
