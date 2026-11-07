// Settings, as a small page inside the palette. Each change saves on its own
// (text fields when you leave them or press ↵).
import type { Autonomy, Provider, Settings as SettingsT } from '@shared/model';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { bridge } from '../bridge';
import { useIae } from '../state/store';
import { BackIcon, MinusIcon, NextIcon, PlusIcon } from '../ui/icons';
import { DEFAULT_KOKORO_VOICE, KOKORO_VOICES, SYSTEM_VOICE, voiceChoice } from '../voice/kokoroConfig';
import { tts } from '../voice/tts';
import s from './Palette.module.css';

/**
 * One choice for how much builders ask. "Never ask" is Auto (the switch at the
 * top right): it says yes to every request, so the older "full autonomy"
 * setting shows as it too.
 */
type AskLevel = Autonomy | 'never';
const AUTONOMY: { value: AskLevel; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask first', hint: 'Builders ask before they change a file or run a command.' },
  { value: 'edits', label: 'Ask before commands', hint: 'Builders change files on their own, and ask before running a command.' },
  { value: 'never', label: 'Never ask (Auto)', hint: 'Builders go ahead without stopping. Best in a git repo, where every change can be undone.' },
];

const PROVIDERS: { value: Provider; label: string; hint: string }[] = [
  { value: 'claude', label: 'Claude Code', hint: 'Your Claude account (Pro or Max) or an Anthropic API key.' },
  { value: 'codex', label: 'Codex', hint: 'Your ChatGPT account or an OpenAI API key.' },
];

const askLevel = (st: SettingsT): AskLevel => (st.autoApprove || st.autonomy === 'full' ? 'never' : st.autonomy);

function askPatch(level: AskLevel): Partial<SettingsT> {
  return level === 'never' ? { autoApprove: true } : { autonomy: level, autoApprove: false };
}

const MAX_BUILDERS = 8;

/** Archie's voices, in the order the picker steps through them. */
const VOICES: { id: string; name: string }[] = [...KOKORO_VOICES, { id: SYSTEM_VOICE, name: 'System voice' }];

function voiceIndex(setting: string): number {
  const choice = voiceChoice(setting);
  const id = choice.engine === 'kokoro' ? choice.voice : SYSTEM_VOICE;
  const i = VOICES.findIndex((v) => v.id === id);
  return i >= 0 ? i : VOICES.findIndex((v) => v.id === DEFAULT_KOKORO_VOICE);
}

export function SettingsView() {
  const settings = useIae((st) => st.settings);
  const [saved, setSaved] = useState(0);

  const save = async (patch: Partial<SettingsT>) => {
    const next = await bridge.setSettings(patch);
    useIae.setState({ settings: next });
    setSaved(Date.now());
  };

  const voiceAt = voiceIndex(settings.voice.ttsVoice);
  const stepVoice = (by: number) => {
    const next = VOICES[(voiceAt + by + VOICES.length) % VOICES.length];
    void save({ voice: { ...settings.voice, ttsVoice: next.id } });
    // Hear it straight away.
    tts.preview(`Hi, I'm ${settings.leadName || 'Archie'}.`, next.id);
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
      <Choices label="Runs on" options={PROVIDERS} value={settings.provider} onPick={(provider) => void save({ provider })} />

      {settings.provider === 'codex' ? (
        <Field label="Codex model" hint="Every role uses it. Empty uses Codex's default.">
          <TextSetting label="Codex model" value={settings.codexModel} mono allowEmpty placeholder="Codex's default" onCommit={(v) => save({ codexModel: v })} />
        </Field>
      ) : (
        <>
          <Field label="Lead model" hint="Fast and warm. Answers in about a second.">
            <TextSetting label="Lead model" value={settings.leadModel} mono onCommit={(v) => v && save({ leadModel: v })} />
          </Field>
          <Field label="Builder model" hint="Does the real work in each Claude Code session.">
            <TextSetting label="Builder model" value={settings.builderModel} mono onCommit={(v) => v && save({ builderModel: v })} />
          </Field>
        </>
      )}

      {settings.provider === 'codex' ? (
        <Field label="Builders ask" hint="Codex builders don't stop to ask. They work inside a sandbox limited to the project folder." />
      ) : (
        <Choices label="Builders ask" options={AUTONOMY} value={askLevel(settings)} onPick={(level) => void save(askPatch(level))} />
      )}

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

      <Field label="Voice" hint={`How ${settings.leadName || 'Archie'} sounds. Runs on this Mac, offline.`}>
        <div className={s.stepper}>
          <button type="button" className={s.stepBtn} aria-label="Previous voice" onClick={() => stepVoice(-1)}>
            <BackIcon size={13} />
          </button>
          <span className={`${s.stepValue} ${s.stepWord}`} aria-live="polite">
            {VOICES[voiceAt].name}
          </span>
          <button type="button" className={s.stepBtn} aria-label="Next voice" onClick={() => stepVoice(1)}>
            <NextIcon size={13} />
          </button>
        </div>
      </Field>
    </div>
  );
}

function Choices<T extends string>({ label, options, value, onPick }: { label: string; options: { value: T; label: string; hint: string }[]; value: T; onPick: (v: T) => void }) {
  return (
    <div className={s.fieldBlock}>
      <span className={s.fieldLabel}>{label}</span>
      <div className={s.choices} role="radiogroup" aria-label={label}>
        {options.map((a) => {
          const on = value === a.value;
          return (
            <button key={a.value} type="button" role="radio" aria-checked={on} className={on ? `${s.choice} ${s.choiceOn}` : s.choice} onClick={() => !on && onPick(a.value)}>
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
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) {
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

function TextSetting({
  label,
  value,
  onCommit,
  mono,
  autoFocus,
  allowEmpty,
  placeholder,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  mono?: boolean;
  autoFocus?: boolean;
  allowEmpty?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const v = draft.trim();
    if ((v || allowEmpty) && v !== value) onCommit(v);
    else setDraft(value);
  };
  return (
    <input
      className={mono ? `${s.text} ${s.mono}` : s.text}
      value={draft}
      aria-label={label}
      placeholder={placeholder}
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
