import { useState, useCallback, useEffect, useRef } from 'react';
import type {
  AppState,
  TrackAnnotation,
  Phase,
  MarkEntryDraft,
  GlobalAnalysis,
  TimelineEntry,
  TagDef,
  TagPack,
  PhraseEntry,
  PromptsTagsLibraryState,
  UndoAction,
  TagPackImport,
  TagType,
} from '../types';
import { getActiveTracks } from '../lib/schema';
import { BUILTIN_PACKS, BUILTIN_TAGS, DEFAULT_LIBRARY_STATE } from '../lib/tagPacks';

const STORAGE_KEY = 'tunetag_v1';
const ANNOTATOR_KEY = 'tunetag_annotator';
const AUTOSAVE_DEBOUNCE_MS = 500;
const UNDO_STACK_MAX = 100;

// ─── Default state builders ───────────────────────────────────────────────────

function makeDefaultLibrary(): PromptsTagsLibraryState {
  return {
    packs: BUILTIN_PACKS,
    tags: BUILTIN_TAGS,
    ...DEFAULT_LIBRARY_STATE,
  };
}

function makeEmptyAnnotation(trackId: number, annotator: string): TrackAnnotation {
  const track = getActiveTracks().find((t) => t.id === trackId)!;
  return {
    track,
    annotator,
    timeline: [],
    global: {},
    status: 'not_started',
    elapsedSeconds: 0,
  };
}

function makeDefaultAppState(): AppState {
  const annotator = localStorage.getItem(ANNOTATOR_KEY) ?? '';
  const tracks = getActiveTracks();
  const annotations: Record<number, TrackAnnotation> = {};
  tracks.forEach((t) => { annotations[t.id] = makeEmptyAnnotation(t.id, annotator); });
  return {
    annotations,
    activeTrackId: null,
    phase: 'select',
    markEntryDraft: null,
    globalCategoryIndex: 0,
    globalOnSummary: false,
    timerRunning: false,
    promptsTagsLibrary: makeDefaultLibrary(),
    undoStack: [],
  };
}

// ─── Migration-safe loader ────────────────────────────────────────────────────
// If saved state is missing new fields, fill them in from defaults so existing
// sessions load without crashing.

function loadSavedState(): AppState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      ...makeDefaultAppState(),
      ...parsed,
      // Always re-merge library — ensures new builtin tags/packs appear
      // even for users with saved sessions from before this version.
      promptsTagsLibrary: {
        ...makeDefaultLibrary(),
        ...(parsed.promptsTagsLibrary ?? {}),
        // Keep packs list fresh (builtins may have been updated)
        packs: BUILTIN_PACKS,
        // Merge builtin tags with any custom tags already saved
        tags: mergeTagsWithSaved(parsed.promptsTagsLibrary?.tags),
      },
      undoStack: parsed.undoStack ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * Merge saved custom tags with the current builtin seed, deduplicating by
 * normalized label. Builtins win on metadata; custom tags are preserved.
 */
function mergeTagsWithSaved(savedTags?: TagDef[]): TagDef[] {
  if (!savedTags || savedTags.length === 0) return BUILTIN_TAGS;
  const builtinByNorm = new Map(BUILTIN_TAGS.map((t) => [t.normalized, t]));
  const custom = savedTags.filter(
    (t) => t.source === 'custom' && !builtinByNorm.has(t.normalized)
  );
  return [...BUILTIN_TAGS, ...custom];
}

// ─── Return type ──────────────────────────────────────────────────────────────

export interface UseAnnotationStateReturn {
  appState: AppState;
  hasSavedState: boolean;
  resumeSavedState: () => AppState | null;
  discardSavedState: () => void;

  annotations: Record<number, TrackAnnotation>;
  activeTrackId: number | null;
  setActiveTrackId: (id: number | null) => void;

  phase: Phase;
  setPhase: (p: Phase) => void;

