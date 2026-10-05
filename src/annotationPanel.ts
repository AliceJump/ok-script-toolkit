import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TemplateAssetData } from './templateAssetData';
import { readAuthoringFile, boxNamesError } from './boxResourceStore';
import { AUTHORING_FILE_NAME, BOX_PATH_SEGMENT_SOURCE } from './boxResourcePure';
import { onAnnotationDataChanged, sameAnnotationFile } from './cocoAnnotationData';
import { tr } from './localization';
import { injectAnnotationWebviewLocalization } from './annotationLocalization';
import { applySharedAssets, getNonce } from './webviewHtml';
import { POINT_AUTHORING_FILE, pointPathOccupancy, readPoints, savePointsForImage } from './pointResourceStore';
import {
  AnnotationConflict,
  MergeAnnotation,
  findAnnotationConflictItemIndex,
  mergeAnnotations,
} from './annotationMergePure';

export type UnifiedAnnotationMode = 'template' | 'rect' | 'point';

interface Annotation extends MergeAnnotation {}

interface ModeSnapshot {
  annotations: Annotation[];
  allCategories: Record<string, string>;
  revision: string | undefined;
  errors: string[];
}

interface ConflictChoice {
  key: string;
  choice: 'local' | 'external';
}

interface PendingConflictSession {
  imagePath: string;
  mode: UnifiedAnnotationMode;
  externalRevision: string | undefined;
  externalBase: Annotation[];
  local: Annotation[];
  merged: Annotation[];
  conflicts: AnnotationConflict[];
}

interface PreparedAnnotationSave {
  annotations: Annotation[];
  mergedExternal: boolean;
  expectedRevision: string | undefined;
}

type AnnotationWriteResult = 'saved' | 'changed' | 'failed';

function normalizeAnnotationMode(value: UnifiedAnnotationMode | boolean): UnifiedAnnotationMode {
  if (value === true) return 'rect';
  if (value === false) return 'template';
  return value;
}

function cloneAnnotations(values: readonly Annotation[]): Annotation[] {
  return values.map(value => ({ ...value }));
}

class AnnotationController {
  private generation = 0;
  private disposed = false;
  private saving = false;
  private pendingConflictSession: PendingConflictSession | undefined;
  private readonly sourceRevisions: Record<UnifiedAnnotationMode, string | undefined> = {
    template: undefined,
    rect: undefined,
    point: undefined,
  };
  private readonly baseSnapshots: Record<UnifiedAnnotationMode, Annotation[]> = {
    template: [],
    rect: [],
    point: [],
  };
  private readonly localSnapshots: Record<UnifiedAnnotationMode, Annotation[]> = {
    template: [],
    rect: [],
    point: [],
  };
  private readonly pendingExternal = new Set<UnifiedAnnotationMode>();
  private readonly disposables: vscode.Disposable[] = [];
  private _currentImage: string | undefined;
  private _imageList: string[] = [];
  private mode: UnifiedAnnotationMode;
  private readonly templateData: TemplateAssetData;
  private readonly boxData: TemplateAssetData;

  constructor(
    private readonly webview: vscode.Webview,
    private readonly extensionUri: vscode.Uri,
    sourceData: TemplateAssetData,
    private readonly thumbDir: string,
    private readonly isVisible: () => boolean,
    private readonly onSaved: (imagePath: string) => void,
    initialMode: UnifiedAnnotationMode | boolean,
  ) {
    this.mode = normalizeAnnotationMode(initialMode);
    this.templateData = new TemplateAssetData(sourceData.root, 'coco_annotations.json');
    this.boxData = new TemplateAssetData(sourceData.root, AUTHORING_FILE_NAME);
    this.disposables.push(
      webview.onDidReceiveMessage((msg) => { void this.onMessage(msg); }),
      onAnnotationDataChanged(file => {
        if (this.saving || !this._currentImage) return;
        const changedMode = this.modeForSource(file);
        if (changedMode) {
          const revision = this.readSourceRevision(changedMode);
          if (revision !== this.sourceRevisions[changedMode]) {
            this.pendingExternal.add(changedMode);
            if (changedMode === this.mode) {
              void this.webview.postMessage({ type: 'externalSourceChanged', mode: changedMode });
            }
          }
        }
        if (this.isPositionSource(file)) {
          const positionPaths = this.positionOccupancy();
          void this.webview.postMessage({ type: 'positionPaths', positionPaths });
          // Transitional alias for already-open pre-unification webviews/tests.
          void this.webview.postMessage({ type: 'boxPaths', boxPaths: positionPaths });
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('okScriptToolkit.copyCoordsSpace') ||
            e.affectsConfiguration('okScriptToolkit.annotationKeybindings')) {
          this.sendConfig();
        }
      }),
    );
  }

