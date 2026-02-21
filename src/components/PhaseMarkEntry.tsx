// FIX #6: wasPolished tracked locally, set true only when user accepts cleaned text.
// FIX #7: narrativeRaw is a one-time snapshot taken at mount; never overwritten on keystrokes.
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type {
  TrackAnnotation,
  Phase,
  MarkEntryDraft,
  TimelineEntry,
  PromptsTagsLibraryState,
  TagDef,
} from '../types';
import {
  SECTION_TYPE_SHORTCUTS,
  NARRATIVE_PROMPTS_FIRST,
  NARRATIVE_PROMPTS_SUBSEQUENT,
} from '../lib/schema';
import { groupTagsByCategory } from '../lib/tagLibrary';
import {
  buildAllPhraseVariants,
  WHO_SUGGESTIONS,
  WHAT_SUGGESTIONS,
  WHERE_SUGGESTIONS,
  WHEN_SUGGESTIONS,
} from '../lib/phraseBuilder';
import { polishText, PolishUnavailableError } from '../lib/polishText';
import { useKeyboardShortcuts } from '../hooks';

interface Props {
  annotation: TrackAnnotation;
  draft: MarkEntryDraft;
  setMarkEntryDraft: (d: MarkEntryDraft | null) => void;
  setPhase: (p: Phase) => void;
  updateTimeline: (trackId: number, entries: TimelineEntry[]) => void;
  onTimerResume: () => void;
  onTimerPause: () => void;
  library: PromptsTagsLibraryState;
}

const TIMESTAMP_RE = /^\d+:[0-5]\d$/;

function parseToSeconds(mss: string): number {
  const match = mss.match(/^(\d+):([0-5]\d)$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return parseInt(match[1]) * 60 + parseInt(match[2]);
}

function nudgeTimestamp(ts: string, deltaSec: number): string {
  const secs = parseToSeconds(ts);
  if (secs === Number.MAX_SAFE_INTEGER) return ts;
  const newSecs = Math.max(0, secs + deltaSec);
  return `${Math.floor(newSecs / 60)}:${String(newSecs % 60).padStart(2, '0')}`;
}

/** Match existing tag string labels back to library tag IDs (for edit mode). */
function initSelectedTagIds(tagsStr: string, allTags: TagDef[]): string[] {
  if (!tagsStr.trim()) return [];
  const labels = new Set(tagsStr.split(',').map((s) => s.trim().toLowerCase()));
  return allTags.filter((t) => labels.has(t.normalized)).map((t) => t.id);
}

/** Return tag labels from the string that have no match in the library (keep as custom text). */
function initCustomTagText(tagsStr: string, allTags: TagDef[]): string {
  if (!tagsStr.trim()) return '';
  const normalized = new Set(allTags.map((t) => t.normalized));
  const unmatched = tagsStr
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !normalized.has(s.toLowerCase()));
  return unmatched.join(', ');
}

