import { AnnotationPanel } from './annotationPanel';

declare module './annotationPanel' {
  namespace AnnotationPanel {
    /** @deprecated Unified editor uses `current`; retained while legacy callers are being collapsed. */
    let currentBoxes: AnnotationPanel | undefined;
  }
}