  get root(): string { return this.templateData.root; }
  get currentImage(): string | undefined { return this._currentImage; }

  private resetMergeState(): void {
    for (const mode of ['template', 'rect', 'point'] as const) {
      this.sourceRevisions[mode] = undefined;
      this.baseSnapshots[mode] = [];
      this.localSnapshots[mode] = [];
    }
    this.pendingExternal.clear();
    this.pendingConflictSession = undefined;
  }

  private dataForMode(mode = this.mode): TemplateAssetData | undefined {
    if (mode === 'template') return this.templateData;
    if (mode === 'rect') return this.boxData;
    return undefined;
  }

  private sourceFileForMode(mode = this.mode): string {
    const data = this.dataForMode(mode);
    return data?.annotationFile ?? path.join(this.templateData.templatesDir, POINT_AUTHORING_FILE);
  }

  private modeForSource(file: string): UnifiedAnnotationMode | undefined {
    for (const mode of ['template', 'rect', 'point'] as const) {
      if (sameAnnotationFile(file, this.sourceFileForMode(mode))) return mode;
    }
    return undefined;
  }

  private isPositionSource(file: string): boolean {
    return sameAnnotationFile(file, this.boxData.annotationFile)
      || sameAnnotationFile(file, path.join(this.templateData.templatesDir, POINT_AUTHORING_FILE));
  }

  private readSourceRevision(mode: UnifiedAnnotationMode): string | undefined {
    try { return fs.readFileSync(this.sourceFileForMode(mode), 'utf8'); }
    catch { return undefined; }
  }

  private snapshotForMode(imagePath: string, mode: UnifiedAnnotationMode): ModeSnapshot {
    const activeData = this.dataForMode(mode);
    if (activeData) {
      activeData.load();
      const annotations = activeData.getAnnotationsForImage(imagePath, true).map(a => ({
        id: a.id,
        category: a.categoryName,
        x: a.bbox[0], y: a.bbox[1], w: a.bbox[2], h: a.bbox[3],
      }));
      const allCategories: Record<string, string> = {};
      for (const img of activeData.data.images) {
        const imgPath = path.join(activeData.templatesDir, img.file_name);
        if (imgPath === imagePath) continue;
        for (const name of activeData.getCategoriesForImage(imgPath)) allCategories[name] = img.file_name;
      }
      return {
        annotations,
        allCategories,
        revision: activeData.revision,
        errors: [...activeData.readErrors],
      };
    }

    const result = readPoints(this.root, path.relative(this.root, this.templateData.templatesDir));
    const imageName = path.basename(imagePath);
    const own = result.file.points.filter(point => point.image.toLowerCase() === imageName.toLowerCase());
    const annotations = own.map((point, index) => ({
      id: index + 1,
      category: point.path,
      x: point.x,
      y: point.y,
      w: 0,
      h: 0,
    }));
    const ownNames = new Set(own.map(point => point.path));
    const allCategories = Object.fromEntries(
      result.file.points.filter(point => !ownNames.has(point.path)).map(point => [point.path, point.image]),
    );
    return {
      annotations,
      allCategories,
      revision: this.readSourceRevision(mode),
      errors: [...result.errors],
    };
  }

  private showExternalChangeNotice(): void {
    void vscode.window.showWarningMessage(tr('Annotations changed while confirming. Retry the swap.'));
  }

