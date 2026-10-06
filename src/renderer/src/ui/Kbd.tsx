// A quiet keyboard hint: <Kbd>⌘K</Kbd>, or <Kbd keys={['⌘', '↵']} />.
import type { ReactNode } from 'react';
import s from './Kbd.module.css';

export function Kbd({ children, keys, className }: { children?: ReactNode; keys?: string[]; className?: string }) {
  const cls = className ? `${s.kbd} ${className}` : s.kbd;
  if (keys) {
    return (
      <span className={s.group}>
        {keys.map((k) => (
          <kbd key={k} className={cls}>
            {k}
          </kbd>
        ))}
      </span>
    );
  }
  return <kbd className={cls}>{children}</kbd>;
}
