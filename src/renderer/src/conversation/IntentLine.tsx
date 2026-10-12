// The intent line: one quiet pill at the bottom of the map. Archie perches on
// its left end; type or talk; "/" opens Claude Code commands above it.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SlashCommandInfo } from '@shared/model';
import { DEFAULT_SETTINGS } from '@shared/model';
import { Archie } from '../avatar/Archie';
import { useArchieLevel, useArchieState, useCrewWorking } from '../avatar/useArchieState';
import { bridge } from '../bridge';
import { useIae } from '../state/store';
import { onEscape } from '../ui/escape';
import { voice } from '../voice/controller';
import { activeQuestion, isBlankProject, placeholderFor } from './context';
import { MicButton } from './MicButton';
import { SlashMenu, filterCommands } from './SlashMenu';
import { abandon, draft, noteTyping, send } from './utterance';
import styles from './IntentLine.module.css';

/** Marks the intent input so keyboard handling can recognise it. */
export const INTENT_INPUT = 'data-intent-input';

export function focusIntentLine(): void {
  const el = document.querySelector<HTMLInputElement>(`[${INTENT_INPUT}]`);
  if (el && document.activeElement !== el) el.focus({ preventScroll: true });
}

function useHint(empty: boolean): { text: string; tone: 'faint' | 'quiet' | 'note' } | null {
  const mic = useIae((s) => s.voice.mic);
  const error = useIae((s) => s.voice.error);
  const loading = useIae((s) => s.voice.loadProgress !== undefined);
  const handsFree = useIae((s) => s.settings.voice.handsFree);
  if (error) return { text: error, tone: 'note' };
  if (loading) return { text: 'Getting voice ready', tone: 'quiet' };
  if (mic === 'hearing' || mic === 'transcribing' || !empty) return null;
  return handsFree ? { text: 'just talk', tone: 'faint' } : { text: 'hold space to talk', tone: 'faint' };
}

export function IntentLine() {
  const input = useRef<HTMLInputElement>(null);
  const interimBox = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [commands, setCommands] = useState<SlashCommandInfo[] | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);

  const root = useIae((s) => s.project?.root ?? null);
  const blank = useIae((s) => isBlankProject(s.project, s.map));
  const selectedLabel = useIae((s) => (s.selectedNodeId ? (s.map.nodes[s.selectedNodeId]?.label ?? null) : null));
  const questionUp = useIae((s) => !!activeQuestion(s.agenda, (s as { activeAgendaId?: string | null }).activeAgendaId));
  const interim = useIae((s) => s.voice.interim);
  const heard = useIae((s) => s.voice.heard);
  const mic = useIae((s) => s.voice.mic);
  const loadProgress = useIae((s) => s.voice.loadProgress);
  const handsFree = useIae((s) => s.settings.voice.handsFree);
  const leadName = useIae((s) => s.settings.leadName || DEFAULT_SETTINGS.leadName);

  const isSlash = text.startsWith('/');
  const slashQuery = isSlash ? text.slice(1).split(/\s/)[0] : '';
  const slashOpen = isSlash && focused && !slashDismissed && !/\s/.test(text);
  const items = slashOpen ? filterCommands(commands ?? [], slashQuery) : [];

  const archie = useArchieState({ typing: focused && text.length > 0 && !isSlash });
  const level = useArchieLevel();
  const crewWorking = useCrewWorking();
  // What they just said stays, settled, until the answer begins.
  const echo = !text && !interim && mic !== 'hearing' ? (heard ?? '') : '';
  const hint = useHint(text.length === 0 && !interim && !echo);

  const listening = mic === 'hearing';
  const placeholder = listening ? 'Listening…' : mic === 'transcribing' ? '' : placeholderFor({ blank, selectedLabel, questionUp });

  // Commands come from Claude Code for this project; fetch on first "/".
  useEffect(() => setCommands(null), [root]);
  useEffect(() => {
    if (!slashOpen || commands) return;
    let live = true;
    bridge
      .listCommands()
      .then((c) => live && setCommands(c))
      .catch(() => live && setCommands([]));
    return () => {
      live = false;
    };
  }, [slashOpen, commands]);

  // Autofocus when the project opens.
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, [root]);

  // Show the newest interim words when they outgrow the line.
  useLayoutEffect(() => {
    const el = interimBox.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [interim]);

  // Esc: close the command menu, then clear the line. Lens/palette layers win.
  const state = useRef({ slashOpen, text });
  state.current = { slashOpen, text };
  useEffect(
    () =>
      onEscape(() => {
        if (document.activeElement !== input.current) return false;
        if (state.current.slashOpen) {
          setSlashDismissed(true);
          return true;
        }
        if (state.current.text) {
          clear();
          abandon();
          return true;
        }
        return false;
      }, 5),
    [],
  );

  function clear() {
    setText('');
    setActive(0);
    setSlashDismissed(false);
    noteTyping(false);
    voice.setTyping(false);
  }

  function onChange(v: string) {
    setText(v);
    setActive(0);
    if (!v.startsWith('/')) setSlashDismissed(false);
    noteTyping(v.length > 0);
    voice.setTyping(v.length > 0);
    if (v.startsWith('/')) abandon();
    else draft(v, 'text');
  }

  function runCommand(cmd: SlashCommandInfo) {
    const args = text.replace(/^\/\S*\s*/, '');
    send(`/${cmd.name}${args ? ` ${args}` : ''}`, 'text');
    clear();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (slashOpen && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setActive((a) => (a + d + items.length) % items.length);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        onChange(`/${items[active].name} `);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        runCommand(items[Math.min(active, items.length - 1)]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
      // An empty line lets ↵ through to the map (dive into the selection).
      e.preventDefault();
      e.stopPropagation();
      send(text, 'text');
      clear();
    }
  }

  function toggleHandsFree() {
    const v = useIae.getState().settings.voice;
    void bridge.setSettings({ voice: { ...v, handsFree: !v.handsFree } });
    input.current?.focus({ preventScroll: true });
  }

  return (
    <div className={styles.wrap}>
      {slashOpen && <SlashMenu items={items} active={active} loading={commands === null} onPick={runCommand} onHover={setActive} />}
      <div className={styles.pill} data-focused={focused || undefined} data-listening={listening || handsFree || undefined}>
        <div className={styles.perch}>
          <Archie size={40} state={archie} level={level} glance={crewWorking} />
        </div>
        <div className={styles.field}>
          <input
            ref={input}
            {...{ [INTENT_INPUT]: '' }}
            className={styles.input}
            data-slash={isSlash || undefined}
            value={text}
            placeholder={interim || echo ? '' : placeholder}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            spellCheck={false}
            autoComplete="off"
            aria-label={`Talk to ${leadName}`}
          />
          {interim && !text && (
            <div ref={interimBox} className={styles.interim} aria-live="polite">
              <span>{interim}</span>
            </div>
          )}
          {echo && (
            <div className={styles.interim} data-heard="">
              <span>{echo}</span>
            </div>
          )}
        </div>
        {hint && (
          <span className={styles.hint} data-tone={hint.tone}>
            {hint.text}
          </span>
        )}
        <MicButton onToggle={toggleHandsFree} />
        {loadProgress !== undefined && (
          <div className={styles.progress} aria-hidden="true">
            <div className={styles.progressFill} style={{ transform: `scaleX(${Math.max(0.02, loadProgress)})` }} />
          </div>
        )}
      </div>
    </div>
  );
}