  private async handleExternalEditorState(mode: UnifiedAnnotationMode, transient: boolean): Promise<void> {
    if (this.disposed || !this._currentImage || mode !== this.mode || !this.pendingExternal.has(mode)) return;
    if (transient) {
      if (this.isVisible()) this.showExternalChangeNotice();
      return;
    }
    if (this.pendingConflictSession?.mode === mode) return;

    const external = this.snapshotForMode(this._currentImage, mode);
    if (external.errors.length) {
      if (this.isVisible()) {
        void vscode.window.showErrorMessage(tr('The annotation source is invalid. Fix the source file before saving or exporting.'));
      }
      return;
    }
    if (external.revision === this.sourceRevisions[mode]) {
      this.pendingExternal.delete(mode);
      return;
    }

    // No transient edit is active, so the canvas still represents the last
    // canonical snapshot. Reloading here gives clean sessions true live sync;
    // transient edits stay pending and are merged through the existing save path.
    await this.loadImage(this._currentImage);
  }

  reloadIfShowing(imagePaths: readonly string[]): void {
    if (this.disposed || !this._currentImage || !imagePaths.includes(this._currentImage)) return;
    void this.loadImage(this._currentImage);
  }

  attachHtml(): void {
    this.webview.html = annotationHtml(this.webview.cspSource, this.extensionUri, this.webview);
    this.sendConfig();
  }

  private sendConfig(): void {
    const cfg = vscode.workspace.getConfiguration('okScriptToolkit');
    const kb = cfg.get<Record<string, string>>('annotationKeybindings');
    const copyCoordsSpace = cfg.get<boolean>('copyCoordsSpace', true);
    void this.webview.postMessage({
      type: 'config',
      annotationMode: this.mode,
      boxMode: this.mode === 'rect',
      pointMode: this.mode === 'point',
      keybindings: kb,
      copyCoordsSpace,
      boxPathRule: {
        segment: BOX_PATH_SEGMENT_SOURCE,
        reservedRoots: [],
      },
    });
  }

  open(imagePath: string, imageList: string[], mode?: UnifiedAnnotationMode | boolean): void {
    if (this._currentImage && this._currentImage !== imagePath) this.resetMergeState();
    if (mode !== undefined) this.mode = normalizeAnnotationMode(mode);
    this._imageList = [...imageList];
    this._currentImage = imagePath;
    this.sendConfig();
    void this.loadImage(imagePath);
  }

  private async loadImage(imagePath: string): Promise<void> {
    if (this.disposed) return;
    if (this._currentImage && this._currentImage !== imagePath) this.resetMergeState();
    this._currentImage = imagePath;
    const generation = ++this.generation;
    const snapshot = this.snapshotForMode(imagePath, this.mode);
    this.sourceRevisions[this.mode] = snapshot.revision;
    this.baseSnapshots[this.mode] = cloneAnnotations(snapshot.annotations);
    this.localSnapshots[this.mode] = cloneAnnotations(snapshot.annotations);
    this.pendingExternal.delete(this.mode);
    if (this.pendingConflictSession?.mode === this.mode && this.pendingConflictSession.imagePath === imagePath) {
      this.pendingConflictSession = undefined;
    }

    let imageBase64 = '';
    try {
      const buf = await fs.promises.readFile(imagePath);
      const mime = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
        ? 'image/jpeg'
        : buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d
          ? 'image/bmp'
          : 'image/png';
      imageBase64 = `data:${mime};base64,${buf.toString('base64')}`;
    } catch { imageBase64 = ''; }
    if (this.disposed || generation !== this.generation) return;

    const positionPaths = this.positionOccupancy();
    await this.webview.postMessage({
      type: 'load',
      imagePath,
      imageBase64,
      annotations: snapshot.annotations,
      allCategories: snapshot.allCategories,
      positionPaths,
      boxPaths: positionPaths,
      annotationMode: this.mode,
      pointMode: this.mode === 'point',
      currentIndex: this._imageList.indexOf(imagePath),
      totalImages: this._imageList.length,
      filename: path.basename(imagePath),
    });
  }

