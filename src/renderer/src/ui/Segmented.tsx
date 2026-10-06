// A two-or-three-way toggle: `Code · Meaning`. The thumb glides between options.
import { motion } from 'motion/react';
import { useId } from 'react';
import s from './Segmented.module.css';

export interface SegmentedProps<T extends string> {
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
  label: string;
}

export function Segmented<T extends string>({ value, options, onChange, label }: SegmentedProps<T>) {
  const id = useId();
  return (
    <div className={s.root} role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.hint}
            className={on ? `${s.opt} ${s.on}` : s.opt}
            onClick={() => onChange(o.value)}
          >
            {on && <motion.span layoutId={`seg-${id}`} className={s.thumb} transition={{ type: 'spring', stiffness: 520, damping: 40 }} />}
            <span className={s.label}>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
