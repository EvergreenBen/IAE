// A node's kind as a small glyph, matching the node cards on the map.
import type { NodeKind } from '@shared/model';
import { KindGlyph } from '../map/glyphs';

export function NodeMark({ kind, size = 14 }: { kind: NodeKind; size?: number }) {
  return <KindGlyph kind={kind} size={size} />;
}
