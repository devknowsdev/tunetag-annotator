# TuneTag Annotator — Claude Session Handover
*Last updated: 23 February 2026*

---

## Project Identity

| Field | Detail |
|---|---|
| **App name** | TuneTag Annotator |
| **Purpose** | Real-time audio annotation for music supervisors and sound editors. Annotate Spotify tracks with timestamped notes, record voice memos, export to Excel. |
| **Primary user** | Music industry professional (ADHD/Autistic) — needs low-friction, calm, predictable UI |
| **Stack** | React 18 + TypeScript + Vite 5 |
| **Local path** | `/Users/duif/DK APP DEV/tunetag-annotator` |
| **Live URL** | https://tunetag.devknowsdev.workers.dev/ |
| **GitHub** | https://github.com/devknowsdev/tunetag-annotator |
| **Hosting** | Cloudflare Workers via Wrangler (auto-deploys on push to `main`) |
| **Local dev** | `npm run dev` → http://localhost:5173 (**always `localhost`, never `127.0.0.1`** — Web Speech API requires it) |

---

## What Was Completed This Session

### 1. Project renamed and moved
- Folder moved from `/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator`
- Now lives at `/Users/duif/DK APP DEV/tunetag-annotator`
- GitHub remote confirmed correct: `git@github.com:devknowsdev/tunetag-annotator.git`
- SSH auth set up (no more password prompts)
- All internal path references updated throughout the project

### 2. Housekeeping
- `src/components/ApiKeyGate.tsx` — deleted (replaced by SetupScreen)
- `netlify.toml` — deleted
- `.DS_Store` files cleaned up, `**/.DS_Store` added to `.gitignore`
- `src/lib/spotifyAuth.ts` — REDIRECT_URI updated to dynamic `window.location.origin + '/callback'`

### 3. PhaseListening.tsx refactor
Original file was 1023 lines. Extracted into focused files:

| New file | What it contains |
|---|---|
| `src/components/DictationOverlay.tsx` | `DictationState` types, `INITIAL_DICTATION`, `MicLevelMeter` component, `DictationOverlay` component |
| `src/hooks/useDictationFlow.ts` | `useDictationFlow` hook (orchestrates recorder + dictation + state) |
| `src/components/PhaseListening.tsx` | Down to ~370 lines — imports from the above, no local definitions |
| `src/hooks/index.ts` | Barrel file updated to export `useDictationFlow` |

All changes committed and pushed. TypeScript clean (exit 0).

---

## Current Source Structure

```
src/
├── App.tsx                        ← root, all state, phase routing, timer
├── main.tsx
├── index.css                      ← all CSS vars + component classes
├── global.d.ts                    ← global type declarations (Spotify.Player etc.)
├── types/index.ts                 ← shared TypeScript interfaces
│
├── components/
│   ├── SetupScreen.tsx            ← onboarding screen (replaces ApiKeyGate)
│   ├── DictationOverlay.tsx       ← ✅ NEW — dictation UI + MicLevelMeter + types
│   ├── PhaseListening.tsx         ← ✅ REFACTORED — ~370 lines
│   ├── PhaseMarkEntry.tsx
│   ├── PhaseGlobal.tsx
│   ├── PhaseReady.tsx
│   ├── PhaseReview.tsx
│   ├── PhaseSelect.tsx
│   ├── SpotifyPlayer.tsx
│   ├── RecordingsPanel.tsx
│   ├── LintPanel.tsx
│   ├── HowToUse.tsx
│   ├── AppSidebar.tsx
│   └── WaveformScrubber.tsx
│
├── hooks/
│   ├── useAnnotationState.ts
│   ├── useAudioDevices.ts
│   ├── useAudioRecorder.ts
│   ├── useDictation.ts
│   ├── useDictationFlow.ts        ← ✅ NEW
│   ├── useMicMeter.ts
│   ├── useSpotifyPlayer.ts
│   ├── useKeyboardShortcuts.ts
│   ├── useTimer.ts
│   └── index.ts                   ← barrel file, exports all hooks
│
└── lib/
    ├── schema.ts
    ├── spotifyApi.ts              ← ⏳ NEEDS transport overhaul (next task)
    ├── spotifyAuth.ts             ← ✅ REDIRECT_URI fixed
    ├── excelExport.ts
    ├── lintAnnotation.ts
    ├── polishText.ts
    ├── tagPacks.ts
    ├── tagLibrary.ts
    ├── tagImport.ts
    ├── phraseBuilder.ts
    └── loadResearchedPacks.ts
```

