// One .env variable as a row (name, note, masked value, actions), and the
// inline row for adding a new one. Used by EnvEditor.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ESC, onEscape } from '../ui/escape';
import { CloseIcon, EyeIcon, EyeOffIcon, NoteIcon, PlusIcon } from '../ui/icons';
import { normalizeKey, type EnvEntry } from './env';
import s from './EnvEditor.module.css';

const MASK = '••••••••••••';

export interface RowProps {
  entry: EnvEntry;
  masked: boolean;
  revealed: boolean;
  changed: boolean;
  duplicate: boolean;
  fresh: boolean;
  autoFocusValue: boolean;
  onReveal: () => void;
  onToggle: () => void;
  onDoneEditing: () => void;
  onPatch: (patch: Partial<Pick<EnvEntry, 'key' | 'value' | 'note'>>) => void;
  onRemove: () => void;
}

export function Row({ entry: e, masked, revealed, changed, duplicate, fresh, autoFocusValue, onReveal, onToggle, onDoneEditing, onPatch, onRemove }: RowProps) {
  const multiline = e.value.includes('\n');
  const empty = e.value === '';
  const [noting, setNoting] = useState(false);
  const cls = [s.row, changed && s.changed, fresh && s.fresh].filter(Boolean).join(' ');
  const blurOnEnter = (ev: KeyboardEvent<HTMLInputElement>) => {
    if (ev.key === 'Enter') ev.currentTarget.blur();
  };

  return (
    <div className={cls}>
      <span className={s.mark} aria-hidden="true" />
      <div className={s.keyCol}>
        <input
          className={s.key}
          value={e.key}
          aria-label="Name"
          spellCheck={false}
          autoComplete="off"
          onChange={(ev) => {
            const k = normalizeKey(ev.target.value);
            if (k) onPatch({ key: k });
          }}
          onKeyDown={blurOnEnter}
        />
        {duplicate && (
          <span className={s.dup} title="Set more than once. The last one wins.">
            twice
          </span>
        )}
      </div>
      {(e.note || noting) && (
        <input
          className={s.note}
          value={(e.note ?? '').replace(/\n/g, ' ')}
          placeholder="What is this for?"
          aria-label={`Note for ${e.key}`}
          spellCheck={false}
          autoFocus={noting}
          onChange={(ev) => onPatch({ note: ev.target.value || null })}
          onKeyDown={blurOnEnter}
          onBlur={() => setNoting(false)}
        />
      )}

      <div className={s.valueCol}>
        {masked && !empty ? (
          <button type="button" className={`${s.well} ${s.masked}`} onClick={onReveal} aria-label={`Show and edit ${e.key}`}>
            {MASK}
          </button>
        ) : multiline ? (
          <textarea
            className={`${s.well} ${s.value} ${s.multi}`}
            value={e.value}
            rows={Math.min(6, e.value.split('\n').length)}
            spellCheck={false}
            autoFocus={autoFocusValue}
            aria-label={`Value of ${e.key}`}
            onChange={(ev) => onPatch({ value: ev.target.value })}
            onBlur={onDoneEditing}
          />
        ) : (
          <input
            className={`${s.well} ${s.value}`}
            value={e.value}
            placeholder="Empty"
            spellCheck={false}
            autoComplete="off"
            autoFocus={autoFocusValue}
            aria-label={`Value of ${e.key}`}
            onChange={(ev) => onPatch({ value: ev.target.value })}
            onKeyDown={blurOnEnter}
            onBlur={onDoneEditing}
          />
        )}
      </div>

      <div className={s.actions}>
        {!e.note && !noting && (
          <button type="button" className={`${s.icon} ${s.onHover}`} onClick={() => setNoting(true)} title="Add a note">
            <NoteIcon size={14} />
          </button>
        )}
        {!empty && (
          <button type="button" className={`${s.icon} ${revealed ? s.iconOn : ''}`} onClick={onToggle} title={revealed ? 'Hide value' : 'Show value'} aria-pressed={revealed}>
            {revealed ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
          </button>
        )}
        <button type="button" className={`${s.icon} ${s.onHover} ${s.remove}`} onClick={onRemove} title={`Remove ${e.key}`}>
          <CloseIcon size={13} />
        </button>
      </div>
    </div>
  );
}

export function AddRow({ onAdd, existing }: { onAdd: (key: string, value: string) => void; existing: Set<string> }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const valueRef = useRef<HTMLInputElement>(null);

  const close = () => {
    setOpen(false);
    setKey('');
    setValue('');
  };

  useEffect(() => {
    if (!open) return;
    return onEscape(() => {
      close();
      return true;
    }, ESC.field);
  }, [open]);

  const submit = () => {
    const k = normalizeKey(key);
    if (!k) return;
    onAdd(k, value);
    close();
  };

  if (!open) {
    return (
      <button type="button" className={s.addBtn} onClick={() => setOpen(true)}>
        <PlusIcon size={14} />
        Add a variable
      </button>
    );
  }

  const taken = key !== '' && existing.has(normalizeKey(key));
  return (
    <div className={`${s.row} ${s.adding}`}>
      <span className={s.mark} aria-hidden="true" />
      <div className={s.keyCol}>
        <input
          className={`${s.key} ${s.keyNew}`}
          value={key}
          placeholder="NEW_NAME"
          aria-label="New variable name"
          autoFocus
          spellCheck={false}
          autoComplete="off"
          onChange={(ev) => setKey(normalizeKey(ev.target.value))}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') valueRef.current?.focus();
          }}
        />
      </div>
      <span className={s.addHint}>{taken ? 'Already set above. Adding it again overrides it.' : 'Names are usually CAPS_WITH_UNDERSCORES. ↵ to add.'}</span>
      <div className={s.valueCol}>
        <input
          ref={valueRef}
          className={`${s.well} ${s.value}`}
          value={value}
          placeholder="Value"
          aria-label="New variable value"
          spellCheck={false}
          autoComplete="off"
          onChange={(ev) => setValue(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') submit();
          }}
        />
      </div>
      <div className={s.actions}>
        <button type="button" className={s.addConfirm} onClick={submit} disabled={!key}>
          Add
        </button>
        <button type="button" className={s.icon} onClick={close} title="Cancel">
          <CloseIcon size={13} />
        </button>
      </div>
    </div>
  );
}
