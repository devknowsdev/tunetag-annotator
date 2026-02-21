# BeatPulse Annotator — Claude Code Master Session Doc
*Updated: 21 February 2026 — Session 3*
*Paste prompts ONE AT A TIME. Wait for TypeScript clean ✓ before moving to next.*

---

## ALREADY DONE — DO NOT REDO

The following work is complete and committed. Claude Code should not touch these files unless a prompt explicitly says so.

### Session 1 (Claude Code)
- Audio recording + dictation in `PhaseListening.tsx`
- `RecordingEntry` type, `addRecording` / `deleteRecording` / `clearRecordings` in `App.tsx`
- Mic level meter, waveform SVG, Whisper transcription, collapsible recordings panel
- `vite.config.ts`, `package.json` dev scripts, `scripts/open-chrome.sh`

### Session 2 (Manual)
- `SetupScreen.tsx` replacing `ApiKeyGate.tsx`
- `App.tsx` updated: imports SetupScreen, SETUP button added

### Session 3 (Manual — this session)
- `src/types/index.ts` — added TagType, TagDef, TagPack, PhraseEntry, PromptsTagsLibraryState, UndoAction, TagPackImport; added 'prompts_tags' to Phase union; added promptsTagsLibrary + undoStack to AppState
- `src/lib/tagPacks.ts` — seed data (General, DnB, House, Trap packs) — **NEW FILE**
- `src/lib/tagLibrary.ts` — filter/group utilities — **NEW FILE**
- `src/lib/tagImport.ts` — JSON pack parser/validator — **NEW FILE**
- `src/lib/phraseBuilder.ts` — Who/What/Where/When sentence generator — **NEW FILE**
- `src/hooks/useAnnotationState.ts` — extended with library state, undo stack, all library actions
- `src/components/PhasePromptsTags.tsx` — full management screen (tabbed: Library / Packs / Phrase Builder / Import) — **NEW FILE**
- `src/components/PhaseMarkEntry.tsx` — reordered layout, collapsible Section Type + Tags, structured tag chips, phrase builder panel
- `src/components/PhaseSelect.tsx` — Prompts & Tags button added
- `src/App.tsx` — PhasePromptsTags wired into phase router; library prop passed to PhaseMarkEntry
- `src/index.css` — all new styles appended (tag chips, collapsible panels, pack cards, phrase builder, import dropzone, undo toast)

---

## PENDING SMALL FIXES (do before Phase 1 prompts if not already done)

```
For the project at /Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator

1. In src/lib/spotifyAuth.ts, find the REDIRECT_URI constant and replace it with:
   const REDIRECT_URI = window.location.origin + '/callback'
   (Remove any hardcoded URL that was there before.)

2. Run npx tsc --noEmit. Report TypeScript clean ✓
```

---

## PHASE 1 — NEW FEATURES
*Priority: highest. Do these first.*

---

### PROMPT 1 — Wire Flow Mode into App.tsx
*Est. time: 5 min. Low risk — mostly imports and a placeholder.*

```
For the project at /Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator

1. In src/types/index.ts, add 'flow' to the Phase union type.
   (The union already has 'prompts_tags' from the last session — add 'flow' alongside it.)

2. In src/App.tsx:
   - Add import: import { PhaseFlow } from './components/PhaseFlow'
   - Add to the phase router after the listening/mark_entry block:

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

3. Create a typed placeholder at src/components/PhaseFlow.tsx:

   import type { TrackAnnotation, Phase, TimelineEntry } from '../types'

   interface Props {
     annotation: TrackAnnotation
     elapsedSeconds: number
     isTimerRunning: boolean
     timerStart: () => void
     timerPause: () => void
     setPhase: (phase: Phase) => void
     updateTimeline: (trackId: number, entries: TimelineEntry[]) => void
     setStatus: (trackId: number, status: TrackAnnotation['status'], extra?: Partial<TrackAnnotation>) => void
     spotifyToken: string | null
     spotifyPlayer: any
   }

   export function PhaseFlow({ setPhase }: Props) {
     return (
       <div style={{ padding: '2rem', color: 'var(--amber)', fontFamily: 'var(--font-mono)' }}>
         FLOW MODE — coming soon
         <br /><br />
         <button onClick={() => setPhase('listening')}>← EXIT</button>
       </div>
     )
   }

4. In PhaseListening.tsx, find the top controls area and add a
   FLOW MODE button that calls setPhase('flow').
   Style to match existing control buttons. Label: "⟩ FLOW MODE"

5. Run npx tsc --noEmit. Report TypeScript clean ✓
```

