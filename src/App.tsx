// FIX #1: Single timer source — useTimer lives ONLY here, props thread down.
// FIX #2: resumeSavedState() returns snapshot; timer restore uses it directly.
import { useState, useEffect, useCallback, useRef } from 'react';
import type { TemplateState, RecordingEntry } from './types';
import { useAnnotationState } from './hooks/useAnnotationState';
import { useTimer } from './hooks/useTimer';
import SetupScreen from './components/SetupScreen';
import { PhaseSelect } from './components/PhaseSelect';
import { PhaseReady } from './components/PhaseReady';
import { PhaseListening } from './components/PhaseListening';
import { PhaseMarkEntry } from './components/PhaseMarkEntry';
import { PhaseGlobal } from './components/PhaseGlobal';
import { PhaseReview } from './components/PhaseReview';
import { PhasePromptsTags } from './components/PhasePromptsTags';
import { PhaseFlow } from './components/PhaseFlow';
import { HowToUse } from './components/HowToUse';
import { SpotifyPlayer } from './components/SpotifyPlayer';
import { useSpotifyPlayer } from './hooks/useSpotifyPlayer';
import { handleSpotifyCallback, getStoredToken, initiateSpotifyLogin } from './lib/spotifyAuth';
import { playTrack, transferPlayback } from './lib/spotifyApi';