  markEntryDraft: MarkEntryDraft | null;
  setMarkEntryDraft: (d: MarkEntryDraft | null) => void;

  globalCategoryIndex: number;
  setGlobalCategoryIndex: (i: number) => void;

  globalOnSummary: boolean;
  setGlobalOnSummary: (v: boolean) => void;

  timerRunning: boolean;
  setTimerRunning: (v: boolean) => void;

  annotator: string;
  setAnnotator: (name: string) => void;

  updateTimeline: (trackId: number, entries: TimelineEntry[]) => void;
  updateGlobal: (trackId: number, global: Partial<GlobalAnalysis>) => void;
  setStatus: (
    trackId: number,
    status: TrackAnnotation['status'],
    extra?: Partial<TrackAnnotation>
  ) => void;
  updateElapsedSeconds: (trackId: number, seconds: number) => void;
  resetTrack: (trackId: number) => void;

  // ── Prompts & Tags library actions ──────────────────────────────────────────
  library: PromptsTagsLibraryState;
  addCustomTag: (label: string, type: TagType, category: string) => void;
  hideBuiltinTag: (tagId: string) => void;
  deleteCustomTag: (tagId: string) => void;
  restoreHiddenTag: (tagId: string) => void;
  togglePackEnabled: (packId: string) => void;
  importTagPack: (raw: TagPackImport) => { added: number; merged: number; errors: string[] };
  setSessionActiveTagIds: (trackId: number, tagIds: string[]) => void;
  toggleSessionTag: (trackId: number, tagId: string) => void;
  hideTagInSession: (trackId: number, tagId: string) => void;
  addPhraseToBank: (text: string, source: PhraseEntry['source']) => void;
  removePhraseFromBank: (phraseId: string) => void;
  addCustomSectionType: (label: string) => void;