---

### PROMPT 2 — Build PhaseFlow.tsx
*Est. time: 20 min. Self-contained new file — cannot break existing features.*

```
Replace the placeholder src/components/PhaseFlow.tsx for the project at
/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator

PROPS (already wired from App.tsx):
  annotation: TrackAnnotation
  elapsedSeconds: number
  isTimerRunning: boolean
  timerStart: () => void
  timerPause: () => void
  setPhase: (phase: Phase) => void
  updateTimeline: (trackId: number, entries: TimelineEntry[]) => void
  setStatus: (trackId: number, status: TrackAnnotation['status'], extra?: Partial<TrackAnnotation>) => void
  spotifyToken: string | null
  spotifyPlayer: any

LAYOUT — full screen, immersive, minimal UI, no scrolling:

TOP BAR (fixed, full width, flex row)
- Left: track name + artist (truncated if long)
- Centre: elapsed time mm:ss — large, amber, monospace
- Right: EXIT FLOW MODE button → setPhase('listening')

PROGRESS BAR
- Full width bar below top bar
- Fill = elapsedSeconds / (annotation.track.durationSeconds ?? 300)
- Background: var(--surface), fill: var(--amber)

TRANSPORT ROW (centred, generous spacing)
- ⏮ -10s button
- ⏸/▶ Play/Pause button (large, primary style)
- +10s ⏭ button
- Min 44px touch targets on all buttons
- Play/Pause calls timerStart() / timerPause()
- Skip buttons call timerStart() after adjusting a local offset ref

MIC LEVEL METER
- Request getUserMedia({ audio: true }) on mount
- AudioContext + AnalyserNode, 20 bars, amber fill, ~15fps via rAF
- Full width horizontal bar below transport
- Label "MIC" on left
- Release stream + close AudioContext on unmount

TAG BUTTONS
- Read categories from schema — use CATEGORY_GROUPS or the same
  category list used in PhaseMarkEntry
- Render as large pill buttons in a responsive CSS grid:
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr))
- On tap:
  - Create TimelineEntry:
    { id: crypto.randomUUID(), timestamp: formatMSS(elapsedSeconds),
      category: tagName, note: '', createdAt: Date.now() }
  - Call updateTimeline(annotation.track.id, [...annotation.timeline, newEntry])
  - Show 1.5s toast near the button: "✓ [TagName]"
  - NO modal, NO interruption — keep playing

SMART DICTATE TOGGLE
- Button: "● SMART DICTATE" — amber + pulsing dot when active
- When ON:
  - Start continuous SpeechRecognition (interimResults: true, continuous: true)
  - On each final result: create TimelineEntry (category: 'Note', note: transcript)
    call updateTimeline() immediately
  - Show transcript briefly on screen (fades after 3s)
- When OFF: stop SpeechRecognition
- If SpeechRecognition unsupported: hide the toggle entirely

SPEECH TO TEXT TOGGLE
- Button: "◎ SPEECH TO TEXT"
- When ON: show live transcript box
  - Interim results in muted colour
  - Final results in full colour, fade after 4s
- When OFF: hide transcript box
- Independent of Smart Dictate — both can be on simultaneously

TIMELINE DRAWER
- Fixed bottom toggle button showing: "TIMELINE (N)" where N = entry count
- Slides up as a bottom drawer when toggled
- Read-only list of timeline entries for this track, newest first
- Each entry shows: timestamp | category | note (truncated)
- Close button dismisses drawer

HELPER — copy this locally (also in PhaseListening.tsx):
  function formatMSS(totalSeconds: number): string {
    const m = Math.floor(totalSeconds / 60)
    const s = totalSeconds % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

STYLING
- Use existing CSS vars throughout
- Background: var(--bg)
- All text: var(--font-mono) for times/labels, var(--font-serif) for content
- Accent: var(--amber)
- Spacing should be generous — this is a focus mode

ON UNMOUNT
- Stop SpeechRecognition
- Release mic stream (all tracks)
- Close AudioContext

Run npx tsc --noEmit. Report TypeScript clean ✓
Report line count of PhaseFlow.tsx.
```

