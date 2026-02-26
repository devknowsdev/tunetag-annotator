// FIX #1: Single timer source — useTimer lives ONLY here, props thread down.
// FIX #2: resumeSavedState() returns snapshot; timer restore uses it directly.
// FIX #3: playTrack called with position_ms so Spotify always starts at correct position.
// FIX #4: Drift correction effect keeps timer in sync with Spotify's authoritative position.
import { useState, useEffect, useCallback, useRef } from 'react';
import type { TemplateState, RecordingEntry } from './types';
import { useAnnotationState, useTimer } from './hooks';
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
import { AppSidebar } from './components/AppSidebar';
import { useSpotifyPlayer } from './hooks';
import { SpotifyPlayer } from './components/SpotifyPlayer';
import { handleSpotifyCallback, getStoredToken, initiateSpotifyLogin } from './lib/spotifyAuth';
import { playTrack, transferPlayback } from './lib/spotifyApi';
import { loadResearchedPacks } from './lib/loadResearchedPacks';

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
    sessionStorage.getItem('tunetag_api_key_gate_done') === '1'
  );

  function handleApiKeyDone() {
    sessionStorage.setItem('tunetag_api_key_gate_done', '1');
    setApiKeyDone(true);
  }

  // ── App state ──────────────────────────────────────────────────────────────
  const state = useAnnotationState();

  // ── Auto-load researched tag packs on setup complete ───────────────────────
  useEffect(() => {
    if (!apiKeyDone) return;
    loadResearchedPacks(state.importTagPack);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeyDone]);

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

  // spotifyPlayerRef — stable ref so timerStart/timerPause closures always
  // reach the latest player without needing it as a dependency.
  const spotifyPlayerRef = useRef<ReturnType<typeof useSpotifyPlayer> | null>(null);

  const timerStart = useCallback(() => {
    timer.start();
    state.setTimerRunning(true);
    spotifyPlayerRef.current?.play().catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timer.start, state.setTimerRunning]);

  const timerPause = useCallback(() => {
    timer.pause();
    state.setTimerRunning(false);
    spotifyPlayerRef.current?.pause().catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timer.pause, state.setTimerRunning]);

  // ── Timer rehydration on track/phase changes ───────────────────────────────
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
  // Keep ref in sync every render so timerStart/timerPause closures use latest player
  spotifyPlayerRef.current = spotifyPlayer;

  // ── FIX #3: Initial track load with position_ms ────────────────────────────
  // When the user enters the listening phase, we queue the spotifyId. Once the
  // player is ready and a device is available, we transfer playback and play the
  // track from the current timer position (so resuming a session starts correctly).
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

    // FIX #3: pass current timer position as position_ms so Spotify starts
    // at the same point the annotation session was at, not always from 0.
    const positionMs = timer.elapsedSeconds * 1000;
    console.log('[Spotify] Calling transferPlayback then playTrack for:', spotifyId, 'at', positionMs, 'ms');
    (async () => {
      try {
        await transferPlayback(spotifyPlayer.deviceId!, spotifyToken);
      } catch (err: unknown) {
        console.error('[Spotify] transferPlayback error:', err);
      }
      try {
        await playTrack(spotifyId, spotifyPlayer.deviceId!, spotifyToken, { positionMs });
      } catch (err: unknown) {
        console.error('[Spotify] playTrack error:', err);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotifyPlayer.isReady, spotifyPlayer.deviceId]);

  // ── FIX #4: Drift correction ───────────────────────────────────────────────
  // Spotify's position (from SDK polling) is authoritative. If the local timer
  // drifts more than 1s from Spotify's reported position, snap the timer.
  // Only corrects while both the timer and Spotify are actively playing.
  useEffect(() => {
    if (!state.timerRunning) return;
    if (!spotifyPlayer.isPlaying) return;
    if (spotifyPlayer.position === 0) return; // Spotify not yet reporting position

    const spotifySec = Math.floor(spotifyPlayer.position / 1000);
    const drift = Math.abs(spotifySec - timer.elapsedSeconds);
    if (drift >= 1) {
      console.log(`[Spotify] Drift correction: timer=${timer.elapsedSeconds}s, spotify=${spotifySec}s, drift=${drift}s`);
      timer.setSeconds(spotifySec);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotifyPlayer.position, spotifyPlayer.isPlaying, state.timerRunning]);

  // ── Early returns ──────────────────────────────────────────────────────────
  if (!apiKeyDone) {
    return <SetupScreen onEnter={handleApiKeyDone} />;
  }

  const { phase, activeTrackId, annotations } = state;
  const activeAnnotation = activeTrackId !== null ? annotations[activeTrackId] : null;

  return (
    <div className="app-root">
      {/* Help modal */}
      {showHelp && <HowToUse onClose={() => setShowHelp(false)} />}

      {/* Global sidebar */}
      <AppSidebar
        phase={phase}
        activeAnnotation={activeAnnotation}
        timerElapsed={timer.elapsedSeconds}
        timerRunning={timer.isRunning}
        onSetup={() => setApiKeyDone(false)}
        onHelp={() => setShowHelp(true)}
        onSpotifyLogin={initiateSpotifyLogin}
        spotifyToken={spotifyToken}
        spotifyPlayer={spotifyPlayer}
      />

      {/* Global Spotify bottom bar — shown on non-immersive phases only */}
      {spotifyToken && phase !== 'flow' && (
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
            timerSeek={timer.setSeconds}
            setPhase={state.setPhase}
            setMarkEntryDraft={state.setMarkEntryDraft}
            updateTimeline={state.updateTimeline}
            setStatus={state.setStatus}
            isActive={phase === 'listening'}
            recordings={recordings}
            addRecording={addRecording}
            deleteRecording={deleteRecording}
            clearRecordings={clearRecordings}
            spotifyToken={spotifyToken}
            spotifyPlayer={spotifyPlayer}
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
          timerSeek={timer.setSeconds}
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
