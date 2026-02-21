import { useState, useEffect, useRef } from 'react';
import type { TrackAnnotation, Phase, GlobalAnalysis } from '../types';
import { GLOBAL_CATEGORIES } from '../lib/schema';
import { polishText, PolishUnavailableError } from '../lib/polishText';
import { lintAnnotation } from '../lib/lintAnnotation';
import { LintPanel } from './LintPanel';
import { useKeyboardShortcuts } from '../hooks';

interface Props {
  annotation: TrackAnnotation;
  categoryIndex: number;
  onSummary: boolean;
  setCategoryIndex: (i: number) => void;
  setOnSummary: (v: boolean) => void;
  updateGlobal: (trackId: number, global: Partial<GlobalAnalysis>) => void;
  setStatus: (trackId: number, status: TrackAnnotation['status'], extra?: Partial<TrackAnnotation>) => void;
  setPhase: (p: Phase) => void;
}

export function PhaseGlobal({
  annotation,
  categoryIndex,
  onSummary,
  setCategoryIndex,
  setOnSummary,
  updateGlobal,
  setStatus,
  setPhase,
}: Props) {
  const track = annotation.track;
  const global = annotation.global as Record<string, string>;

  const cat = GLOBAL_CATEGORIES[categoryIndex];

  const [localValue, setLocalValue] = useState<string>(
    global[cat.key] ?? ''
  );
  const [polishStatus, setPolishStatus] = useState<'idle' | 'loading' | 'ready'>('idle');
  const [polishedText, setPolishedText] = useState('');
  const [polishCooldown, setPolishCooldown] = useState(false);
  const [polishToast, setPolishToast] = useState<string | null>(null);
  const [showLint, setShowLint] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync localValue when category changes
  useEffect(() => {
    setLocalValue(global[cat.key] ?? '');
    setPolishStatus('idle');
    setPolishedText('');
    setPolishToast(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryIndex, cat.key]);

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }, [localValue]);

  function save() {
    updateGlobal(track.id, { ...annotation.global, [cat.key]: localValue });
  }

  function goNext() {
    save();
    if (categoryIndex < GLOBAL_CATEGORIES.length - 1) {
      setCategoryIndex(categoryIndex + 1);
    } else {
      setOnSummary(true);
    }
  }

  function goPrev() {
    save();
    if (categoryIndex > 0) {
      setCategoryIndex(categoryIndex - 1);
    }
  }

  function goDot(i: number) {
    save();
    setCategoryIndex(i);
    setOnSummary(false);
  }

  useKeyboardShortcuts([
    { key: ']', handler: goNext },
    { key: '[', handler: goPrev },
  ]);

  // Polish
  async function handlePolish() {
    if (!localValue.trim() || polishCooldown) return;
    setPolishStatus('loading');
    setPolishToast(null);
    try {
      const result = await polishText(localValue, { type: 'global', category: cat });
      setPolishedText(result);
      setPolishStatus('ready');
    } catch (e) {
      if (e instanceof PolishUnavailableError) {
        setPolishToast('Style clean-up unavailable — your notes were kept');
      } else {
        setPolishToast('Style clean-up failed — your notes were kept');
      }
      setPolishStatus('idle');
    }
    setPolishCooldown(true);
    setTimeout(() => setPolishCooldown(false), 1500);
  }

  function acceptPolished() {
    setLocalValue(polishedText);
    setPolishStatus('idle');
    setPolishedText('');
  }

  // FIX #5: setLocalValue is async React state update. Call save with the
  // explicit value directly rather than relying on localValue being updated yet.
  function handleNA() {
    setLocalValue('N/A');
    // Write 'N/A' directly — don't call save() which would read stale localValue
    updateGlobal(track.id, { ...annotation.global, [cat.key]: 'N/A' });
  }

  const filledCount = GLOBAL_CATEGORIES.filter((c) => {
    const v = global[c.key];
    return v && v.trim();
  }).length;

  // ── SUMMARY SCREEN ──────────────────────────────────────────────────────
  if (onSummary) {
    const lintResult = lintAnnotation(annotation);

    return (
      <div className="phase-container fade-in">
        <div style={{ marginBottom: '1.5rem' }}>
          <p className="label" style={{ color: 'var(--amber)', marginBottom: '0.25rem' }}>
            TRACK {track.id} — PART 2 SUMMARY
          </p>
          <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', margin: 0 }}>
            Global Analysis Review
          </h2>
        </div>

        <div style={{ marginBottom: '1.5rem' }}>
          {GLOBAL_CATEGORIES.map((c, i) => (
            <div key={c.key} className="summary-row">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <p className="label" style={{ marginBottom: '0.25rem', fontSize: '0.6875rem' }}>
                  {c.displayLabel}
                </p>
                <button
                  className="btn-link"
                  style={{ fontSize: '0.75rem' }}
                  onClick={() => { setCategoryIndex(i); setOnSummary(false); }}
                >
                  Edit
                </button>
              </div>
              <p style={{ margin: 0, color: global[c.key] ? 'var(--text)' : 'var(--text-dim)', fontFamily: 'var(--font-serif)', fontSize: '0.9375rem' }}>
                {global[c.key] || '—'}
              </p>
            </div>
          ))}
        </div>

        {showLint && (
          <div style={{ marginBottom: '1.5rem' }}>
            <LintPanel
              result={lintResult}
              onNavigate={(phase) => setPhase(phase)}
            />
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {!showLint && (
            <button className="btn-ghost" onClick={() => setShowLint(true)}>
              RUN QUALITY CHECK →
            </button>
          )}
          <button
            className="btn-primary"
            style={{ width: '100%' }}
            onClick={() => {
              setStatus(track.id, 'complete', { completedAt: Date.now() });
              setPhase('review');
            }}
          >
            GO TO REVIEW →
          </button>
        </div>
      </div>
    );
  }

  // ── CATEGORY SCREEN ─────────────────────────────────────────────────────
  return (
    <div className="phase-container fade-in">
      {/* Progress */}
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.375rem' }}>
          <p className="label" style={{ color: 'var(--amber)' }}>TRACK {track.id} — PART 2</p>
          <span className="label">{filledCount} of 9 filled</span>
        </div>
        <div style={{ display: 'flex', height: '3px', gap: '2px' }}>
          {GLOBAL_CATEGORIES.map((c, i) => {
            const filled = !!(global[c.key]?.trim());
            return (
              <div
                key={c.key}
                style={{
                  flex: 1,
                  background: filled ? 'var(--amber)' : 'var(--border)',
                  borderRadius: 2,
                  transition: 'background 200ms',
                }}
              />
            );
          })}
        </div>
      </div>

      {/* Category header */}
      <div style={{ marginBottom: '1rem' }}>
        <p className="label" style={{ color: 'var(--amber)', fontSize: '0.75rem', marginBottom: '0.25rem' }}>
          {cat.displayLabel}
          {cat.canBeNA && (
            <span style={{ color: 'var(--text-dim)', marginLeft: '0.5rem' }}>
              (can be N/A if not applicable)
            </span>
          )}
        </p>
        <p style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-serif)', fontSize: '0.9rem', margin: 0, lineHeight: 1.6 }}>
          {cat.guidance}
        </p>
      </div>

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={localValue}
        onChange={(e) => {
          setLocalValue(e.target.value);
          const ta = e.target;
          ta.style.height = 'auto';
          ta.style.height = ta.scrollHeight + 'px';
        }}
        placeholder="Your observation…"
        className="text-area"
        style={{ minHeight: '7rem', marginBottom: '0.5rem' }}
      />

      {/* Polish */}
      {localValue.trim() && (
        <div style={{ marginBottom: '0.75rem' }}>
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
                <p className="label" style={{ marginBottom: '0.25rem', color: 'var(--text-dim)', fontSize: '0.6875rem' }}>YOUR NOTES</p>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', fontFamily: 'var(--font-serif)' }}>{localValue}</p>
              </div>
              <div className="polish-col">
                <p className="label" style={{ marginBottom: '0.25rem', color: 'var(--amber)', fontSize: '0.6875rem' }}>CLEANED UP</p>
                <textarea
                  value={polishedText}
                  onChange={(e) => setPolishedText(e.target.value)}
                  className="text-area"
                  style={{ minHeight: '4rem', fontSize: '0.875rem' }}
                />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <button className="btn-ghost btn-small" onClick={() => { setPolishStatus('idle'); setPolishedText(''); }}>
                  Keep original
                </button>
                <button className="btn-primary btn-small" onClick={acceptPolished}>
                  Use cleaned version
                </button>
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

      {/* Suggested tags */}
      {cat.suggestedTags && (
        <div style={{ marginBottom: '0.75rem' }}>
          <p className="label" style={{ marginBottom: '0.375rem', fontSize: '0.6875rem' }}>
            QUICK ADD →
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
            {cat.suggestedTags.map((tag) => (
              <button
                key={tag}
                className="chip chip--small"
                onClick={() => {
                  setLocalValue((prev) => prev ? `${prev}, ${tag}` : tag);
                }}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* N/A button */}
      {cat.canBeNA && (
        <button
          className="btn-ghost btn-small"
          onClick={handleNA}
          style={{ marginBottom: '1rem' }}
        >
          → Mark as N/A
        </button>
      )}

      {/* Navigation */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '1.5rem' }}>
        <button
          className="btn-ghost"
          disabled={categoryIndex === 0}
          onClick={goPrev}
        >
          ← PREV
        </button>

        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          {GLOBAL_CATEGORIES.map((c, i) => {
            const filled = !!(global[c.key]?.trim());
            const isCurrent = i === categoryIndex;
            return (
              <button
                key={c.key}
                onClick={() => goDot(i)}
                style={{
                  width: isCurrent ? '8px' : '6px',
                  height: isCurrent ? '8px' : '6px',
                  borderRadius: '50%',
                  background: isCurrent
                    ? 'var(--amber)'
                    : filled
                    ? 'var(--amber-bg)'
                    : 'transparent',
                  border: isCurrent
                    ? '1px solid var(--amber)'
                    : filled
                    ? '1px solid var(--amber)'
                    : '1px solid var(--border-active)',
                  padding: 0,
                  cursor: 'pointer',
                  boxShadow: isCurrent ? '0 0 6px var(--amber)' : 'none',
                  transition: 'all 200ms',
                }}
              />
            );
          })}
          <span className="kbd-hint" style={{ marginLeft: '0.375rem' }}>
            [ ] to navigate
          </span>
        </div>

        <button className="btn-primary btn-small" onClick={goNext}>
          {categoryIndex === GLOBAL_CATEGORIES.length - 1 ? 'FINISH →' : 'NEXT →'}
        </button>
      </div>
    </div>
  );
}