---

### PROMPT 3 — Improve PhaseSelect layout
*Est. time: 15 min. Layout improvement only — no logic changes.*

```
Improve the PhaseSelect.tsx layout for the project at
/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator

IMPORTANT: The file already has a "PROMPTS & TAGS" button added in the last session.
Do NOT remove it. Do not change any routing logic.
Only improve the visual layout and information display of the track cards and header.

CURRENT ISSUES:
- Narrow centred column wastes screen width
- Track cards are small and information-dense
- No visual hierarchy between tracks at different stages

IMPROVEMENTS:

1. LAYOUT
   - Change from narrow centred column to a responsive grid:
     1 column on mobile, 2 columns on tablet/desktop
     grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))
   - Max width: 900px centred
   - Cards should be taller and more spacious (min-height: 140px)

2. TRACK CARDS — add more useful information:
   - Keep existing: track number, name, artist, status badge
   - Add elapsed annotation time if > 0:
     ⏱ mm:ss in amber monospace (use annotation.elapsedSeconds)
   - Add timeline entry count if in_progress or complete:
     "N timeline entries"
   - Add completion indicator for complete tracks:
     A subtle full-width amber bottom border or filled background tint
   - Status badge should be more prominent — larger, coloured background:
     not_started: muted/dim
     in_progress: amber background
     complete: success green background
     skipped: dim/strikethrough style

3. HEADER
   - Make the session header more spacious
   - Add a subtitle showing overall progress:
     "N of N tracks complete" in muted monospace
   - Add a CONTINUE SESSION button if any tracks are in_progress
     (routes to the first in_progress track's listening phase)

4. EMPTY STATE
   - If all tracks are not_started, show a brief welcome prompt:
     "Select a track below to begin annotating"

Use existing CSS vars throughout. Keep all existing onClick logic exactly as-is.

Run npx tsc --noEmit. Report TypeScript clean ✓
```

---

### PROMPT 4 — Commit Phase 1

```
Commit and push Phase 1 work for the project at
/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator

1. git add .
2. git commit -m "Add Flow Mode phase, improve PhaseSelect layout and track cards"
3. git push
4. Confirm success and report final file list changed.
```

---

## PHASE 2 — FULL SCREEN LAYOUT MODE
*Priority: medium. Do after Phase 1 is committed.*

---

### PROMPT 5 — Full Screen layout toggle in PhaseListening

```
Add a Full Screen layout mode toggle to PhaseListening.tsx for the project at
/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator

IMPORTANT: PhaseListening.tsx is large (~1254 lines). Make surgical changes only.
Do NOT restructure, rename, or move any existing logic.

1. Add local state: const [viewMode, setViewMode] = useState<'classic' | 'fullscreen'>('classic')

2. Add a toggle button in the top controls area (next to the existing FLOW MODE button):
   Label: "⛶ FULL" when classic, "⊠ EXIT FULL" when fullscreen
   On click: toggles between 'classic' and 'fullscreen'

3. When viewMode === 'classic': render existing layout UNCHANGED.

4. When viewMode === 'fullscreen', render this layout:

   FIXED TOP BAR (full width)
   - Left: track name + artist
   - Centre: elapsed time mm:ss, large amber monospace
   - Right: view toggle | FLOW MODE | DONE buttons

   FULL WIDTH PROGRESS BAR below top bar

   TRANSPORT ROW (centred, large touch targets min 44px)
   - ⏮ -10s | ⏸/▶ | +10s ⏭

   MIC METER (full width, visible only when recording active)
   - 20 bars, amber, label "MIC"

   TAG GRID
   - All existing mark-entry trigger buttons
   - responsive grid: repeat(auto-fill, minmax(140px, 1fr))
   - Large pill style, easy to tap

   FIXED BOTTOM TOOLBAR
   - Left: DICTATE button (existing behaviour)
   - Centre: RECORDINGS toggle (existing, shows count if recordings exist)
   - Right: TIMELINE toggle (shows entry count)

   TIMELINE DRAWER
   - Slides up from bottom when toggled
   - Existing timeline content
   - Close button to dismiss

   RECORDINGS DRAWER
   - Slides up from bottom when toggled
   - Existing recordings panel content
   - Close button to dismiss

5. Run npx tsc --noEmit. Report TypeScript clean ✓
   Report final line count of PhaseListening.tsx.
```