  private positionOccupancy(): Record<string, string> {
    const boxes = readAuthoringFile(this.root, this.templateData.templatesDir);
    return {
      ...Object.fromEntries(boxes.boxes.map(box => [box.path, box.image])),
      ...pointPathOccupancy(this.root, this.templateData.templatesDir),
    };
  }

  private async onMessage(msg: {
    type?: string;
    mode?: UnifiedAnnotationMode;
    annotation?: Annotation;
    annotations?: Annotation[];
    index?: number;
    category?: string;
    text?: string;
    choices?: ConflictChoice[];
    transient?: boolean;
  }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.sendConfig();
        if (this._currentImage) await this.loadImage(this._currentImage);
        break;
      case 'switchAnnotationMode':
        if (msg.mode && ['template', 'rect', 'point'].includes(msg.mode)) {
          this.mode = msg.mode;
          this.sendConfig();
          if (this._currentImage) await this.loadImage(this._currentImage);
        }
        break;
      case 'save':
        if (this._currentImage && msg.annotations && await this.persistAnnotationsForMode(this._currentImage, this.mode, msg.annotations)) {
          this.onSaved(this._currentImage);
        }
        break;
      case 'saveMode':
        if (this._currentImage && msg.mode && msg.annotations
          && await this.persistAnnotationsForMode(this._currentImage, msg.mode, msg.annotations)) {
          this.onSaved(this._currentImage);
        }
        break;
      case 'externalEditorState':
        if (msg.mode && typeof msg.transient === 'boolean') {
          await this.handleExternalEditorState(msg.mode, msg.transient);
        }
        break;
      case 'resolveAnnotationConflicts':
        await this.resolveAnnotationConflicts(msg.choices || []);
        break;
      case 'navigate':
        if (msg.index !== undefined && msg.index >= 0 && msg.index < this._imageList.length) await this.loadImage(this._imageList[msg.index]);
        break;
      case 'copyColor':
        if (typeof msg.category === 'string') {
          await vscode.env.clipboard.writeText(msg.category);
          void vscode.window.showInformationMessage(tr('Copied: {text}', { text: msg.category }));
        }
        break;
      case 'copyText':
        if (typeof msg.text === 'string' && msg.text.length > 0) {
          await vscode.env.clipboard.writeText(msg.text);
          void vscode.window.showInformationMessage(tr('Copied: {text}', { text: msg.text }));
        }
        break;
      case 'readClipboard': {
        const text = await vscode.env.clipboard.readText();
        void this.webview.postMessage({ type: 'clipboardText', text });
        break;
      }
    }
  }

  private applyExternalConflictChoice(
    mode: UnifiedAnnotationMode,
    annotations: Annotation[],
    conflict: AnnotationConflict,
  ): void {
    const index = findAnnotationConflictItemIndex(mode, annotations, conflict);
    if (!conflict.external) {
      if (index >= 0) annotations.splice(index, 1);
      return;
    }
    if (index < 0) {
      annotations.push({ ...conflict.external });
      return;
    }
    for (const field of conflict.fields) {
      annotations[index][field] = conflict.external[field] as never;
    }
  }

  private async resolveAnnotationConflicts(choices: readonly ConflictChoice[]): Promise<void> {
    const session = this.pendingConflictSession;
    if (!session) return;
    const choiceMap = new Map(choices.map(choice => [choice.key, choice.choice]));
    if (session.conflicts.some(conflict => !choiceMap.has(conflict.key))) return;

    // The file may have changed again while the user was inspecting the two candidates.
    // Never apply decisions against a stale external revision; rebuild the merge instead.
    if (this.readSourceRevision(session.mode) !== session.externalRevision) {
      this.pendingConflictSession = undefined;
      this.pendingExternal.add(session.mode);
      const saved = await this.persistAnnotationsForMode(session.imagePath, session.mode, session.local);
      if (!saved) return;
      this.onSaved(session.imagePath);
      return;
    }

    const resolved = cloneAnnotations(session.merged);
    for (const conflict of session.conflicts) {
      if (choiceMap.get(conflict.key) === 'external') {
        this.applyExternalConflictChoice(session.mode, resolved, conflict);
      }
    }

    const outcome = await this.writePreparedAnnotations(session.imagePath, session.mode, {
      annotations: resolved,
      mergedExternal: true,
      expectedRevision: session.externalRevision,
    });
    if (outcome === 'changed') {
      this.pendingConflictSession = undefined;
      this.pendingExternal.add(session.mode);
      const saved = await this.persistAnnotationsForMode(session.imagePath, session.mode, session.local);
      if (saved) this.onSaved(session.imagePath);
      return;
    }
    if (outcome !== 'saved') return;

    this.onSaved(session.imagePath);
    if (this._currentImage === session.imagePath && this.mode === session.mode) {
      await this.loadImage(session.imagePath);
    }
  }

  private async mergeExternalBeforeSave(
    imagePath: string,
    mode: UnifiedAnnotationMode,
    local: readonly Annotation[],
  ): Promise<PreparedAnnotationSave | undefined> {
    const diskRevision = this.readSourceRevision(mode);
    if (!this.pendingExternal.has(mode) && diskRevision === this.sourceRevisions[mode]) {
      return {
        annotations: cloneAnnotations(local),
        mergedExternal: false,
        expectedRevision: diskRevision,
      };
    }

    const external = this.snapshotForMode(imagePath, mode);
    if (external.errors.length) {
      void vscode.window.showErrorMessage(tr('Could not save annotations.'));
      this.pendingExternal.add(mode);
      return undefined;
    }

    if (external.revision === this.sourceRevisions[mode]) {
      this.pendingExternal.delete(mode);
      return {
        annotations: cloneAnnotations(local),
        mergedExternal: false,
        expectedRevision: external.revision,
      };
    }

    const result = mergeAnnotations(mode, this.baseSnapshots[mode], local, external.annotations);
    if (result.conflicts.length) {
      this.pendingExternal.add(mode);
      this.pendingConflictSession = {
        imagePath,
        mode,
        externalRevision: external.revision,
        externalBase: cloneAnnotations(external.annotations),
        local: cloneAnnotations(local),
        merged: cloneAnnotations(result.merged as Annotation[]),
        conflicts: result.conflicts,
      };
      await this.webview.postMessage({
        type: 'annotationConflicts',
        annotationMode: mode,
        base: cloneAnnotations(this.baseSnapshots[mode]),
        local: cloneAnnotations(local),
        external: cloneAnnotations(external.annotations),
        merged: cloneAnnotations(result.merged as Annotation[]),
        conflicts: result.conflicts,
      });
      return undefined;
    }

    // Preparing a merge must not advance the accepted base. The external
    // snapshot is committed only after persistence and canonical reread succeed.
    return {
      annotations: cloneAnnotations(result.merged as Annotation[]),
      mergedExternal: true,
      expectedRevision: external.revision,
    };
  }

  private async writePreparedAnnotations(
    imagePath: string,
    mode: UnifiedAnnotationMode,
    prepared: PreparedAnnotationSave,
  ): Promise<AnnotationWriteResult> {
    if (this.readSourceRevision(mode) !== prepared.expectedRevision) {
      this.pendingExternal.add(mode);
      return 'changed';
    }

    const annotations = prepared.annotations;
    try {
      this.saving = true;
      if (mode === 'point') {
        const error = savePointsForImage(
          this.root,
          path.relative(this.root, this.templateData.templatesDir),
          imagePath,
          annotations.map(ann => ({ path: ann.category.trim(), x: ann.x, y: ann.y })),
        );
        if (error) throw new Error(error);
      } else {
        const data = this.dataForMode(mode)!;
        data.load();
        if (data.readErrors.length) throw new Error('parse');
        const mapped = annotations.map(ann => ({
          category: mode === 'rect' ? ann.category.trim() : ann.category,
          x: ann.x, y: ann.y, w: ann.w, h: ann.h,
        }));
        const namesError = mode === 'rect' ? boxNamesError(data, imagePath, mapped.map(ann => ann.category)) : undefined;
        if (namesError) throw new Error(namesError);
        if (!data.setAnnotationsForImage(imagePath, mapped)) throw new Error('geometry');
        data.save();
      }

      const canonical = this.snapshotForMode(imagePath, mode);
      if (canonical.errors.length) throw new Error('canonical');
      this.sourceRevisions[mode] = canonical.revision;
      this.baseSnapshots[mode] = cloneAnnotations(canonical.annotations);
      this.localSnapshots[mode] = cloneAnnotations(canonical.annotations);
      this.pendingExternal.delete(mode);
      if (this.pendingConflictSession?.mode === mode && this.pendingConflictSession.imagePath === imagePath) {
        this.pendingConflictSession = undefined;
      }
      return 'saved';
    } catch (error) {
      console.error('[ok-script] save annotations:', error);
      void vscode.window.showErrorMessage(tr('Could not save annotations.'));
      return 'failed';
    } finally {
      this.saving = false;
    }
  }

  private async persistAnnotationsForMode(
    imagePath: string,
    mode: UnifiedAnnotationMode,
    localAnnotations: Annotation[],
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = await this.mergeExternalBeforeSave(imagePath, mode, localAnnotations);
      if (!prepared) return false;
      const outcome = await this.writePreparedAnnotations(imagePath, mode, prepared);
      if (outcome === 'saved') {
        if (prepared.mergedExternal && this._currentImage === imagePath && mode === this.mode) {
          await this.loadImage(imagePath);
        }
        return true;
      }
      if (outcome === 'failed') return false;
      this.pendingExternal.add(mode);
    }
    if (this.isVisible()) this.showExternalChangeNotice();
    return false;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

