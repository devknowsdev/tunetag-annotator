export interface Track {
  id: number;
  artist: string;
  name: string;
  spotifyId: string;
  spotifyUrl: string;
  sheetName: string;
  audioLabel: string;
}

export interface TimelineEntry {
  id: string;
  timestamp: string;         // M:SS
  sectionType: string;
  narrative: string;
  narrativeRaw: string;
  tags: string;              // comma-separated string — kept for export compatibility
  wasPolished: boolean;
  isDictated?: boolean;      // true if this entry came from voice dictation
}

export interface GlobalAnalysis {
  genre: string;
  instrumentation: string;
  mix: string;
  playing: string;
  vocals: string;
  emotion: string;
  lyrics: string;
  quality: string;
  wow: string;
}

export interface MarkEntryDraft {
  mode: 'new' | 'edit';
  entryId?: string;
  timestamp: string;
  sectionType: string;
  narrative: string;
  narrativeRaw: string;
  tags: string;
  wasTimerRunning: boolean;  // timer state BEFORE pause was triggered
  isDictated?: boolean;      // true if transcript came from voice dictation
  dictationTranscript?: string; // raw transcript before editing
}

export interface TrackAnnotation {
  track: Track;
  annotator: string;
  timeline: TimelineEntry[];
  global: Partial<GlobalAnalysis>;
  status: 'not_started' | 'in_progress' | 'complete' | 'skipped';
  skipReason?: string;
  startedAt?: number;
  completedAt?: number;
  elapsedSeconds: number;
  lastSavedAt?: number;
  resumePhase?: Phase;  // persisted so PhaseSelect can restore exact phase
}

export interface AppState {
  annotations: Record<number, TrackAnnotation>;
  activeTrackId: number | null;
  phase: Phase;
  markEntryDraft: MarkEntryDraft | null;
  globalCategoryIndex: number;
  globalOnSummary: boolean;
  timerRunning: boolean;
  // Prompts & Tags library — persisted alongside session state
  promptsTagsLibrary: PromptsTagsLibraryState;
  // Undo stack for structured actions (tag toggles, imports, etc.)
  undoStack: UndoAction[];
}

export type TemplateState =
  | { status: 'loading' }
  | { status: 'ready'; buffer: ArrayBuffer }
  | { status: 'failed'; error: string };

export type LintSeverity = 'error' | 'warning';

export interface LintIssue {
  field: string;
  severity: LintSeverity;
  message: string;
  phase?: Phase;  // optional: which phase to navigate to on "Fix this"
}

export interface LintResult {
  issues: LintIssue[];
  canExport: boolean;
}

export type Phase =
  | 'select'
  | 'ready'
  | 'listening'
  | 'mark_entry'
  | 'global'
  | 'review'
  | 'prompts_tags'
  | 'flow';

export interface CategoryDef {
  key: keyof GlobalAnalysis;
  excelLabel: string;
  displayLabel: string;
  guidance: string;
  suggestedTags?: string[];
  canBeNA: boolean;
}

// Dictation state (component-level, not persisted to AppState except via draft)
export type DictationStatus =
  | 'idle'
  | 'awaiting_manual_pause'  // prompt user to pause Spotify
  | 'recording'
  | 'transcribing'
  | 'done'
  | 'error';

// A single audio recording captured during a dictation session.
// Stored in App-level React state (in-memory, cleared on page reload).
export interface RecordingEntry {
  id: string;          // crypto.randomUUID()
  trackId: number;
  timestamp: string;   // M:SS — captured at dictate-click time
  createdAt: number;   // Date.now()
  audioBlob: Blob;     // raw audio (audio/webm or audio/ogg)
  audioUrl: string;    // URL.createObjectURL(audioBlob) — revoked on delete
  transcript: string;  // Speech API transcript captured at record time
  mimeType: string;    // the mimeType used by MediaRecorder
}

// ─── Prompts & Tags System ────────────────────────────────────────────────────

/**
 * The semantic role of a tag in the annotation system.
 * Used to group and filter tags intelligently.
 */
export type TagType =
  | 'section'       // structural sections (intro, chorus, drop, etc.)
  | 'source'        // sound sources / instruments (kick, pad, vocal lead, etc.)
  | 'action'        // what a sound does (enters, builds, resolves, etc.)
  | 'quality'       // descriptors (tight, loose, warm, dark, etc.)
  | 'mix'           // mix / space descriptors (muddy, wide, sidechained, etc.)
  | 'genre_marker'  // genre-specific terms (amen, reese, 808, etc.)
  | 'timing'        // timing positions (on beat, before drop, bar marker, etc.)
  | 'custom';       // user-created tags that don't fit the above

/**
 * A single tag in the global tag library.
 */
export interface TagDef {
  id: string;
  label: string;
  normalized: string;   // lowercase trimmed key — used for deduplication
  type: TagType;
  category: string;     // display grouping, e.g. "Drums", "Bass", "Arrangement"
  source: 'builtin' | 'custom';
  packIds: string[];    // which packs include this tag, e.g. ['general', 'dnb']
}

/**
 * A named collection of tags that can be toggled on/off as a group.
 */
export interface TagPack {
  id: string;           // e.g. 'general', 'dnb', 'house'
  label: string;        // display name, e.g. 'General', 'DnB'
  description?: string;
  builtin: boolean;     // builtin packs can be hidden but not deleted
}

/**
 * A phrase saved to the user's reusable phrase bank.
 */
export interface PhraseEntry {
  id: string;
  text: string;
  createdAt: number;
  source: 'manual' | 'builder'; // 'builder' = generated by Who/What/Where/When
}

/**
 * The full persistent state for the Prompts & Tags library.
 * Stored separately from session annotation data.
 */
export interface PromptsTagsLibraryState {
  packs: TagPack[];
  tags: TagDef[];
  enabledPackIds: string[];              // packs active by default for new sessions
  hiddenBuiltinTagIds: string[];         // soft-deleted builtin tags
  hiddenBuiltinPackIds: string[];        // soft-hidden builtin packs
  customSectionTypes: string[];          // user-added section type chips
  sessionActiveTagIdsByTrack: Record<number, string[]>; // per-track active tag selections
  sessionHiddenTagIdsByTrack: Record<number, string[]>; // per-track deactivated tags (session-local)
  phraseBank: PhraseEntry[];
  promptTemplates: {
    firstSection: string[];
    subsequentSection: string[];
  };
}

/**
 * A single reversible structured action recorded in the undo stack.
 * Does NOT cover free-text typing — browser Cmd/Ctrl+Z handles that natively.
 */
export interface UndoAction {
  id: string;
  label: string;        // e.g. "Add tag "Reese"" — shown on the Undo button
  timestamp: number;    // Date.now()
  kind: string;         // action type identifier, e.g. 'tag_activate', 'tag_import'
  // Enough data to restore previous state — structure varies per kind
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  undoPayload: any;
}

/**
 * The raw format accepted by the JSON tag importer.
 * Claude and other AI tools should emit this exact shape.
 */
export interface TagPackImport {
  packId: string;
  label: string;
  version: number;
  tags: Array<{
    label: string;
    type: TagType | string; // unknown types are mapped to 'custom'
    category: string;
  }>;
}