  // ── Undo ────────────────────────────────────────────────────────────────────
  undoStack: UndoAction[];
  undoLastAction: () => void;
  pushUndo: (action: Omit<UndoAction, 'id' | 'timestamp'>) => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAnnotationState(): UseAnnotationStateReturn {
  const [appState, setAppStateRaw] = useState<AppState>(makeDefaultAppState);
  const [hasSavedState, setHasSavedState] = useState<boolean>(false);
  const savedOnLoad = useRef<AppState | null>(null);

  useEffect(() => {
    const saved = loadSavedState();
    if (saved) {
      savedOnLoad.current = saved;
      setHasSavedState(true);
    }
  }, []);

  // ── Autosave (debounced + flush on unload) ───────────────────────────────
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSave = useRef<AppState | null>(null);

  const persistState = useCallback((state: AppState) => {
    pendingSave.current = state;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        pendingSave.current = null;
      } catch {
        // Storage quota exceeded — swallow silently
      }
    }, AUTOSAVE_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    function flushSave() {
      if (pendingSave.current) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(pendingSave.current));
          pendingSave.current = null;
        } catch {
          // swallow
        }
      }
    }
    window.addEventListener('pagehide', flushSave);
    window.addEventListener('beforeunload', flushSave);
    return () => {
      window.removeEventListener('pagehide', flushSave);
      window.removeEventListener('beforeunload', flushSave);
      flushSave();
    };
  }, []);

  const setAppState = useCallback(
    (updater: AppState | ((prev: AppState) => AppState)) => {
      setAppStateRaw((prev) => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        persistState(next);
        return next;
      });
    },
    [persistState]
  );

  // ── Session resume / discard ─────────────────────────────────────────────

  const resumeSavedState = useCallback((): AppState | null => {
    const snapshot = savedOnLoad.current;
    if (snapshot) {
      setAppStateRaw(snapshot);
      setHasSavedState(false);
      savedOnLoad.current = null;
      return snapshot;
    }
    return null;
  }, []);

  const discardSavedState = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setHasSavedState(false);
    savedOnLoad.current = null;
  }, []);

  // ── Standard annotation actions (unchanged from original) ────────────────

  const setActiveTrackId = useCallback(
    (id: number | null) => setAppState((p) => ({ ...p, activeTrackId: id })),
    [setAppState]
  );

  const setPhase = useCallback(
    (phase: Phase) =>
      setAppState((p) => {
        if (phase !== 'select' && p.activeTrackId !== null) {
          const ann = p.annotations[p.activeTrackId];
          if (ann) {
            return {
              ...p,
              phase,
              annotations: {
                ...p.annotations,
                [p.activeTrackId]: { ...ann, resumePhase: phase },
              },
            };
          }
        }
        return { ...p, phase };
      }),
    [setAppState]
  );

  const setMarkEntryDraft = useCallback(
    (draft: MarkEntryDraft | null) =>
      setAppState((p) => ({ ...p, markEntryDraft: draft })),
    [setAppState]
  );

  const setGlobalCategoryIndex = useCallback(
    (i: number) => setAppState((p) => ({ ...p, globalCategoryIndex: i })),
    [setAppState]
  );

  const setGlobalOnSummary = useCallback(
    (v: boolean) => setAppState((p) => ({ ...p, globalOnSummary: v })),
    [setAppState]
  );

  const setTimerRunning = useCallback(
    (v: boolean) => setAppState((p) => ({ ...p, timerRunning: v })),
    [setAppState]
  );

  const setAnnotator = useCallback(
    (name: string) => {
      localStorage.setItem(ANNOTATOR_KEY, name);
      setAppState((p) => {
        const annotations = { ...p.annotations };
        for (const id of Object.keys(annotations)) {
          const ann = annotations[Number(id)];
          annotations[Number(id)] = { ...ann, annotator: name };
        }
        return { ...p, annotations };
      });
    },
    [setAppState]
  );

  const updateTimeline = useCallback(
    (trackId: number, entries: TimelineEntry[]) => {
      setAppState((p) => ({
        ...p,
        annotations: {
          ...p.annotations,
          [trackId]: {
            ...p.annotations[trackId],
            timeline: entries,
            status:
              p.annotations[trackId].status === 'not_started'
                ? 'in_progress'
                : p.annotations[trackId].status,
          },
        },
      }));
    },
    [setAppState]
  );

  const updateGlobal = useCallback(
    (trackId: number, global: Partial<GlobalAnalysis>) => {
      setAppState((p) => ({
        ...p,
        annotations: {
          ...p.annotations,
          [trackId]: { ...p.annotations[trackId], global },
        },
      }));
    },
    [setAppState]
  );

  const setStatus = useCallback(
    (
      trackId: number,
      status: TrackAnnotation['status'],
      extra: Partial<TrackAnnotation> = {}
    ) => {
      setAppState((p) => ({
        ...p,
        annotations: {
          ...p.annotations,
          [trackId]: { ...p.annotations[trackId], status, ...extra },
        },
      }));
    },
    [setAppState]
  );

  const updateElapsedSeconds = useCallback(
    (trackId: number, seconds: number) => {
      setAppState((p) => ({
        ...p,
        annotations: {
          ...p.annotations,
          [trackId]: { ...p.annotations[trackId], elapsedSeconds: seconds },
        },
      }));
    },
    [setAppState]
  );

  const resetTrack = useCallback(
    (trackId: number) => {
      const annotator = localStorage.getItem(ANNOTATOR_KEY) ?? '';
      setAppState((p) => ({
        ...p,
        annotations: {
          ...p.annotations,
          [trackId]: makeEmptyAnnotation(trackId, annotator),
        },
        markEntryDraft: null,
        globalCategoryIndex: 0,
        globalOnSummary: false,
        phase: 'ready',
        timerRunning: false,
      }));
    },
    [setAppState]
  );

  // ── Library helper ───────────────────────────────────────────────────────

  const updateLibrary = useCallback(
    (updater: (lib: PromptsTagsLibraryState) => PromptsTagsLibraryState) => {
      setAppState((p) => ({
        ...p,
        promptsTagsLibrary: updater(p.promptsTagsLibrary),
      }));
    },
    [setAppState]
  );

  // ── Undo ─────────────────────────────────────────────────────────────────

  const pushUndo = useCallback(
    (action: Omit<UndoAction, 'id' | 'timestamp'>) => {
      setAppState((p) => {
        const newAction: UndoAction = {
          ...action,
          id: crypto.randomUUID(),
          timestamp: Date.now(),
        };
        const stack = [newAction, ...p.undoStack].slice(0, UNDO_STACK_MAX);
        return { ...p, undoStack: stack };
      });
    },
    [setAppState]
  );

  const undoLastAction = useCallback(() => {
    setAppState((p) => {
      if (p.undoStack.length === 0) return p;
      const [latest, ...rest] = p.undoStack;
      const lib = p.promptsTagsLibrary;

      // Apply the inverse operation based on action kind
      let newLib = lib;

      switch (latest.kind) {
        case 'tag_hide_builtin': {
          const { tagId } = latest.undoPayload as { tagId: string };
          newLib = {
            ...lib,
            hiddenBuiltinTagIds: lib.hiddenBuiltinTagIds.filter((id) => id !== tagId),
          };
          break;
        }
        case 'tag_delete_custom': {
          const { tag } = latest.undoPayload as { tag: TagDef };
          newLib = { ...lib, tags: [...lib.tags, tag] };
          break;
        }
        case 'tag_add_custom': {
          const { tagId } = latest.undoPayload as { tagId: string };
          newLib = { ...lib, tags: lib.tags.filter((t) => t.id !== tagId) };
          break;
        }
        case 'pack_toggle': {
          const { packId, wasEnabled } = latest.undoPayload as {
            packId: string;
            wasEnabled: boolean;
          };
          newLib = {
            ...lib,
            enabledPackIds: wasEnabled
              ? [...lib.enabledPackIds, packId]
              : lib.enabledPackIds.filter((id) => id !== packId),
          };
          break;
        }
        case 'pack_import': {
          const { addedTagIds, addedPackId } = latest.undoPayload as {
            addedTagIds: string[];
            addedPackId: string | null;
          };
          newLib = {
            ...lib,
            tags: lib.tags.filter((t) => !addedTagIds.includes(t.id)),
            packs: addedPackId
              ? lib.packs.filter((pk) => pk.id !== addedPackId)
              : lib.packs,
          };
          break;
        }
        case 'session_tag_toggle': {
          const { trackId, prevActiveIds } = latest.undoPayload as {
            trackId: number;
            prevActiveIds: string[];
          };
          newLib = {
            ...lib,
            sessionActiveTagIdsByTrack: {
              ...lib.sessionActiveTagIdsByTrack,
              [trackId]: prevActiveIds,
            },
          };
          break;
        }
        case 'phrase_add': {
          const { phraseId } = latest.undoPayload as { phraseId: string };
          newLib = {
            ...lib,
            phraseBank: lib.phraseBank.filter((ph) => ph.id !== phraseId),
          };
          break;
        }
        case 'phrase_remove': {
          const { phrase } = latest.undoPayload as { phrase: PhraseEntry };
          newLib = { ...lib, phraseBank: [...lib.phraseBank, phrase] };
          break;
        }
        default:
          break;
      }

      return { ...p, promptsTagsLibrary: newLib, undoStack: rest };
    });
  }, [setAppState]);

  // ── Tag library actions ──────────────────────────────────────────────────

  const addCustomTag = useCallback(
    (label: string, type: TagType, category: string) => {
      const normalized = label.trim().toLowerCase();
      setAppState((p) => {
        // Prevent duplicates
        if (p.promptsTagsLibrary.tags.some((t) => t.normalized === normalized)) {
          return p;
        }
        const newTag: TagDef = {
          id: `custom_${crypto.randomUUID()}`,
          label: label.trim(),
          normalized,
          type,
          category,
          source: 'custom',
          packIds: [],
        };
        const newUndo: UndoAction = {
          id: crypto.randomUUID(),
          label: `Add tag "${newTag.label}"`,
          timestamp: Date.now(),
          kind: 'tag_add_custom',
          undoPayload: { tagId: newTag.id },
        };
        return {
          ...p,
          promptsTagsLibrary: {
            ...p.promptsTagsLibrary,
            tags: [...p.promptsTagsLibrary.tags, newTag],
          },
          undoStack: [newUndo, ...p.undoStack].slice(0, UNDO_STACK_MAX),
        };
      });
    },
    [setAppState]
  );

  const hideBuiltinTag = useCallback(
    (tagId: string) => {
      setAppState((p) => {
        const tag = p.promptsTagsLibrary.tags.find((t) => t.id === tagId);
        if (!tag || tag.source !== 'builtin') return p;
        const newUndo: UndoAction = {
          id: crypto.randomUUID(),
          label: `Hide tag "${tag.label}"`,
          timestamp: Date.now(),
          kind: 'tag_hide_builtin',
          undoPayload: { tagId },
        };
        return {
          ...p,
          promptsTagsLibrary: {
            ...p.promptsTagsLibrary,
            hiddenBuiltinTagIds: [...p.promptsTagsLibrary.hiddenBuiltinTagIds, tagId],
          },
          undoStack: [newUndo, ...p.undoStack].slice(0, UNDO_STACK_MAX),
        };
      });
    },
    [setAppState]
  );

  const deleteCustomTag = useCallback(
    (tagId: string) => {
      setAppState((p) => {
        const tag = p.promptsTagsLibrary.tags.find((t) => t.id === tagId);
        if (!tag || tag.source !== 'custom') return p;
        const newUndo: UndoAction = {
          id: crypto.randomUUID(),
          label: `Delete tag "${tag.label}"`,
          timestamp: Date.now(),
          kind: 'tag_delete_custom',
          undoPayload: { tag },
        };
        return {
          ...p,
          promptsTagsLibrary: {
            ...p.promptsTagsLibrary,
            tags: p.promptsTagsLibrary.tags.filter((t) => t.id !== tagId),
          },
          undoStack: [newUndo, ...p.undoStack].slice(0, UNDO_STACK_MAX),
        };
      });
    },
    [setAppState]
  );

  const restoreHiddenTag = useCallback(
    (tagId: string) => {
      updateLibrary((lib) => ({
        ...lib,
        hiddenBuiltinTagIds: lib.hiddenBuiltinTagIds.filter((id) => id !== tagId),
      }));
    },
    [updateLibrary]
  );

  const togglePackEnabled = useCallback(
    (packId: string) => {
      setAppState((p) => {
        const wasEnabled = p.promptsTagsLibrary.enabledPackIds.includes(packId);
        const newUndo: UndoAction = {
          id: crypto.randomUUID(),
          label: `${wasEnabled ? 'Disable' : 'Enable'} pack "${packId}"`,
          timestamp: Date.now(),
          kind: 'pack_toggle',
          undoPayload: { packId, wasEnabled },
        };
        return {
          ...p,
          promptsTagsLibrary: {
            ...p.promptsTagsLibrary,
            enabledPackIds: wasEnabled
              ? p.promptsTagsLibrary.enabledPackIds.filter((id) => id !== packId)
              : [...p.promptsTagsLibrary.enabledPackIds, packId],
          },
          undoStack: [newUndo, ...p.undoStack].slice(0, UNDO_STACK_MAX),
        };
      });
    },
    [setAppState]
  );

  const importTagPack = useCallback(
    (raw: TagPackImport): { added: number; merged: number; errors: string[] } => {
      const errors: string[] = [];
      const validTypes: TagType[] = [
        'section', 'source', 'action', 'quality', 'mix', 'genre_marker', 'timing', 'custom',
      ];

      if (!raw.packId || !raw.label || !Array.isArray(raw.tags)) {
        return { added: 0, merged: 0, errors: ['Invalid pack format.'] };
      }

      const addedTagIds: string[] = [];
      let added = 0;
      let merged = 0;

      setAppState((p) => {
        const lib = p.promptsTagsLibrary;
        const existingNorms = new Map(lib.tags.map((t) => [t.normalized, t]));
        const newTags: TagDef[] = [];

        for (const row of raw.tags) {
          if (!row.label || typeof row.label !== 'string') {
            errors.push(`Skipped row — missing label.`);
            continue;
          }
          const normalized = row.label.trim().toLowerCase();
          const type: TagType = validTypes.includes(row.type as TagType)
            ? (row.type as TagType)
            : 'custom';

          if (existingNorms.has(normalized)) {
            // Merge: add packId to existing tag if not already there
            const existing = existingNorms.get(normalized)!;
            if (!existing.packIds.includes(raw.packId)) {
              existing.packIds = [...existing.packIds, raw.packId];
              merged++;
            }
          } else {
            const newTag: TagDef = {
              id: `imported_${crypto.randomUUID()}`,
              label: row.label.trim(),
              normalized,
              type,
              category: row.category ?? 'Imported',
              source: 'custom',
              packIds: [raw.packId],
            };
            newTags.push(newTag);
            addedTagIds.push(newTag.id);
            added++;
          }
        }

        // Add new pack if it doesn't exist yet
        const packExists = lib.packs.some((pk) => pk.id === raw.packId);
        const newPacks = packExists
          ? lib.packs
          : [
              ...lib.packs,
              { id: raw.packId, label: raw.label, builtin: false },
            ];

        const newUndo: UndoAction = {
          id: crypto.randomUUID(),
          label: `Import pack "${raw.label}" (+${added} tags)`,
          timestamp: Date.now(),
          kind: 'pack_import',
          undoPayload: {
            addedTagIds,
            addedPackId: packExists ? null : raw.packId,
          },
        };

        return {
          ...p,
          promptsTagsLibrary: {
            ...lib,
            tags: [...lib.tags, ...newTags],
            packs: newPacks,
          },
          undoStack: [newUndo, ...p.undoStack].slice(0, UNDO_STACK_MAX),
        };
      });

      return { added, merged, errors };
    },
    [setAppState]
  );

  const setSessionActiveTagIds = useCallback(
    (trackId: number, tagIds: string[]) => {
      updateLibrary((lib) => ({
        ...lib,
        sessionActiveTagIdsByTrack: {
          ...lib.sessionActiveTagIdsByTrack,
          [trackId]: tagIds,
        },
      }));
    },
    [updateLibrary]
  );

  const toggleSessionTag = useCallback(
    (trackId: number, tagId: string) => {
      setAppState((p) => {
        const lib = p.promptsTagsLibrary;
        const prev = lib.sessionActiveTagIdsByTrack[trackId] ?? [];
        const isActive = prev.includes(tagId);
        const next = isActive ? prev.filter((id) => id !== tagId) : [...prev, tagId];
        const tag = lib.tags.find((t) => t.id === tagId);
        const newUndo: UndoAction = {
          id: crypto.randomUUID(),
          label: `${isActive ? 'Deactivate' : 'Activate'} tag "${tag?.label ?? tagId}"`,
          timestamp: Date.now(),
          kind: 'session_tag_toggle',
          undoPayload: { trackId, prevActiveIds: prev },
        };
        return {
          ...p,
          promptsTagsLibrary: {
            ...lib,
            sessionActiveTagIdsByTrack: {
              ...lib.sessionActiveTagIdsByTrack,
              [trackId]: next,
            },
          },
          undoStack: [newUndo, ...p.undoStack].slice(0, UNDO_STACK_MAX),
        };
      });
    },
    [setAppState]
  );

  const hideTagInSession = useCallback(
    (trackId: number, tagId: string) => {
      updateLibrary((lib) => ({
        ...lib,
        sessionHiddenTagIdsByTrack: {
          ...lib.sessionHiddenTagIdsByTrack,
          [trackId]: [...(lib.sessionHiddenTagIdsByTrack[trackId] ?? []), tagId],
        },
      }));
    },
    [updateLibrary]
  );

  const addPhraseToBank = useCallback(
    (text: string, source: PhraseEntry['source']) => {
      setAppState((p) => {
        const newPhrase: PhraseEntry = {
          id: crypto.randomUUID(),
          text: text.trim(),
          createdAt: Date.now(),
          source,
        };
        const newUndo: UndoAction = {
          id: crypto.randomUUID(),
          label: `Save phrase`,
          timestamp: Date.now(),
          kind: 'phrase_add',
          undoPayload: { phraseId: newPhrase.id },
        };
        return {
          ...p,
          promptsTagsLibrary: {
            ...p.promptsTagsLibrary,
            phraseBank: [...p.promptsTagsLibrary.phraseBank, newPhrase],
          },
          undoStack: [newUndo, ...p.undoStack].slice(0, UNDO_STACK_MAX),
        };
      });
    },
    [setAppState]
  );

  const removePhraseFromBank = useCallback(
    (phraseId: string) => {
      setAppState((p) => {
        const phrase = p.promptsTagsLibrary.phraseBank.find((ph) => ph.id === phraseId);
        if (!phrase) return p;
        const newUndo: UndoAction = {
          id: crypto.randomUUID(),
          label: `Remove phrase`,
          timestamp: Date.now(),
          kind: 'phrase_remove',
          undoPayload: { phrase },
        };
        return {
          ...p,
          promptsTagsLibrary: {
            ...p.promptsTagsLibrary,
            phraseBank: p.promptsTagsLibrary.phraseBank.filter((ph) => ph.id !== phraseId),
          },
          undoStack: [newUndo, ...p.undoStack].slice(0, UNDO_STACK_MAX),
        };
      });
    },
    [setAppState]
  );

  const addCustomSectionType = useCallback(
    (label: string) => {
      updateLibrary((lib) => {
        const normalized = label.trim().toLowerCase();
        if (lib.customSectionTypes.map((s) => s.toLowerCase()).includes(normalized)) {
          return lib;
        }
        return { ...lib, customSectionTypes: [...lib.customSectionTypes, label.trim()] };
      });
    },
    [updateLibrary]
  );

  // ── Derived values ───────────────────────────────────────────────────────

  const annotator =
    appState.activeTrackId !== null
      ? appState.annotations[appState.activeTrackId]?.annotator ?? ''
      : localStorage.getItem(ANNOTATOR_KEY) ?? '';

  // ── Return ───────────────────────────────────────────────────────────────

  return {
    appState,
    hasSavedState,
    resumeSavedState,
    discardSavedState,
    annotations: appState.annotations,
    activeTrackId: appState.activeTrackId,
    setActiveTrackId,
    phase: appState.phase,
    setPhase,
    markEntryDraft: appState.markEntryDraft,
    setMarkEntryDraft,
    globalCategoryIndex: appState.globalCategoryIndex,
    setGlobalCategoryIndex,
    globalOnSummary: appState.globalOnSummary,
    setGlobalOnSummary,
    timerRunning: appState.timerRunning,
    setTimerRunning,
    annotator,
    setAnnotator,
    updateTimeline,
    updateGlobal,
    setStatus,
    updateElapsedSeconds,
    resetTrack,
    library: appState.promptsTagsLibrary,
    addCustomTag,
    hideBuiltinTag,
    deleteCustomTag,
    restoreHiddenTag,
    togglePackEnabled,
    importTagPack,
    setSessionActiveTagIds,
    toggleSessionTag,
    hideTagInSession,
    addPhraseToBank,
    removePhraseFromBank,
    addCustomSectionType,
    undoStack: appState.undoStack,
    undoLastAction,
    pushUndo,
  };
}
