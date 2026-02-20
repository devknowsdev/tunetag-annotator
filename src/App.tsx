// FIX #1: Single timer source — useTimer lives ONLY here, props thread down.
// FIX #2: resumeSavedState() returns snapshot; timer restore uses it directly.
import { useState, useEffect, useCallback, useRef } from 'react';
import type { TemplateState } from './types';
import { useAnnotationState } from './hooks/useAnnotationState';
import { useTimer } from './hooks/useTimer';
import { ApiKeyGate } from './components/ApiKeyGate';
import { PhaseSelect } from './components/PhaseSelect';
import { PhaseReady } from './components/PhaseReady';
import { PhaseListening } from './components/PhaseListening';
import { PhaseMarkEntry } from './components/PhaseMarkEntry';
import { PhaseGlobal } from './components/PhaseGlobal';
import { PhaseReview } from './components/PhaseReview';
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

  // ── FIX #1: Single timer — lives at App level, props pass down ─────────────
  // PhaseListening receives elapsedSeconds, isRunning, timerStart, timerPause
  // as props and does NOT create its own useTimer instance.
  const activeTrackIdRef = useRef<number | null>(null);
  activeTrackIdRef.current = state.activeTrackId;

  const timer = useTimer(
    useCallback((secs: number) => {
      const id = activeTrackIdRef.current;
      if (id !== null) {
        state.updateElapsedSeconds(id, secs);
      }
    // updateElapsedSeconds is stable (useCallback with no deps), safe to omit
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  // Convenience wrappers that keep timer + persisted flag in sync
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
  // Ensures elapsedSeconds and running state are correct when switching tracks,
  // restarting tracks, or resuming from the select screen (not just the banner).
  useEffect(() => {
    if (state.activeTrackId === null) {
      timer.pause();
      timer.setSeconds(0);
      return;
    }
    const ann = state.annotations[state.activeTrackId];
    if (!ann) return;

    // Rehydrate persisted elapsed seconds into the runtime timer
    timer.setSeconds(ann.elapsedSeconds ?? 0);

    // Align running state with persisted timerRunning flag
    if (state.phase === 'listening' && state.timerRunning) {
      timer.start();
    } else {
      timer.pause();
    }
  // timer tick updates annotations[activeTrackId].elapsedSeconds continuously —
  // exclude annotations from deps to avoid a feedback loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.activeTrackId, state.phase, state.timerRunning]);

  // ── Resume banner ──────────────────────────────────────────────────────────
  // FIX #2: use the snapshot returned by resumeSavedState() to read timer
  // values synchronously, avoiding stale-closure issues.
  const [bannerVisible, setBannerVisible] = useState(false);
  useEffect(() => {
    setBannerVisible(state.hasSavedState);
  }, [state.hasSavedState]);

  function handleResume() {
    const snapshot = state.resumeSavedState(); // returns saved AppState synchronously
    setBannerVisible(false);
    if (!snapshot) return;

    // Restore elapsed seconds from the saved active track
    if (snapshot.activeTrackId !== null) {
      const ann = snapshot.annotations[snapshot.activeTrackId];
      if (ann) timer.setSeconds(ann.elapsedSeconds ?? 0);
    }
    // Restore running state — explicitly call pause when not running to clear
    // any stale interval that might have been left from a prior session.
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
  // Handle OAuth callback once on mount — no-op if no ?code= in URL.
  const [spotifyToken, setSpotifyToken] = useState<string | null>(() => getStoredToken());

  useEffect(() => {
    (async () => {
      await handleSpotifyCallback();
      setSpotifyToken(getStoredToken());
    })();
  }, []);

  // Initialise the player; token is forwarded so the hook can handle the race
  // where the SDK callback fires before the token is available.
  const spotifyPlayer = useSpotifyPlayer(spotifyToken);

  // Auto-play: store the target spotifyId when phase becomes 'listening', then
  // fire once isReady and deviceId are both available.
  const pendingSpotifyIdRef = useRef<string | null>(null);

  // Phase change: capture the spotifyId that should be played.
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

  // Player ready: fire playback once the player is ready and a spotifyId is pending.
  useEffect(() => {
    console.log('[Spotify] Player ready effect fired — isReady:', spotifyPlayer.isReady, ', deviceId:', spotifyPlayer.deviceId, ', pending:', pendingSpotifyIdRef.current);
    if (!spotifyPlayer.isReady || !spotifyPlayer.deviceId) return;
    if (!spotifyToken) return;
    const spotifyId = pendingSpotifyIdRef.current;
    if (!spotifyId) return;
    pendingSpotifyIdRef.current = null; // consume so it doesn't re-fire

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

  // ── Loading / failed states ────────────────────────────────────────────────
  if (templateState.status === 'loading') {
    return (
      <div className="fullscreen-center">
        <p className="label" style={{ color: 'var(--amber)' }}>BEATPULSE ANNOTATOR</p>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>Loading annotation template…</p>
      </div>
    );
  }

  if (templateState.status === 'failed') {
    return (
      <div className="fullscreen-center">
        <p style={{ color: 'var(--error)', marginBottom: '0.75rem' }}>Could not load the annotation template.</p>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginBottom: '1rem' }}>
          Please refresh the page. If this keeps happening, check that{' '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>template.xlsx</code> is in the{' '}
          <code style={{ fontFamily: 'var(--font-mono)' }}>public/</code> folder.
        </p>
        <button className="btn-primary" onClick={loadTemplate}>Retry</button>
      </div>
    );
  }

  if (!apiKeyDone) {
    return <ApiKeyGate onDone={handleApiKeyDone} />;
  }

  const { phase, activeTrackId, annotations } = state;
  const activeAnnotation = activeTrackId !== null ? annotations[activeTrackId] : null;

  return (
    <div className="app-root">
      {/* Help button — hidden when modal is open so it doesn't overlap close btn */}
      {!showHelp && (
        <button
          onClick={() => setShowHelp(true)}
          aria-label="Help"
          style={{
            position: 'fixed',
            top: '0.75rem',
            right: '0.75rem',
            zIndex: 100,
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
      )}

      {/* Help modal */}
      {showHelp && <HowToUse onClose={() => setShowHelp(false)} />}

      {/* Connect Spotify button — only shown when not authenticated */}
      {!spotifyToken && (
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
      {spotifyToken && (
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
            // timerStart() handles both timer.start() + setTimerRunning(true).
            // The timer rehydration effect will also fire on phase change, but
            // calling timerStart here ensures the timer is live immediately.
            timerStart();
          }}
        />
      )}

      {/* FIX #1: Both listening and mark_entry render together.
          PhaseListening stays mounted (preserves scroll) while mark_entry
          overlays it. Timer state threads down as props — no second useTimer. */}
      {(phase === 'listening' || phase === 'mark_entry') && activeAnnotation && (
        <>
          <PhaseListening
            annotation={activeAnnotation}
            // Timer props — single source of truth
            elapsedSeconds={timer.elapsedSeconds}
            isTimerRunning={timer.isRunning}
            timerStart={timerStart}
            timerPause={timerPause}
            setPhase={state.setPhase}
            setMarkEntryDraft={state.setMarkEntryDraft}
            updateTimeline={state.updateTimeline}
            setStatus={state.setStatus}
            isActive={phase === 'listening'}
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
            />
          )}
        </>
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