---

## Next Task: Transport Overhaul (P0)

**The problem:** Timer and Spotify run independently — drift accumulates. `playTrack()` doesn't send `position_ms` so always starts from 0. Track duration is hard-coded at 300s.

**Files needed:** Upload these three to start:
- `src/App.tsx`
- `src/lib/spotifyApi.ts`
- `src/hooks/useSpotifyPlayer.ts`

### Changes required

**1. `src/lib/spotifyApi.ts` — add position_ms, pause, seek wrappers:**
```ts
export async function playTrack(
  spotifyId: string, deviceId: string, token: string, opts?: { positionMs?: number }
): Promise<void> {
  const body: any = { uris: [`spotify:track:${spotifyId}`] };
  if (opts?.positionMs !== undefined) body.position_ms = Math.max(0, Math.floor(opts.positionMs));
  await fetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(deviceId)}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
}

export async function pausePlayback(deviceId: string, token: string) {
  await fetch(`https://api.spotify.com/v1/me/player/pause?device_id=${encodeURIComponent(deviceId)}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
}

export async function seekPlayback(deviceId: string, token: string, positionMs: number) {
  await fetch(
    `https://api.spotify.com/v1/me/player/seek?position_ms=${Math.max(0, Math.floor(positionMs))}&device_id=${encodeURIComponent(deviceId)}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
}
```

**2. `src/hooks/useSpotifyPlayer.ts` — token ref so SDK always uses latest token:**
```ts
const tokenRef = useRef(token);
useEffect(() => { tokenRef.current = token; }, [token]);
const player = new Spotify.Player({
  name: 'TuneTag',
  getOAuthToken: cb => { const t = tokenRef.current; if (t) cb(t); }
});
```

**3. `src/App.tsx` — unified transport handlers + drift correction:**
```tsx
async function handlePlay() {
  if (deviceId && spotifyToken) {
    await transferPlayback(deviceId, spotifyToken);
    await playTrack(activeSpotifyId, deviceId, spotifyToken, { positionMs: timer.elapsedSeconds * 1000 });
  }
  timer.start();
}
function handlePause() {
  timer.pause();
  spotifyPlayer.pause().catch(() => {});
}
function handleStop() {
  timer.pause(); timer.setSeconds(0);
  spotifyPlayer.pause().catch(() => {});
  spotifyPlayer.seek(0).catch(() => {});
}

// Drift correction effect
useEffect(() => {
  if (!timerRunning || !spotifyPlayer.isPlaying) return;
  const spotifySec = Math.floor(spotifyPlayer.position / 1000);
  const drift = Math.abs(spotifySec - timer.elapsedSeconds);
  if (drift >= 1) timer.setSeconds(spotifySec);
}, [spotifyPlayer.position, spotifyPlayer.isPlaying, timer.elapsedSeconds, timerRunning]);
```

**4. `src/global.d.ts` — expose `activateElement()`:**
```ts
interface SpotifyPlayer {
  activateElement(): Promise<void>;
}
```

**5. Fix hard-coded duration** in `WaveformScrubber` — remove `durationSeconds = 300`, use:
```ts
const fullDuration = analysis?.track?.duration ?? Math.floor(spotifyPlayer.duration / 1000) || 0;
```

---

## Backlog (Priority Order)

| Priority | Task | Notes |
|---|---|---|
| **P0** | Transport overhaul | See above — next task |
| **P0** | Fix hard-coded `durationSeconds = 300` | Use `spotifyPlayer.duration` or track metadata |
| **P1** | PKCE token refresh | Prevents 1hr session failures |
| **P1** | Waveform strategy | Try Audio Analysis → user upload → pseudo-waveform fallback |
| **P1** | Vitest unit tests | Transport logic, drift correction |
| **P2** | CI/CD — GitHub Actions + Wrangler deploy | See §CI/CD below |
| **P2** | Flow Mode | New `flow` phase in App.tsx router |
| **P2** | Replace `window.confirm`/`window.prompt` | Custom modal components |
| **P3** | Spotify quota extension request | Required for public launch |

---

## Architecture Summary

### Phase machine
```
select → ready → listening ⇄ mark_entry
                     │
                     ↓
                  global → review → select
```

- `listening` + `mark_entry` co-render (mark_entry is overlay, listening stays mounted)
- `isActive={phase === 'listening'}` gates all keyboard handlers

### State
- Single `AppState` in `useAnnotationState` — persisted to localStorage
- Timer lives **only** in `App.tsx` — props thread down
- Autosave debounces at 500ms; flushes on `pagehide`/`beforeunload`

### Session storage keys
| Key | Purpose |
|---|---|
| `spotify_api_key` | Spotify client token |
| `openai_api_key` | OpenAI key (Whisper + polish) |
| `tunetag_api_key_gate_done` | Setup screen completed flag |

---

## Design System (quick ref)

### Key colour tokens
| Token | Value | Usage |
|---|---|---|
| `--bg` | `#0a0a0a` | Page background |
| `--surface` | `#111111` | Cards, panels |
| `--amber` | `#f59e0b` | Primary accent — CTAs, timer |
| `--text` | `#d4cbbe` | Body text |
| `--text-muted` | `#7a7268` | Secondary text |
| `--error` | `#ef4444` | Errors, destructive |
| `--success` | `#22c55e` | Success states |

### Button classes
`btn-primary`, `btn-ghost`, `btn-small`, `btn-destructive`, `btn-link`

### Fonts
- `--font-mono` — JetBrains Mono (labels, timestamps)
- `--font-serif` — Georgia (user content, annotations)
- `--font-display` — Playfair Display (track names, titles)

---

## Spotify Developer Setup

**Dashboard:** https://developer.spotify.com/dashboard
**App name:** TuneTag (do NOT delete — 24hr creation limit)

**APIs enabled:** Web API ✅, Web Playback SDK ✅

**Redirect URIs:**
```
https://tunetag.devknowsdev.workers.dev/callback
http://localhost:5173/callback
```

**Required scopes:**
- `user-modify-playback-state` — play, pause, seek
- `user-read-playback-state` — reading progress_ms

**Note:** App is in Development Mode. Add Spotify account email as test user before testing live deployment.

---

## Cloudflare Deployment

```json
{
  "name": "tunetag-annotator",
  "compatibility_date": "2026-02-21",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  }
}
```

Auto-deploys on push to `main` via GitHub → Cloudflare integration.

---

## CI/CD Plan (not yet implemented)

```yaml
name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with: {node-version: '18', cache: 'npm'}
      - run: npm ci
      - run: npm run lint
      - run: npm run test
      - run: npm run build
```

- Protect `main` branch — require CI pass before merge
- Add `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` as GitHub secrets
- Use `cloudflare/wrangler-action` for auto-deploy on merge

---

## Useful Commands

```bash
# Navigate
cd "/Users/duif/DK APP DEV/tunetag-annotator"

# Run locally
npm run dev
# → http://localhost:5173

# TypeScript check
npx tsc --noEmit

# Build
npm run build

# Commit and push
git add .
git commit -m "your message"
git push

# Recent commits
git log --oneline -5

# File line counts
wc -l src/**/*.{ts,tsx} | sort -rn
```

---

## How to Start a New Claude Chat on This Project

1. Paste this document at the top of the new chat
2. State which task you want to work on
3. Upload the relevant files for that task (Claude can't access your local filesystem directly)
4. Run `npx tsc --noEmit` after every set of changes and paste the result
5. Commit after each clean TypeScript check

**For the transport overhaul (next task), upload:**
- `src/App.tsx`
- `src/lib/spotifyApi.ts`
- `src/hooks/useSpotifyPlayer.ts`
