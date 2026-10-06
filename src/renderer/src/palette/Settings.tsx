// Settings, as a small page inside the palette. Each change saves on its own
// (text fields when you leave them or press ↵).
import type { Autonomy, Settings as SettingsT } from '@shared/model';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { bridge } from '../bridge';
import { useIae } from '../state/store';
import { MinusIcon, PlusIcon } from '../ui/icons';
import s from './Palette.module.css';

const AUTONOMY: { value: Autonomy; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask first', hint: 'Builders ask before they change a file or run a command.' },
  { value: 'edits', label: 'Edit files freely', hint: 'Builders change files on their own, and ask before running a command.' },
  { value: 'full', label: 'Full autonomy', hint: 'Builders never stop to ask. Best on a branch you can throw away.' },
];

const MAX_BUILDERS = 8;

export function SettingsView() {
  const settings = useIae((st) => st.settings);
  const [saved, setSaved] = useState(0);

  const save = async (patch: Partial<SettingsT>) => {
    const next = await bridge.setSettings(patch);
    useIae.setState({ settings: next });
    setSaved(Date.now());
  };

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(0), 1600);
    return () => clearTimeout(t);
  }, [saved]);

  return (
    <div className={s.settings}>
      <div className={s.savedSlot} aria-live="polite">
        <AnimatePresence>
          {saved > 0 && (
            <motion.span key={saved} className={s.saved} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              Saved
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <Field label="Lead's name" hint="Who you talk to.">
        <TextSetting label="Lead's name" value={settings.leadName} onCommit={(v) => v && save({ leadName: v })} autoFocus />
      </Field>
      <Field label="Lead model" hint="Fast and warm. Answers in about a second.">
        <TextSetting label="Lead model" value={settings.leadModel} mono onCommit={(v) => v && save({ leadModel: v })} />
      </Field>
      <Field label="Builder model" hint="Does the real work in each Claude Code session.">
        <TextSetting label="Builder model" value={settings.builderModel} mono onCommit={(v) => v && save({ builderModel: v })} />
      </Field>

      <div className={s.fieldBlock}>
        <span className={s.fieldLabel}>Autonomy</span>
        <div className={s.choices} role="radiogroup" aria-label="Autonomy">
          {AUTONOMY.map((a) => {
            const on = settings.autonomy === a.value;
            return (
              <button
                key={a.value}
                type="button"
                role="radio"
                aria-checked={on}
                className={on ? `${s.choice} ${s.choiceOn}` : s.choice}
                onClick={() => !on && void save({ autonomy: a.value })}
              >
                <span className={s.radio} aria-hidden="true" />
                <span className={s.choiceText}>
                  <span className={s.choiceLabel}>{a.label}</span>
                  <span className={s.choiceHint}>{a.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <Field label="Builders at once" hint="How many agents may work in parallel.">
        <div className={s.stepper}>
          <button
            type="button"
            className={s.stepBtn}
            aria-label="Fewer builders"
            disabled={settings.maxBuilders <= 1}
            onClick={() => void save({ maxBuilders: Math.max(1, settings.maxBuilders - 1) })}
          >
            <MinusIcon size={13} />
          </button>
          <span className={s.stepValue} aria-live="polite">
            {settings.maxBuilders}
          </span>
          <button
            type="button"
            className={s.stepBtn}
            aria-label="More builders"
            disabled={settings.maxBuilders >= MAX_BUILDERS}
            onClick={() => void save({ maxBuilders: Math.min(MAX_BUILDERS, settings.maxBuilders + 1) })}
          >
            <PlusIcon size={13} />
          </button>
        </div>
      </Field>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={s.field}>
      <span className={s.fieldText}>
        <span className={s.fieldLabel}>{label}</span>
        {hint && <span className={s.fieldHint}>{hint}</span>}
      </span>
      <span className={s.fieldControl}>{children}</span>
    </div>
  );
}

function TextSetting({ label, value, onCommit, mono, autoFocus }: { label: string; value: string; onCommit: (v: string) => void; mono?: boolean; autoFocus?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim();
    if (v && v !== value) onCommit(v);
    else setDraft(value);
  };
  return (
    <input
      className={mono ? `${s.text} ${s.mono}` : s.text}
      value={draft}
      aria-label={label}
      spellCheck={false}
      autoFocus={autoFocus}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}