function App() {
  const [showHelp, setShowHelp] = useState(false);
  // ── Template loading ───────────────────────────────────────────────────────
  const [templateState, setTemplateState] = useState<TemplateState>({ status: 'loading' });

  function loadTemplate() {
    setTemplateState({ status: 'loading' });
    fetch('/template.xlsx')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buffer) => setTemplateState({ status: 'ready', buffer }))
      .catch((err) =>
        setTemplateState({ status: 'failed', error: err.message ?? 'Unknown error' })
      );
  }

  useEffect(() => { loadTemplate(); }, []);

  // ── API key gate ───────────────────────────────────────────────────────────
  const [apiKeyDone, setApiKeyDone] = useState(() =>
    sessionStorage.getItem('beatpulse_api_key_gate_done') === '1'
  );

  function handleApiKeyDone() {
    sessionStorage.setItem('beatpulse_api_key_gate_done', '1');
    setApiKeyDone(true);
  }

  // ── App state ──────────────────────────────────────────────────────────────
  const state = useAnnotationState();

  // ── Audio recordings (in-memory, cleared on page reload) ───────────────────
  const [recordings, setRecordings] = useState<RecordingEntry[]>([]);

  const addRecording = useCallback((entry: RecordingEntry) => {
    setRecordings((prev) => [...prev, entry]);
  }, []);

  const deleteRecording = useCallback((id: string) => {
    setRecordings((prev) => {
      const entry = prev.find((r) => r.id === id);
      if (entry) URL.revokeObjectURL(entry.audioUrl);
      return prev.filter((r) => r.id !== id);
    });
  }, []);

  const clearRecordings = useCallback(() => {
    setRecordings((prev) => {
      prev.forEach((r) => URL.revokeObjectURL(r.audioUrl));
      return [];
    });
  }, []);

  // ── FIX #1: Single timer — lives at App level, props pass down ─────────────
  const activeTrackIdRef = useRef<number | null>(null);
  activeTrackIdRef.current = state.activeTrackId;

  const timer = useTimer(
    useCallback((secs: number) => {
      const id = activeTrackIdRef.current;
      if (id !== null) {
        state.updateElapsedSeconds(id, secs);
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  const timerStart = useCallback(() => {
    timer.start();
    state.setTimerRunning(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timer.start, state.setTimerRunning]);

  const timerPause = useCallback(() => {
    timer.pause();
    state.setTimerRunning(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timer.pause, state.setTimerRunning]);

  // ── FIX #3: Timer rehydration on track/phase changes ──────────────────────
  useEffect(() => {
    if (state.activeTrackId === null) {
      timer.pause();
      timer.setSeconds(0);
      return;
    }
    const ann = state.annotations[state.activeTrackId];
    if (!ann) return;

    timer.setSeconds(ann.elapsedSeconds ?? 0);

    if (state.phase === 'listening' && state.timerRunning) {
      timer.start();
    } else {
      timer.pause();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeTrackId, state.phase, state.timerRunning]);

  // ── Resume banner ──────────────────────────────────────────────────────────
  const [bannerVisible, setBannerVisible] = useState(false);
  useEffect(() => {
    setBannerVisible(state.hasSavedState);
  }, [state.hasSavedState]);

  function handleResume() {
    const snapshot = state.resumeSavedState();
    setBannerVisible(false);
    if (!snapshot) return;

    if (snapshot.activeTrackId !== null) {
      const ann = snapshot.annotations[snapshot.activeTrackId];
      if (ann) timer.setSeconds(ann.elapsedSeconds ?? 0);
    }
    if (snapshot.timerRunning) {
      timer.start();
    } else {
      timer.pause();
    }
  }

  function handleStartFresh() {
    state.discardSavedState();
    setBannerVisible(false);
  }

  // ── Spotify ────────────────────────────────────────────────────────────────
  const [spotifyToken, setSpotifyToken] = useState<string | null>(() => getStoredToken());

  useEffect(() => {
    (async () => {
      await handleSpotifyCallback();
      setSpotifyToken(getStoredToken());
    })();
  }, []);

  const spotifyPlayer = useSpotifyPlayer(spotifyToken);

  const pendingSpotifyIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (state.phase !== 'listening') {
      pendingSpotifyIdRef.current = null;
      return;
    }
    const ann = state.activeTrackId !== null ? state.annotations[state.activeTrackId] : null;
    if (!ann) return;
    pendingSpotifyIdRef.current = ann.track.spotifyId;
    console.log('[Spotify] Phase changed to listening, pending spotifyId:', ann.track.spotifyId);
    console.log('[Spotify] Player isReady:', spotifyPlayer.isReady, ', deviceId:', spotifyPlayer.deviceId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  useEffect(() => {
    console.log('[Spotify] Player ready effect fired — isReady:', spotifyPlayer.isReady, ', deviceId:', spotifyPlayer.deviceId, ', pending:', pendingSpotifyIdRef.current);
    if (!spotifyPlayer.isReady || !spotifyPlayer.deviceId) return;
    if (!spotifyToken) return;
    const spotifyId = pendingSpotifyIdRef.current;
    if (!spotifyId) return;
    pendingSpotifyIdRef.current = null;

    console.log('[Spotify] Calling transferPlayback then playTrack for:', spotifyId);
    (async () => {
      try {
        await transferPlayback(spotifyPlayer.deviceId!, spotifyToken);
      } catch (err: unknown) {
        console.error('[Spotify] transferPlayback error:', err);
      }
      try {
        await playTrack(spotifyId, spotifyPlayer.deviceId!, spotifyToken);
      } catch (err: unknown) {
        console.error('[Spotify] playTrack error:', err);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotifyPlayer.isReady, spotifyPlayer.deviceId]);

  // ── Early returns ──────────────────────────────────────────────────────────
  if (!apiKeyDone) {
    return <SetupScreen onEnter={handleApiKeyDone} />;
  }

  const { phase, activeTrackId, annotations } = state;
  const activeAnnotation = activeTrackId !== null ? annotations[activeTrackId] : null;

  return (
    <div className="app-root">
      {/* Help + Setup buttons */}
      {!showHelp && phase !== 'prompts_tags' && (
        <div style={{ position: 'fixed', top: '0.75rem', right: '0.75rem', zIndex: 100, display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {activeAnnotation && (
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.75rem',
              color: timer.isRunning ? 'var(--amber)' : 'var(--text-dim)',
              letterSpacing: '0.05em',
              padding: '0 0.5rem',
            }}>
              ⏱ {Math.floor(timer.elapsedSeconds / 60)}:{String(timer.elapsedSeconds % 60).padStart(2, '0')}
            </span>
          )}
          <button
            onClick={() => setApiKeyDone(false)}
            aria-label="Setup"
            style={{
              background: 'transparent',
              border: '1px solid var(--border-active)',
              borderRadius: 'var(--radius)',
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.6875rem',
              letterSpacing: '0.05em',
              padding: '0 0.625rem',
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
            }}
          >
            SETUP
          </button>
          <button
            onClick={() => setShowHelp(true)}
            aria-label="Help"
            style={{
              background: 'transparent',
              border: '1px solid var(--border-active)',
              borderRadius: '50%',
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.875rem',
              width: '32px',
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            ?
          </button>
        </div>
      )}

      {/* Help modal */}
      {showHelp && <HowToUse onClose={() => setShowHelp(false)} />}

      {/* Connect Spotify button — only shown when not authenticated */}
      {!spotifyToken && phase !== 'prompts_tags' && (
        <button
          onClick={() => { initiateSpotifyLogin(); }}
          aria-label="Connect Spotify"
          style={{
            position: 'fixed',
            bottom: '0.75rem',
            left: '0.75rem',
            zIndex: 100,
            background: 'transparent',
            border: '1px solid var(--border-active)',
            borderRadius: 'var(--radius)',
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
            fontSize: '0.6875rem',
            letterSpacing: '0.05em',
            padding: '0.375rem 0.625rem',
            cursor: 'pointer',
          }}
        >
          ♫ Connect Spotify
        </button>
      )}

      {/* Spotify player bar — shown once authenticated */}
      {spotifyToken && phase !== 'prompts_tags' && (
        <SpotifyPlayer
          player={spotifyPlayer}
          spotifyId={activeAnnotation?.track.spotifyId ?? null}
        />
      )}

      {/* Resume banner */}
      {bannerVisible && (
        <div className="resume-banner">
          <span>Resume where you left off?</span>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn-ghost btn-small" onClick={handleStartFresh}>
              Start fresh
            </button>
            <button className="btn-primary btn-small" onClick={handleResume}>
              Resume →
            </button>
          </div>
        </div>
      )}

      {/* ── Phases ── */}

      {phase === 'prompts_tags' && (
        <PhasePromptsTags
          library={state.library}
          undoStack={state.undoStack}
          onBack={() => state.setPhase('select')}
          addCustomTag={state.addCustomTag}
          hideBuiltinTag={state.hideBuiltinTag}
          deleteCustomTag={state.deleteCustomTag}
          restoreHiddenTag={state.restoreHiddenTag}
          togglePackEnabled={state.togglePackEnabled}
          importTagPack={state.importTagPack}
          undoLastAction={state.undoLastAction}
        />
      )}

      {phase === 'select' && (
        <PhaseSelect
          annotations={annotations}
          setActiveTrackId={state.setActiveTrackId}
          setPhase={state.setPhase}
          resetTrack={state.resetTrack}
        />
      )}

      {phase === 'ready' && activeAnnotation && (
        <PhaseReady
          annotation={activeAnnotation}
          annotator={state.annotator}
          setAnnotator={state.setAnnotator}
          onStartListening={() => {
            state.setStatus(activeAnnotation.track.id, 'in_progress', {
              startedAt: Date.now(),
              annotator: state.annotator.trim(),
            });
            state.setPhase('listening');
            timerStart();
          }}
        />
      )}

      {(phase === 'listening' || phase === 'mark_entry') && activeAnnotation && (
        <>
          <PhaseListening
            annotation={activeAnnotation}
            elapsedSeconds={timer.elapsedSeconds}
            isTimerRunning={timer.isRunning}
            timerStart={timerStart}
            timerPause={timerPause}
            setPhase={state.setPhase}
            setMarkEntryDraft={state.setMarkEntryDraft}
            updateTimeline={state.updateTimeline}
            setStatus={state.setStatus}
            isActive={phase === 'listening'}
            recordings={recordings}
            addRecording={addRecording}
            deleteRecording={deleteRecording}
            clearRecordings={clearRecordings}
          />

          {phase === 'mark_entry' && state.markEntryDraft && (
            <PhaseMarkEntry
              annotation={activeAnnotation}
              draft={state.markEntryDraft}
              setMarkEntryDraft={state.setMarkEntryDraft}
              setPhase={state.setPhase}
              updateTimeline={state.updateTimeline}
              onTimerResume={timerStart}
              onTimerPause={timerPause}
              library={state.library}
            />
          )}
        </>
      )}

      {phase === 'flow' && activeAnnotation && (
        <PhaseFlow
          annotation={activeAnnotation}
          elapsedSeconds={timer.elapsedSeconds}
          isTimerRunning={timer.isRunning}
          timerStart={timerStart}
          timerPause={timerPause}
          setPhase={state.setPhase}
          updateTimeline={state.updateTimeline}
          setStatus={state.setStatus}
          spotifyToken={spotifyToken}
          spotifyPlayer={spotifyPlayer}
        />
      )}

      {phase === 'global' && activeAnnotation && (
        <PhaseGlobal
          annotation={activeAnnotation}
          categoryIndex={state.globalCategoryIndex}
          onSummary={state.globalOnSummary}
          setCategoryIndex={state.setGlobalCategoryIndex}
          setOnSummary={state.setGlobalOnSummary}
          updateGlobal={state.updateGlobal}
          setStatus={state.setStatus}
          setPhase={state.setPhase}
        />
      )}

      {phase === 'review' && activeAnnotation && (
        <PhaseReview
          annotation={activeAnnotation}
          allAnnotations={annotations}
          templateState={templateState}
          setPhase={state.setPhase}
          setActiveTrackId={state.setActiveTrackId}
          setMarkEntryDraft={state.setMarkEntryDraft}
          setGlobalCategoryIndex={state.setGlobalCategoryIndex}
          setGlobalOnSummary={state.setGlobalOnSummary}
          annotator={state.annotator}
        />
      )}
    </div>
  );
}

export default App;
