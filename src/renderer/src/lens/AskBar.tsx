// The lens footer: ask the lead to change this file without leaving it. The
// request carries the path as context; the lead's reply streams in above the
// field so the conversation isn't hidden behind the sheet.
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { bridge } from '../bridge';
import { useIae } from '../state/store';
import { SendIcon } from '../ui/icons';
import s from './Lens.module.css';

/** How long the confirmation waits for a reply, and how long a reply lingers. */
const WAIT_FOR_REPLY = 12000;
const REPLY_LINGER = 9000;

export function AskBar({ path, children }: { path: string; children?: ReactNode }) {
  const leadName = useIae((st) => st.settings.leadName || 'Archie');
  const lead = useIae((st) => st.lead);
  const [text, setText] = useState('');
  const [sent, setSent] = useState<{ turnId: string | null } | null>(null);

  // The reply to *our* request: any turn that started after we sent.
  const replying = sent !== null && lead.turnId !== sent.turnId;
  const reply = replying ? lead.text : '';
  const done = replying && lead.state === 'idle';

  // The confirmation and the reply fade on their own; never mid-sentence.
  useEffect(() => {
    if (!sent || (replying && !done)) return;
    const t = setTimeout(() => setSent(null), done ? REPLY_LINGER : WAIT_FOR_REPLY);
    return () => clearTimeout(t);
  }, [sent, replying, done]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    setSent({ turnId: useIae.getState().lead.turnId });
    setText('');
    void bridge.say(`In ${path}: ${t}`, { via: 'text' });
  };

  let line: ReactNode = null;
  if (sent && reply) line = <span className={s.replyText}>{reply}</span>;
  else if (sent) line = <span className={s.sentText}>Sent to {leadName}, with this file as context.</span>;

  return (
    <div className={s.ask}>
      <AnimatePresence>
        {line && (
          <motion.div
            key="reply"
            className={s.reply}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          >
            <span className={s.leadDot} aria-hidden="true" />
            {line}
          </motion.div>
        )}
      </AnimatePresence>
      <div className={s.askRow}>
        <div className={s.askField}>
          <input
            className={s.askInput}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={`Ask ${leadName} to change this…`}
            aria-label={`Ask ${leadName} to change this file`}
            spellCheck={false}
          />
          <button type="button" className={s.send} onClick={send} disabled={!text.trim()} aria-label="Send" title="Send (↵)">
            <SendIcon size={14} />
          </button>
        </div>
        <div className={s.status}>{children}</div>
      </div>
    </div>
  );
}
