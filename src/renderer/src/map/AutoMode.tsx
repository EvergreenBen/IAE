// Auto mode, one click from the top strip: faint when off; when on, a blue disc
// says builders aren't waiting for anyone's yes.
import { bridge } from '../bridge';
import { useIae } from '../state/store';
import s from './AutoMode.module.css';

export function AutoMode({ className }: { className?: string }) {
  const on = useIae((st) => st.settings.autoApprove);
  const toggle = async () => {
    const next = await bridge.setSettings({ autoApprove: !on });
    useIae.setState({ settings: next });
  };
  return (
    <button
      type="button"
      className={className ? `${s.auto} ${className}` : s.auto}
      data-on={on || undefined}
      aria-pressed={on}
      aria-label="Auto mode"
      title={on ? 'Auto mode is on: builders go ahead without asking. Click to turn off.' : 'Auto mode: let builders go ahead without asking'}
      onClick={() => void toggle()}
    >
      <span className={s.disc} aria-hidden="true" />
      Auto
    </button>
  );
}