export class AnnotationPanel {
  static current: AnnotationPanel | undefined;

  static show(
    extensionUri: vscode.Uri,
    data: TemplateAssetData,
    thumbDir: string,
    imagePath: string,
    imageList: string[],
    onSaved: (imagePath: string) => void,
    boxMode = false,
  ): void {
    const initialMode: UnifiedAnnotationMode = boxMode ? 'rect' : 'template';
    const current = AnnotationPanel.current;
    if (current && current.controller.root !== data.root) current.panel.dispose();
    else if (current) {
      current.panel.reveal();
      current.controller.open(imagePath, imageList, initialMode);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'okScriptToolkitAnnotation',
      tr('Annotation Editor'),
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(thumbDir), vscode.Uri.file(data.templatesDir), extensionUri],
      },
    );
    const controller = new AnnotationController(
      panel.webview,
      extensionUri,
      data,
      thumbDir,
      () => panel.visible,
      onSaved,
      initialMode,
    );
    const instance = new AnnotationPanel(panel, controller);
    AnnotationPanel.current = instance;
    controller.open(imagePath, imageList, initialMode);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    readonly controller: AnnotationController,
  ) {
    controller.attachHtml();
    panel.onDidDispose(() => {
      controller.dispose();
      if (AnnotationPanel.current === this) AnnotationPanel.current = undefined;
    });
  }
}

export function annotationHtml(cspSource: string, extensionUri: vscode.Uri, webview: vscode.Webview): string {
  const file = path.join(extensionUri.fsPath, 'media', 'annotationPanel', 'index.html');
  const nonce = getNonce();
  const resource = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'annotationPanel', name)).toString(true);
  return injectAnnotationWebviewLocalization(applySharedAssets(webview, extensionUri,
    fs.readFileSync(file, 'utf-8')
      .split('__CSP_NONCE__').join(nonce)
      .split('__CSP_SOURCE__').join(cspSource)
      .split('__STYLE_URI__').join(resource('style.css'))
      .split('__CONFLICT_STYLE_URI__').join(resource('conflict.css'))
      .split('__CONFLICT_SCRIPT_URI__').join(resource('conflict.js'))
      .split('__APP_SCRIPT_URI__').join(resource('app.js'))
      .split('__EXTERNAL_SYNC_SCRIPT_URI__').join(resource('externalSync.js')),
  ));
}