---

### PROMPT 6 — Commit Phase 2

```
Commit and push Phase 2 for the project at
/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator

1. git add .
2. git commit -m "Add Full Screen layout toggle to PhaseListening"
3. git push
4. Confirm success.
```

---

## PHASE 3 — REFACTOR
*Do this LAST — only after all features are built, committed and working.*
*Run each prompt one at a time. TypeScript clean ✓ required before proceeding.*

---

### PROMPT 7 — Housekeeping

```
Clean up project housekeeping for the project at
/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator

1. Add to .gitignore if not already present:
   .DS_Store
   **/.DS_Store

2. Delete src/.DS_Store if it exists.

3. Delete netlify.toml — project is on Cloudflare, not Netlify.

4. Delete src/components/ApiKeyGate.tsx — replaced by SetupScreen.tsx.

5. Review scripts/ folder and HOW_TO_RUN.md:
   - Keep scripts/open-chrome.sh if still useful
   - Delete HOW_TO_RUN.md if it references Netlify or outdated setup

6. Run: git add . && git status
   Report which files are staged for removal.

7. Run npx tsc --noEmit. Report TypeScript clean ✓
```

---

### PROMPT 8 — Extract useMicMeter hook

```
Refactor PhaseListening.tsx for the project at
/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator

Extract the mic level meter logic into a dedicated hook.

1. Create src/hooks/useMicMeter.ts:
   - Accepts: stream: MediaStream | null
   - Uses AudioContext + AnalyserNode to measure mic volume
   - Returns: barLevels: number[] (20 values, 0–1 range)
     updated at ~15fps via requestAnimationFrame
   - Cleans up AudioContext when stream becomes null or on unmount

2. Update PhaseFlow.tsx to also use useMicMeter instead of its
   inline AudioContext code.

3. Remove equivalent inline code from PhaseListening.tsx,
   replace with useMicMeter(micStream).

4. Run npx tsc --noEmit. Report TypeScript clean ✓
```

---

### PROMPT 9 — Extract useAudioRecorder hook

```
Refactor PhaseListening.tsx for the project at
/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator

Extract MediaRecorder and mic stream logic into a dedicated hook.

1. Create src/hooks/useAudioRecorder.ts exposing:
   - micStream: MediaStream | null
   - status: 'idle' | 'recording' | 'finalizing'
   - startRecording(): Promise<void>
     — getUserMedia, start MediaRecorder, accumulate chunks
   - stopRecording(): void
     — stop MediaRecorder, assemble Blob, release mic
   - cancelRecording(): void
     — stop everything, discard blob
   - onRecordingReady callback: (blob: Blob, mimeType: string) => void

2. Remove equivalent inline MediaRecorder code from PhaseListening.tsx.
   Replace with useAudioRecorder().

3. Run npx tsc --noEmit. Report TypeScript clean ✓
```

---

### PROMPT 10 — Extract useDictation hook

```
Refactor PhaseListening.tsx for the project at
/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator

Extract SpeechRecognition logic into a dedicated hook.

1. Create src/hooks/useDictation.ts exposing:
   - startDictation(stream: MediaStream): void
   - stopDictation(): void
   - liveTranscript: string
   - finalTranscript: string
   - noSpeechHint: boolean (true after 5s silence)
   - reset(): void
   The hook does NOT manage the mic stream — receives it as parameter.

2. Remove equivalent inline SpeechRecognition code from PhaseListening.tsx.
   Replace with useDictation().

3. Run npx tsc --noEmit. Report TypeScript clean ✓
```