export function PhaseMarkEntry({
  annotation,
  draft,
  setMarkEntryDraft,
  setPhase,
  updateTimeline,
  onTimerResume,
  onTimerPause,
  library,
}: Props) {
  const track = annotation.track;
  const timeline = annotation.timeline;

  // ── Timestamp ──────────────────────────────────────────────────────────────
  const [timestamp, setTimestamp] = useState(draft.timestamp);
  const [tsEditing, setTsEditing] = useState(false);
  const [tsRaw, setTsRaw] = useState(draft.timestamp);

  // ── Section type ───────────────────────────────────────────────────────────
  const [sectionType, setSectionType] = useState(draft.sectionType);
  const [sectionTypeCustom, setSectionTypeCustom] = useState(
    SECTION_TYPE_SHORTCUTS.includes(draft.sectionType) ? '' : draft.sectionType
  );
  const [sectionOpen, setSectionOpen] = useState(!draft.sectionType);

  // ── Narrative ──────────────────────────────────────────────────────────────
  const [narrative, setNarrative] = useState(draft.narrative);
  const narrativeRawRef = useRef<string>(draft.narrativeRaw || draft.narrative);
  const narrativeRef = useRef<HTMLTextAreaElement>(null);

  // ── Tags — structured ──────────────────────────────────────────────────────
  // Effective visible tags (from enabled packs, not hidden)
  const visibleTags = useMemo(() => {
    const hiddenIds = new Set(library.hiddenBuiltinTagIds);
    return library.tags.filter((t) => {
      if (t.source === 'builtin' && hiddenIds.has(t.id)) return false;
      if (t.packIds.length > 0 && !t.packIds.some((pid) => library.enabledPackIds.includes(pid))) return false;
      return true;
    });
  }, [library]);

  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(() =>
    initSelectedTagIds(draft.tags, visibleTags)
  );
  const [customTagText, setCustomTagText] = useState(() =>
    initCustomTagText(draft.tags, library.tags)
  );
  const [tagsOpen, setTagsOpen] = useState(false);
  const [tagSearch, setTagSearch] = useState('');

  // Compute derived tags string (for save + draft sync)
  const tagsString = useMemo(() => {
    const tagMap = new Map(visibleTags.map((t) => [t.id, t.label]));
    const selected = selectedTagIds.map((id) => tagMap.get(id) ?? '').filter(Boolean);
    const custom = customTagText.trim();
    return [...selected, ...(custom ? [custom] : [])].join(', ');
  }, [selectedTagIds, customTagText, visibleTags]);

  function toggleTag(id: string) {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  // Filtered + grouped tags for display
  const filteredTags = useMemo(() => {
    if (!tagSearch.trim()) return visibleTags;
    const q = tagSearch.trim().toLowerCase();
    return visibleTags.filter(
      (t) => t.normalized.includes(q) || t.category.toLowerCase().includes(q)
    );
  }, [visibleTags, tagSearch]);

  const groupedTags = useMemo(() => groupTagsByCategory(filteredTags), [filteredTags]);
  const isSearching = tagSearch.trim().length > 0;

  // ── Phrase builder ─────────────────────────────────────────────────────────
  const [phraseOpen, setPhraseOpen] = useState(false);
  const [phraseWho, setPhraseWho] = useState('');
  const [phraseWhat, setPhraseWhat] = useState('');
  const [phraseWhere, setPhraseWhere] = useState('');
  const [phraseWhen, setPhraseWhen] = useState('');
  const [phraseVariantIdx, setPhraseVariantIdx] = useState(0);

  const phraseVariants = useMemo(
    () => buildAllPhraseVariants({ who: phraseWho, what: phraseWhat, where: phraseWhere, when: phraseWhen }),
    [phraseWho, phraseWhat, phraseWhere, phraseWhen]
  );
  const currentPhrase = phraseVariants[phraseVariantIdx % Math.max(1, phraseVariants.length)] ?? '';

  function insertPhrase() {
    if (!currentPhrase) return;
    setNarrative((prev) => {
      const trimmed = prev.trimEnd();
      if (!trimmed) return currentPhrase;
      return `${trimmed} ${currentPhrase}`;
    });
  }

  // ── Polish ─────────────────────────────────────────────────────────────────
  const [wasPolishedThisSession, setWasPolishedThisSession] = useState(false);
  const [polishStatus, setPolishStatus] = useState<'idle' | 'loading' | 'ready'>('idle');
  const [polishedText, setPolishedText] = useState('');
  const [polishCooldown, setPolishCooldown] = useState(false);
  const [polishToast, setPolishToast] = useState<string | null>(null);

  // ── Draft sync ─────────────────────────────────────────────────────────────
  const syncDraft = useCallback(() => {
    setMarkEntryDraft({
      ...draft,
      timestamp,
      sectionType,
      narrative,
      narrativeRaw: narrativeRawRef.current,
      tags: tagsString,
    });
  }, [draft, timestamp, sectionType, narrative, tagsString, setMarkEntryDraft]);

  useEffect(() => { syncDraft(); }, [timestamp, sectionType, narrative, tagsString]);

  // Restore timer on unmount
  useEffect(() => {
    return () => { if (draft.wasTimerRunning) onTimerResume(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-resize textarea
  useEffect(() => {
    const ta = narrativeRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }, [narrative]);

  // ── Context ────────────────────────────────────────────────────────────────
  const prevEntry = (() => {
    if (draft.mode === 'edit' && draft.entryId) {
      const idx = timeline.findIndex((e) => e.id === draft.entryId);
      return idx > 0 ? timeline[idx - 1] : null;
    }
    return timeline.length > 0 ? timeline[timeline.length - 1] : null;
  })();

  const isFirstSection = !prevEntry;
  const narrativePrompts = isFirstSection ? NARRATIVE_PROMPTS_FIRST : NARRATIVE_PROMPTS_SUBSEQUENT;
  const timestampValid = TIMESTAMP_RE.test(timestamp);

  // ── Handlers ───────────────────────────────────────────────────────────────
  function handleTsBlur() {
    if (TIMESTAMP_RE.test(tsRaw)) setTimestamp(tsRaw);
    setTsEditing(false);
  }

  function nudge(delta: number) {
    const nudged = nudgeTimestamp(timestamp, delta);
    setTimestamp(nudged);
    setTsRaw(nudged);
  }

  function handleChipClick(shortcut: string) {
    setSectionType(shortcut);
    setSectionTypeCustom('');
  }

  function handleCustomType(val: string) {
    setSectionTypeCustom(val);
    setSectionType(val);
  }

  async function handlePolish() {
    if (!narrative.trim() || polishCooldown) return;
    setPolishStatus('loading');
    setPolishToast(null);
    try {
      const result = await polishText(narrative, {
        type: 'timeline',
        sectionType,
        timestamp,
        prev: prevEntry
          ? { sectionType: prevEntry.sectionType, narrative: prevEntry.narrative }
          : undefined,
      });
      setPolishedText(result);
      setPolishStatus('ready');
    } catch (e) {
      setPolishToast(
        e instanceof PolishUnavailableError
          ? 'Style clean-up unavailable — your notes were kept'
          : 'Style clean-up failed — your notes were kept'
      );
      setPolishStatus('idle');
    }
    setPolishCooldown(true);
    setTimeout(() => setPolishCooldown(false), 1500);
  }

  function acceptPolished() {
    setNarrative(polishedText);
    setWasPolishedThisSession(true);
    setPolishStatus('idle');
    setPolishedText('');
  }

  function keepOriginal() {
    setPolishStatus('idle');
    setPolishedText('');
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  const canSave = sectionType.trim() && narrative.trim() && timestampValid;

  function handleSave() {
    if (!canSave) return;
    const existingEntry =
      draft.mode === 'edit' && draft.entryId
        ? timeline.find((e) => e.id === draft.entryId)
        : undefined;

    const entry: TimelineEntry = {
      id: draft.mode === 'edit' && draft.entryId ? draft.entryId : uuidv4(),
      timestamp,
      sectionType: sectionType.trim(),
      narrative: narrative.trim(),
      narrativeRaw: narrativeRawRef.current || narrative.trim(),
      tags: tagsString,
      wasPolished: wasPolishedThisSession || (existingEntry?.wasPolished ?? false),
      isDictated: draft.isDictated,
    };

    let newTimeline: TimelineEntry[];
    if (draft.mode === 'edit' && draft.entryId) {
      newTimeline = timeline.map((e) => (e.id === draft.entryId ? entry : e));
    } else {
      newTimeline = [...timeline, entry];
    }
    newTimeline.sort((a, b) => parseToSeconds(a.timestamp) - parseToSeconds(b.timestamp));

    updateTimeline(track.id, newTimeline);
    setMarkEntryDraft(null);
    setPhase('listening');
  }

  function handleDiscard() {
    if (narrative.trim()) {
      if (!window.confirm('Discard this section?')) return;
    }
    setMarkEntryDraft(null);
    setPhase('listening');
  }

  useKeyboardShortcuts([
    { key: 'Enter', ctrl: true, handler: handleSave, allowInInput: true },
    { key: 'Escape', handler: handleDiscard },
  ]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="mark-entry-overlay" onClick={handleDiscard}>
      <div className="mark-entry-panel slide-up" onClick={(e) => e.stopPropagation()}>

        {/* ── Sticky header: timestamp + actions ── */}
        <div style={{
          position: 'sticky', top: 0, zIndex: 10,
          background: 'var(--surface)', borderBottom: '1px solid var(--border)',
          padding: '0.75rem 1.25rem',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem',
        }}>
          <div style={{ minWidth: 0 }}>
            <p className="label" style={{ marginBottom: '0.2rem' }}>
              {draft.mode === 'edit' ? 'EDIT SECTION' : 'NEW SECTION'}
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              {tsEditing ? (
                <input
                  autoFocus
                  type="text"
                  value={tsRaw}
                  onChange={(e) => setTsRaw(e.target.value)}
                  onBlur={handleTsBlur}
                  onKeyDown={(e) => e.key === 'Enter' && handleTsBlur()}
                  style={{
                    fontFamily: 'var(--font-mono)', fontSize: '1.75rem',
                    color: timestampValid ? 'var(--amber)' : 'var(--error)',
                    background: 'transparent',
                    border: `1px solid ${timestampValid ? 'var(--border-active)' : 'var(--error)'}`,
                    borderRadius: 'var(--radius)', width: '6rem', padding: '0.25rem',
                  }}
                />
              ) : (
                <button
                  onClick={() => { setTsEditing(true); setTsRaw(timestamp); }}
                  style={{
                    fontFamily: 'var(--font-mono)', fontSize: '1.75rem', color: 'var(--amber)',
                    background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                  }}
                  title="Click to edit timestamp"
                >
                  {timestamp}
                </button>
              )}
              <div style={{ display: 'flex', gap: '0.25rem' }}>
                {[-5, -1, +1, +5].map((d) => (
                  <button key={d} className="nudge-btn" onClick={() => nudge(d)}>
                    {d > 0 ? `+${d}s` : `${d}s`}
                  </button>
                ))}
              </div>
            </div>
            {!timestampValid && (
              <p style={{ color: 'var(--error)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', marginTop: '0.125rem' }}>
                Use M:SS format
              </p>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.375rem', flexShrink: 0 }}>
            <button className="btn-primary btn-small" disabled={!canSave} onClick={handleSave}>
              SAVE
            </button>
            <button className="btn-ghost btn-destructive btn-small" onClick={handleDiscard}>
              DISCARD
            </button>
            <span className="kbd-hint" style={{ marginTop: '0.125rem' }}>⌘↵ save · Esc discard</span>
          </div>
        </div>

        {/* ── Dictated badge ── */}
        {draft.isDictated && (
          <div style={{
            margin: '0.75rem 1.25rem 0',
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.375rem 0.625rem', background: 'var(--amber-bg)',
            border: '1px solid var(--amber)', borderRadius: 'var(--radius)',
          }}>
            <span style={{ fontSize: '0.875rem' }}>🎙</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--amber)' }}>
              DICTATED — transcript pre-filled below
            </span>
          </div>
        )}

        {/* ── Previous section reference (always visible) ── */}
        <div style={{ padding: '0.75rem 1.25rem 0' }}>
          <div className="prev-section-ref">
            {prevEntry ? (
              <>
                <p style={{ margin: '0 0 0.25rem', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                  ← Previous: {prevEntry.sectionType} at {prevEntry.timestamp}
                </p>
                <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical' }}>
                  {prevEntry.narrative}
                </p>
              </>
            ) : (
              <p style={{ margin: 0, fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                Opening section — describe what you hear at 0:00
              </p>
            )}
          </div>
        </div>

        {/* ── QUICK NOTES (was "Describe this section") ── */}
        <div style={{ padding: '1rem 1.25rem 0' }}>
          <label className="label" style={{ display: 'block', marginBottom: '0.375rem' }}>
            QUICK NOTES <span style={{ color: 'var(--error)' }}>*</span>
          </label>
          <div style={{ marginBottom: '0.5rem' }}>
            {narrativePrompts.map((prompt, i) => (
              <p key={i} style={{ margin: '0 0 0.125rem', fontFamily: 'var(--font-mono)', fontSize: '0.6875rem', color: 'var(--text-dim)' }}>
                › {prompt}
              </p>
            ))}
          </div>
          <textarea
            ref={narrativeRef}
            value={narrative}
            onChange={(e) => {
              setNarrative(e.target.value);
              const ta = e.target;
              ta.style.height = 'auto';
              ta.style.height = ta.scrollHeight + 'px';
            }}
            placeholder="Type rough notes freely…"
            className="text-area"
            style={{ minHeight: '6rem' }}
          />

          {/* Polish */}
          {narrative.trim() && (
            <div style={{ marginTop: '0.5rem' }}>
              {polishStatus === 'idle' && (
                <button
                  className={`btn-ghost btn-small ${polishCooldown ? 'btn-cooling' : ''}`}
                  onClick={handlePolish}
                  disabled={polishCooldown}
                >
                  {polishCooldown ? '◌ cooling down' : 'Clean up style ✦'}
                </button>
              )}
              {polishStatus === 'loading' && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  Cleaning…
                </span>
              )}
              {polishStatus === 'ready' && (
                <div className="polish-diff">
                  <div className="polish-col">
                    <p className="label" style={{ marginBottom: '0.375rem', color: 'var(--text-dim)' }}>YOUR NOTES</p>
                    <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', fontFamily: 'var(--font-serif)' }}>{narrative}</p>
                  </div>
                  <div className="polish-col">
                    <p className="label" style={{ marginBottom: '0.375rem', color: 'var(--amber)' }}>CLEANED UP</p>
                    <textarea
                      value={polishedText}
                      onChange={(e) => setPolishedText(e.target.value)}
                      className="text-area"
                      style={{ minHeight: '4rem', fontSize: '0.875rem' }}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                    <button className="btn-ghost btn-small" onClick={keepOriginal}>Keep original</button>
                    <button className="btn-primary btn-small" onClick={acceptPolished}>Use cleaned version</button>
                  </div>
                </div>
              )}
              {polishToast && (
                <p style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', marginTop: '0.25rem' }}>
                  {polishToast}
                </p>
              )}
            </div>
          )}
        </div>

        {/* ── PHRASE BUILDER (collapsible, under Quick Notes) ── */}
        <div style={{ padding: '0.75rem 1.25rem 0' }}>
          <button
            className="btn-ghost btn-small"
            onClick={() => setPhraseOpen((v) => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}
          >
            <span>{phraseOpen ? '▾' : '▸'}</span>
            <span>PHRASE BUILDER</span>
            <span style={{ color: 'var(--text-dim)', fontSize: '0.65rem', marginLeft: '0.25rem' }}>
              Who / What / Where / When
            </span>
          </button>

          {phraseOpen && (
            <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                <PhraseCombo label="Who" value={phraseWho} onChange={setPhraseWho} suggestions={WHO_SUGGESTIONS} />
                <PhraseCombo label="What" value={phraseWhat} onChange={setPhraseWhat} suggestions={WHAT_SUGGESTIONS} />
                <PhraseCombo label="Where" value={phraseWhere} onChange={setPhraseWhere} suggestions={WHERE_SUGGESTIONS} />
                <PhraseCombo label="When" value={phraseWhen} onChange={setPhraseWhen} suggestions={WHEN_SUGGESTIONS} />
              </div>

              {currentPhrase && (
                <div style={{
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)', padding: '0.5rem 0.75rem',
                  fontFamily: 'var(--font-serif)', fontSize: '0.9rem', color: 'var(--text)',
                }}>
                  {currentPhrase}
                </div>
              )}

              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                {phraseVariants.length > 1 && (
                  <button
                    className="btn-ghost btn-small"
                    onClick={() => setPhraseVariantIdx((i) => (i + 1) % phraseVariants.length)}
                  >
                    ↻ VARIANT
                  </button>
                )}
                <button
                  className="btn-primary btn-small"
                  onClick={insertPhrase}
                  disabled={!currentPhrase}
                >
                  INSERT →
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── SECTION TYPE (collapsible) ── */}
        <div style={{ padding: '0.75rem 1.25rem 0' }}>
          <button
            className="btn-ghost btn-small"
            onClick={() => setSectionOpen((v) => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', width: '100%', justifyContent: 'space-between' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <span>{sectionOpen ? '▾' : '▸'}</span>
              <span>SECTION TYPE <span style={{ color: 'var(--error)' }}>*</span></span>
            </span>
            {sectionType && !sectionOpen && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--amber)' }}>
                {sectionType}
              </span>
            )}
          </button>

          {sectionOpen && (
            <div style={{ marginTop: '0.625rem' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginBottom: '0.5rem' }}>
                {[...SECTION_TYPE_SHORTCUTS, ...library.customSectionTypes].map((s) => (
                  <button
                    key={s}
                    className={`chip ${sectionType === s && !sectionTypeCustom ? 'chip--selected' : ''}`}
                    onClick={() => handleChipClick(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={sectionTypeCustom}
                onChange={(e) => handleCustomType(e.target.value)}
                placeholder="Or type your own section name"
                className="text-input"
                style={{ fontSize: '0.875rem' }}
              />
            </div>
          )}
        </div>

        {/* ── TAGS (collapsible) ── */}
        <div style={{ padding: '0.75rem 1.25rem 0' }}>
          <button
            className="btn-ghost btn-small"
            onClick={() => setTagsOpen((v) => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', width: '100%', justifyContent: 'space-between' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <span>{tagsOpen ? '▾' : '▸'}</span>
              <span>TAGS</span>
              {selectedTagIds.length > 0 && (
                <span style={{
                  background: 'var(--amber)', color: 'var(--bg)',
                  borderRadius: 'var(--radius-pill)', fontSize: '0.65rem',
                  padding: '0.1rem 0.4rem', fontFamily: 'var(--font-mono)',
                }}>
                  {selectedTagIds.length}
                </span>
              )}
            </span>
            {tagsString && !tagsOpen && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-muted)', maxWidth: '55%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {tagsString}
              </span>
            )}
          </button>

          {/* Tag search — always visible (outside collapse) */}
          <div style={{ marginTop: '0.5rem' }}>
            <input
              type="text"
              placeholder="Search tags…"
              value={tagSearch}
              onChange={(e) => { setTagSearch(e.target.value); if (!tagsOpen) setTagsOpen(true); }}
              className="text-input"
              style={{ fontSize: '0.8rem' }}
            />
          </div>

          {/* Tag chips — shown when open OR searching */}
          {(tagsOpen || isSearching) && (
            <div style={{ marginTop: '0.625rem' }}>
              {isSearching ? (
                // Flat search results
                <div>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', marginBottom: '0.375rem' }}>
                    MATCHES ({filteredTags.length})
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                    {filteredTags.map((tag) => (
                      <TagChip
                        key={tag.id}
                        tag={tag}
                        selected={selectedTagIds.includes(tag.id)}
                        onToggle={() => toggleTag(tag.id)}
                      />
                    ))}
                    {filteredTags.length === 0 && (
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-dim)' }}>
                        No matches
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                // Grouped categories
                groupedTags.map(([category, tags]) => (
                  <div key={category} style={{ marginBottom: '0.625rem' }}>
                    <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', marginBottom: '0.25rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      {category}
                    </p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
                      {tags.map((tag) => (
                        <TagChip
                          key={tag.id}
                          tag={tag}
                          selected={selectedTagIds.includes(tag.id)}
                          onToggle={() => toggleTag(tag.id)}
                        />
                      ))}
                    </div>
                  </div>
                ))
              )}

              {/* Custom tag text input */}
              <div style={{ marginTop: '0.5rem' }}>
                <input
                  type="text"
                  value={customTagText}
                  onChange={(e) => setCustomTagText(e.target.value)}
                  placeholder="Additional tags (comma-separated)…"
                  className="text-input"
                  style={{ fontSize: '0.8rem' }}
                />
              </div>

              {/* Copy from prev */}
              {prevEntry?.tags && (
                <button
                  className="btn-ghost btn-small"
                  onClick={() => {
                    const newIds = initSelectedTagIds(prevEntry.tags, visibleTags);
                    setSelectedTagIds(newIds);
                    setCustomTagText(initCustomTagText(prevEntry.tags, library.tags));
                  }}
                  style={{ marginTop: '0.375rem' }}
                >
                  Copy tags from {prevEntry.sectionType}
                </button>
              )}
            </div>
          )}
        </div>

        <div style={{ height: '2rem' }} />
      </div>
    </div>
  );
}

// ─── Tag Chip ─────────────────────────────────────────────────────────────────

function TagChip({ tag, selected, onToggle }: { tag: TagDef; selected: boolean; onToggle: () => void }) {
  return (
    <button
      className={`chip chip--small ${selected ? 'chip--selected' : ''}`}
      onClick={onToggle}
      title={tag.type}
    >
      {tag.label}
    </button>
  );
}

// ─── Phrase Combo (datalist combo input) ─────────────────────────────────────

function PhraseCombo({
  label,
  value,
  onChange,
  suggestions,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  suggestions: string[];
}) {
  const listId = `phrase-${label.toLowerCase()}`;
  return (
    <div>
      <p style={{ fontFamily: 'var(--font-mono)', fontSize: '0.65rem', color: 'var(--text-dim)', marginBottom: '0.2rem', textTransform: 'uppercase' }}>
        {label}
      </p>
      <input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`${label}…`}
        className="text-input"
        style={{ fontSize: '0.8rem' }}
      />
      <datalist id={listId}>
        {suggestions.map((s) => <option key={s} value={s} />)}
      </datalist>
    </div>
  );
}
