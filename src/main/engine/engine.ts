// STUB — replaced by the engine implementation. Keeps the app bootable.
import type { HomeInfo, IaeApi, Presence, SayMeta } from '../../shared/bridge';
import type { EngineEvent } from '../../shared/events';
import {
  DEFAULT_SETTINGS,
  type FileContent,
  type MapOp,
  type ProjectSnapshot,
  type Settings,
  type SlashCommandInfo,
  type ViewContext,
} from '../../shared/model';

export class Engine implements IaeApi {
  private settings: Settings = DEFAULT_SETTINGS;
  constructor(private readonly emit: (e: EngineEvent) => void) {}

  async boot(): Promise<void> {}
  async shutdown(): Promise<void> {}

  async getHome(): Promise<HomeInfo> {
    return { recent: [], defaultParent: '', claude: 'unknown' };
  }
  async pickFolder(): Promise<string | null> {
    return null;
  }
  async openProject(_root: string): Promise<ProjectSnapshot> {
    throw new Error('not implemented');
  }
  async createProject(_name: string, _parentDir?: string): Promise<ProjectSnapshot> {
    throw new Error('not implemented');
  }
  async closeProject(): Promise<void> {}
  async say(_text: string, _meta?: SayMeta): Promise<void> {}
  async draft(_draftId: string, _text: string): Promise<void> {}
  async interrupt(): Promise<void> {}
  async answer(_agendaId: string, _answer: string): Promise<void> {}
  async dismiss(_agendaId: string): Promise<void> {}
  async setView(_view: ViewContext): Promise<void> {}
  async setPresence(_presence: Presence): Promise<void> {}
  async applyOps(_ops: MapOp[]): Promise<void> {}
  async readFile(path: string): Promise<FileContent> {
    return { path, content: '', size: 0, language: 'text', unreadable: true };
  }
  async writeFile(_path: string, _content: string): Promise<void> {}
  async explainFile(_path: string): Promise<string> {
    return '';
  }
  async revealFile(_path: string): Promise<void> {}
  async stopAgent(_agentId: string): Promise<void> {}
  async resolvePermission(_id: string, _decision: 'allow' | 'deny' | 'always'): Promise<void> {}
  async listCommands(): Promise<SlashCommandInfo[]> {
    return [];
  }
  async runCommand(_command: string): Promise<void> {}
  async getSettings(): Promise<Settings> {
    return this.settings;
  }
  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    this.settings = { ...this.settings, ...patch };
    this.emit({ type: 'settings/changed', settings: this.settings });
    return this.settings;
  }
}