---

### PROMPT 11 — Extract RecordingsPanel component

```
Refactor PhaseListening.tsx for the project at
/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator

Extract the recordings panel UI into a dedicated component.

1. Create src/components/RecordingsPanel.tsx with props:
   - recordings: RecordingEntry[]
   - isOpen: boolean
   - onToggle: () => void
   - onDelete: (id: string) => void
   - onDeleteAllTrack: (trackId: number) => void
   - onDeleteSession: () => void
   - onUseTranscript: (transcript: string) => void
   - currentTrackId: number

   Move ALL of these into RecordingsPanel:
   - Collapsible panel shell + toggle
   - Session-only warning notice
   - Per-recording cards (waveform SVG, audio player, transcript,
     USE TRANSCRIPT / DOWNLOAD / DELETE buttons)
   - Save/Discard confirmation dialog
   - DELETE ALL TRACK / DELETE SESSION / SAVE TO FOLDER buttons
   - Whisper transcription button + inline API key input
   - beforeunload warning effect

2. Replace all of this in PhaseListening.tsx with:
   <RecordingsPanel ... />

3. Run npx tsc --noEmit. Report TypeScript clean ✓
```

---

### PROMPT 12 — Final cleanup and barrel file

```
Final cleanup pass for the project at
/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator

1. Check PhaseListening.tsx line count.
   If still over 300 lines, identify what remains that can be
   further extracted and do so.

2. Create src/hooks/index.ts barrel file:
   export { useDictation } from './useDictation'
   export { useAudioRecorder } from './useAudioRecorder'
   export { useMicMeter } from './useMicMeter'
   export { useAnnotationState } from './useAnnotationState'
   export { useAudioDevices } from './useAudioDevices'
   export { useKeyboardShortcuts } from './useKeyboardShortcuts'
   export { useSpotifyPlayer } from './useSpotifyPlayer'
   export { useTimer } from './useTimer'

3. Update imports in any component that can use the barrel.

4. Run npx tsc --noEmit. Report TypeScript clean ✓

5. Report final line count for every file in src/:
   wc -l src/**/*.{ts,tsx,css} src/*.{ts,tsx,css} | sort -rn
```

---

### PROMPT 13 — Final commit

```
Commit and push the full refactor for the project at
/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator

1. git add .
2. git commit -m "Refactor: extract useMicMeter, useAudioRecorder, useDictation, RecordingsPanel; housekeeping"
3. git push
4. Confirm success.
5. Report final git log --oneline -8
```

---

## SUMMARY

| Phase | Prompts | Priority | Skip if low on compute? |
|-------|---------|----------|------------------------|
| Small fixes | spotifyAuth.ts | Do first | No |
| 1 — New features | 1–4 | HIGHEST | No — do all of these |
| 2 — Full Screen | 5–6 | MEDIUM | Yes — nice to have |
| 3 — Refactor | 7–13 | LOWER | Yes — app works without it |

**If compute runs low:** Stop after Prompt 4. Everything in Phase 1 is committed and working. Come back to Phases 2 and 3 in the next session.

---

## QUICK REFERENCE

```bash
# Navigate to project
cd "/Users/duif/DK APP DEV/BeatPulseLab/beatpulse-annotator"

# Run locally (always use localhost, not 127.0.0.1)
npm run dev

# TypeScript check
npx tsc --noEmit

# Build for production
npm run build

# Commit and push
git add .
git commit -m "your message"
git push

# Check recent commits
git log --oneline -5

# Check file line counts
wc -l src/**/*.{ts,tsx,css} src/*.{ts,tsx,css} | sort -rn
```

## CSS Variables (reference — use these, not custom ones)
```css
--bg, --surface, --surface-raised
--border, --border-active
--amber, --amber-bg, --amber-glow
--text, --text-muted, --text-dim
--error, --error-bg
--success
--font-mono, --font-serif, --font-display
--radius, --radius-pill
--transition
```

## Button Classes
```
btn-primary, btn-ghost, btn-small, label
```
