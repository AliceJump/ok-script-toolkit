import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { bindInboxScreenshotStore } from './backgroundScreenshot';
import { setCaptureLogger, disposeCaptureWorker } from './screenshotCapture';
import { LangData, poDirectorySetting } from './langData';
import { tr } from './localization';
import { cocoFeatureRelPaths, refreshCocoFeaturePath } from './cocoFeaturePath';
import { effectsFileSetting, i18nLangDirectorySetting, isSupportedProject, resolveProjectDir, templatesDirectory } from './projectConfig';
import { showConventionSources } from './conventionSources';
import { FeatureData } from './featureData';
import { EffectData } from './effectData';
import { clearCropCache, clearSourceCropCache, clearCropCacheForImage, removeTemplateThumbFile, clearThumbDir, warmCropCache, initCropWorkerPool, disposeCropWorkerPool, setCropLogger, setTemplatesDirName, THUMB_HEIGHT, thumbDirForSource, thumbSourceSubdir, clearSourceThumbs, purgeLegacyThumbFiles, invalidateImageContentHash } from './pngCrop';
import { initAssetPackPool, disposeAssetPackPool } from './assetPack';
import {
  LangCompletionProvider,
  LangHoverProvider,
  LangInlayHintsProvider,
  featureAliases,
} from './providers';
import { EffectCompletionProvider, EffectHoverProvider, EffectInlayHintsProvider } from './effectProvider';
import {
  TemplateGalleryPanel,
  TemplateGalleryViewProvider,
  repaintAllGalleries,
} from './templatePanel';
import { ConsoleViewProvider, ExecutorStateSummary } from './consolePanel';
import { RunTreeDataProvider } from './run/runTree';
import { ParamsViewProvider } from './run/paramsView';
import { ResourcesViewProvider } from './run/resourcesView';
import type { RunTreeNode } from './run/treeModel';
import { issuesToDiagnostics } from './run/characterDiagnostics';
import { configuredCharacterDataPaths, loadCharacterManagerData } from './characterData';
import { insertIntoPythonEditor } from './pythonEditor';
import { findReferencesInText } from './templateReferences';
import { CharacterManagerPanel, detectCharacterData } from './characterPanel';
import { GameConnectService } from './toolboxConnect';
import { TemplateAssetData } from './templateAssetData';
import {
  TemplateAssetViewProvider,
  TemplateAssetPanel,
  repaintAllAssetGalleries,
  setPublishedTemplateNamesProvider,
} from './templateAssetPanel';
import { TempScreenshotStore } from './tempScreenshotStore';
import { TempScreenshotViewProvider } from './tempScreenshotPanel';
import { notifyAnnotationDataChanged } from './cocoAnnotationData';
import { AnnotationPanel } from './annotationPanel';

/** 缩略图缓存 key 版本：内容 hash 化后旧命名（t_/a_）需要清理一次 */
const THUMB_KEY_VERSION = 'content-hash-v2';
const LEGACY_THUMB_PURGE_KEY = 'okScriptToolkit.legacyThumbPurgeVersion';

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  let targetRoot = resolveProjectDir() || folder?.uri.fsPath || '';
  // 模板目录名可配，但 `pngCrop` **刻意不自己读配置**（它被纯 Node 沙箱测试直接 require，
  // 见 `setTemplatesDirName` 的注释），由宿主注入；配置变更时在下面重新注入一次。
  // 记住当前值：配置变更时只有它**真的变了**才需要清缩略图目录（见下面 onDidChangeConfiguration）。
  const currentTemplatesDir = templatesDirectory(targetRoot);
  let templatesDir = currentTemplatesDir;
  setTemplatesDirName(currentTemplatesDir);
  const data = new LangData(targetRoot);
  const features = new FeatureData(targetRoot);
  const effects = new EffectData(targetRoot);
  const inlay = new LangInlayHintsProvider(data, features, effects);
  const jsonInlay = new EffectInlayHintsProvider(effects);
  // 模板缩略图 PNG 落盘目录（按工作区隔离，避免多工作区共享缓存冲突）
  // hash 第一个工作区路径作为子目录，不同工作区 → 不同目录
  // 临时截图及缩略图属于当前 IDE 工作区；切换 ok-script 目标项目时
  // 这两个存储保持同一工作区桶，已打开的视图也继续使用有效的资源根。
  const wsHash = crypto.createHash('sha1')
    .update(folder?.uri.fsPath || 'default')
    .digest('hex').slice(0, 12);
  const thumbDir = path.join(context.globalStorageUri.fsPath, 'template-thumbs', wsHash);

  // 性能日志输出通道：查看 → 输出 → ok-script-toolkit
  const cropLog = vscode.window.createOutputChannel('ok-script-toolkit');
  setCropLogger((msg) => cropLog.appendLine(msg));
  setCaptureLogger((msg) => cropLog.appendLine(msg));
  context.subscriptions.push(cropLog);
  context.subscriptions.push({ dispose: disposeCaptureWorker });

  // 初始化 worker 线程池（纯 JS 图像处理，主线程零阻塞）
  initCropWorkerPool(context.extensionPath);
  // saveToAssets 打包渲染专用池（PNG 解码 + level-6 deflate 全在 worker）
  initAssetPackPool(context.extensionPath);

  // 后台预热：把全部模板缩略图裁进缓存，后续 hover/补全直接命中
  const prewarm = () => {
    const reqs = features.all().map((ft) => ({
      imagePath: ft.imagePath,
      bbox: ft.bbox,
      targetHeight: THUMB_HEIGHT,
      thumbDir: thumbDirForSource(thumbDir, ft.imagePath),
    }));
    void warmCropCache(reqs);
  };

  // ---- 各数据源独立防抖刷新（300ms） ----
  type RefreshTarget = { lang: boolean; features: boolean; effects: boolean; coco: boolean; annotations: boolean };

  const DEBOUNCE_MS = 300;

  let langTimer: NodeJS.Timeout | undefined;
  const refreshLang = () => {
    if (langTimer) clearTimeout(langTimer);
    langTimer = setTimeout(() => {
      data.refresh(true);
      inlay.fire();
    }, DEBOUNCE_MS);
  };

  let featTimer: NodeJS.Timeout | undefined;
  const refreshFeatures = (changedUris?: vscode.Uri[]) => {
    if (featTimer) clearTimeout(featTimer);
    featTimer = setTimeout(() => {
      features.refresh(true);
      let cacheInvalidated = false;
      if (changedUris && changedUris.length > 0) {
        const sources = new Set<string>();
        for (const uri of changedUris) {
          sources.add(thumbSourceSubdir(uri.fsPath));
        }
        const tplDir = templatesDirectory(targetRoot);
        for (const src of sources) {
          if (src === tplDir) {
            const pngRe = /\.png$/i;
            const tplPrefix = `${tplDir}/`;
            const pngUris = changedUris.filter(u => {
              const normalized = u.fsPath.replace(/[\\/]+/g, '/');
              return (normalized.startsWith(tplPrefix) || normalized.includes(`/${tplPrefix}`)) && pngRe.test(u.fsPath);
            });
            for (const uri of pngUris) {
              for (const ft of features.all()) {
                if (ft.imagePath === uri.fsPath) {
                  removeTemplateThumbFile(ft.imagePath, ft.bbox, thumbDir);
                  cacheInvalidated = true;
                }
              }
              clearCropCacheForImage(uri.fsPath);
              invalidateImageContentHash(uri.fsPath);
            }
            continue;
          }
          clearSourceCropCache(src);
          clearSourceThumbs(thumbDir, src);
          cacheInvalidated = true;
        }
      } else if (changedUris === undefined) {
        clearCropCache();
        clearThumbDir(thumbDir);
        cacheInvalidated = true;
      } else {
        cacheInvalidated = true;
      }
      if (cacheInvalidated) {
        prewarm();
        repaintAllGalleries();
        CharacterManagerPanel.refreshCurrent();
      }
    }, DEBOUNCE_MS);
  };

  let effectTimer: NodeJS.Timeout | undefined;
  const refreshEffects = () => {
    if (effectTimer) clearTimeout(effectTimer);
    effectTimer = setTimeout(() => {
      effects.refresh(true);
      jsonInlay.fire();
    }, DEBOUNCE_MS);
  };

  const escapeGlobSeg = (s: string) => s.replace(/([\\*?[\]{}()!])/g, '\\$1');

  /** Watch authoring resources directly. Published position output is no longer an IDE data source. */
  const langWatchPattern = () => {
    const poGlob = poDirectorySetting().split('/').map(escapeGlobSeg).join('/');
    const tplGlob = templatesDirectory(targetRoot).split('/').map(escapeGlobSeg).join('/');
    const langGlob = i18nLangDirectorySetting().split('/').map(escapeGlobSeg).join('/');
    const effectsFile = effectsFileSetting();
    const cocoGlobs = cocoFeatureRelPaths(targetRoot)
      .map((rel) => rel.split('/').map(escapeGlobSeg).join('/'))
      .join(',');
    return `**/{${langGlob}/*.json,${poGlob}/**/*.po,${cocoGlobs},${tplGlob}/coco_annotations.json,${tplGlob}/boxes.json,${tplGlob}/points.json,assets/images/*.png,ok_tasks/assets/images/*.png,${tplGlob}/*.png,${effectsFile},config.py}`;
  };

  const getAffectedSources = (uri: vscode.Uri): RefreshTarget => {
    const empty: RefreshTarget = { lang: false, features: false, effects: false, coco: false, annotations: false };
    const rel = (targetRoot ? path.relative(targetRoot, uri.fsPath) : uri.fsPath)
      .replace(/[\\/]+/g, '/')
      .replace(/^\/+/, '');
    if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return empty;

    const poDir = poDirectorySetting();
    const effectsFile = effectsFileSetting();
    const langDir = i18nLangDirectorySetting();

    if (rel.startsWith(`${langDir}/`) && rel.endsWith('.json')) {
      return { ...empty, lang: true };
    }
    if (rel.startsWith(`${poDir}/`) && rel.endsWith('.po')) {
      return { ...empty, lang: true };
    }
    const sourceDirectory = templatesDirectory(targetRoot);
    if ([
      `${sourceDirectory}/coco_annotations.json`,
      `${sourceDirectory}/boxes.json`,
      `${sourceDirectory}/points.json`,
    ].includes(rel)) {
      return { ...empty, annotations: true };
    }
    const pngRe = /\.png$/i;
    if (cocoFeatureRelPaths(targetRoot).includes(rel)) {
      return { ...empty, features: true };
    }
    if (rel === 'config.py' || rel === 'src/config.py') {
      return { ...empty, coco: true };
    }
    if (
      (rel.startsWith('assets/images/') && pngRe.test(rel)) ||
      (rel.startsWith('ok_tasks/assets/images/') && pngRe.test(rel)) ||
      (rel.startsWith(`${templatesDirectory(targetRoot)}/`) && pngRe.test(rel))
    ) {
      return { ...empty, features: true };
    }
    if (rel === effectsFile) {
      return { ...empty, effects: true };
    }
    if (targetRoot) {
      const sameFile = (a: string, b: string) => {
        const na = a.replace(/[\\/]+/g, '/');
        const nb = b.replace(/[\\/]+/g, '/');
        return process.platform === 'win32'
          ? na.toLowerCase() === nb.toLowerCase()
          : na === nb;
      };
      if (sameFile(uri.fsPath, path.resolve(targetRoot, effectsFile))) {
        return { ...empty, effects: true };
      }
    }
    return empty;
  };

  const dispatchRefresh = (target: RefreshTarget, uri?: vscode.Uri) => {
    if (target.annotations && uri) notifyAnnotationDataChanged(uri.fsPath);
    if (target.lang) refreshLang();
    if (target.effects) refreshEffects();
    if (target.coco) {
      void refreshCocoFeaturePath(targetRoot).then(() => {
        setTimeout(() => {
          recreateWatcher();
          refreshFeatures(uri ? [uri] : undefined);
        }, 0);
      });
      return;
    }
    if (target.features) refreshFeatures(uri ? [uri] : undefined);
  };

  let watcher: vscode.FileSystemWatcher | undefined;
  const recreateWatcher = () => {
    if (watcher) watcher.dispose();
    watcher = vscode.workspace.createFileSystemWatcher(
      targetRoot ? new vscode.RelativePattern(targetRoot, langWatchPattern()) : langWatchPattern(),
    );
    watcher.onDidChange((uri) => dispatchRefresh(getAffectedSources(uri), uri));
    watcher.onDidCreate((uri) => dispatchRefresh(getAffectedSources(uri), uri));
    watcher.onDidDelete((uri) => dispatchRefresh(getAffectedSources(uri), uri));
    return watcher;
  };
  recreateWatcher();
  void refreshCocoFeaturePath(targetRoot).then(() => {
    recreateWatcher();
    refreshFeatures([]);
  });
  context.subscriptions.push({
    dispose: () => {
      disposeCropWorkerPool();
      disposeAssetPackPool();
      watcher?.dispose();
      watcher = undefined;
      if (langTimer) clearTimeout(langTimer);
      if (featTimer) clearTimeout(featTimer);
      if (effectTimer) clearTimeout(effectTimer);
    },
  });

  const characterManagerDependencies = {
    extensionUri: context.extensionUri,
    features,
    thumbDir,
  };
  const gameConnect = new GameConnectService(context.extensionUri);
  const okConsole = new ConsoleViewProvider(
    context.extensionUri,
    gameConnect,
    () => CharacterManagerPanel.show(characterManagerDependencies),
  );
  gameConnect.overlayForwarder = (enabled) => okConsole.setOverlayEnabled(enabled);

  const templateAssetData = new TemplateAssetData(targetRoot);
  setPublishedTemplateNamesProvider(() => [...features.all()].map((ft) => ft.name));
  const tempScreenshotStore = new TempScreenshotStore(
    path.join(context.globalStorageUri.fsPath, 'temp-screenshots', wsHash),
  );
  tempScreenshotStore.ensure();
  bindInboxScreenshotStore(tempScreenshotStore);
  const runTree = new RunTreeDataProvider(okConsole);
  const paramsView = new ParamsViewProvider(context.extensionUri, okConsole, runTree);
  const resourcesView = new ResourcesViewProvider(
    context.extensionUri, templateAssetData, features, tempScreenshotStore, thumbDir,
  );
  void okConsole.activateHeadless();
  const runTreeView = vscode.window.createTreeView(RunTreeDataProvider.viewId, {
    treeDataProvider: runTree,
    showCollapseAll: true,
  });
  runTree.attachTreeView(runTreeView);
  runTree.refresh();
  const tempThumbDir = path.join(context.globalStorageUri.fsPath, 'temp-thumbs', wsHash);
  if (context.globalState.get<string>(LEGACY_THUMB_PURGE_KEY) !== THUMB_KEY_VERSION) {
    purgeLegacyThumbFiles(thumbDir);
    purgeLegacyThumbFiles(tempThumbDir);
    void context.globalState.update(LEGACY_THUMB_PURGE_KEY, THUMB_KEY_VERSION);
  }
  context.subscriptions.push(gameConnect, okConsole);

  // ── 执行器状态 → 状态栏 + context key（视图标题栏 / 命令面板按状态显隐）──
  const executorStatusItem = vscode.window.createStatusBarItem('okScriptToolkit.executor', vscode.StatusBarAlignment.Left, 50);
  executorStatusItem.name = tr('ok-script Executor');
  executorStatusItem.command = 'okScriptToolkit.showTaskLauncher';
  const renderExecutorStatus = (state: ExecutorStateSummary) => {
    void vscode.commands.executeCommand('setContext', 'okScriptToolkit.executorRunning', state.status !== 'idle');
    void vscode.commands.executeCommand('setContext', 'okScriptToolkit.executorPaused', state.paused);
    void vscode.commands.executeCommand('setContext', 'okScriptToolkit.taskRunning', Boolean(state.current));
    if (state.status === 'idle') {
      executorStatusItem.text = `$(debug-stop) ${tr('ok-script: idle')}`;
      executorStatusItem.tooltip = tr('Executor is not running. Click to open the Console.');
    } else if (state.status === 'connecting') {
      executorStatusItem.text = `$(loading~spin) ${tr('ok-script: starting…')}`;
      executorStatusItem.tooltip = tr('Executor is starting. Click to open the Console.');
    } else if (state.paused) {
      executorStatusItem.text = `$(debug-pause) ${tr('ok-script: paused')}`;
      executorStatusItem.tooltip = tr('Executor is paused. Click to open the Console.');
    } else if (state.current) {
      const queued = state.queued ? ` +${state.queued}` : '';
      executorStatusItem.text = `$(sync~spin) ${state.current}${queued}`;
      executorStatusItem.tooltip = tr('Running: {task} · queued: {count}. Click to open the Console.', { task: state.current, count: state.queued });
    } else {
      executorStatusItem.text = `$(pass) ${tr('ok-script: ready')}`;
      executorStatusItem.tooltip = tr('Executor is ready · {count} trigger task(s) enabled. Click to open the Console.', { count: state.triggers });
    }
    // 空闲且当前工作区不是 ok-script 项目时不占状态栏
    if (state.status === 'idle' && !isSupportedProject(resolveProjectDir())) executorStatusItem.hide();
    else executorStatusItem.show();
  };
  renderExecutorStatus(okConsole.executorState());
  context.subscriptions.push(executorStatusItem, okConsole.onDidChangeExecutorState(renderExecutorStatus));

  // ── 角色数据检测 → 隐藏/露出「角色技能管理」入口 ──
  const characterDiagnostics = vscode.languages.createDiagnosticCollection('okScriptToolkit.characters');
  context.subscriptions.push(characterDiagnostics);
  const updateCharacterDataContext = () => {
    const available = detectCharacterData();
    void vscode.commands.executeCommand('setContext', 'okScriptToolkit.hasCharacterData', available);
    okConsole.setCharacterDataAvailable(available);
    characterDiagnostics.clear();
    if (!available) return;
    try {
      const projectDir = resolveProjectDir();
      const paths = configuredCharacterDataPaths(projectDir);
      const loaded = loadCharacterManagerData(paths);
      const mapped = issuesToDiagnostics(loaded.snapshot.issues || [], {
        masterFile: paths.masterFile,
        localeFile: paths.localeFile,
        characterDir: paths.skillsDir,
      });
      const byFile = new Map<string, vscode.Diagnostic[]>();
      for (const item of mapped) {
        const sev = item.severity === 'error' ? vscode.DiagnosticSeverity.Error
          : item.severity === 'warning' ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;
        const diag = new vscode.Diagnostic(new vscode.Range(item.line, item.character, item.line, item.character + 1), item.message, sev);
        diag.source = 'ok-script';
        const list = byFile.get(item.file) || [];
        list.push(diag);
        byFile.set(item.file, list);
      }
      for (const [file, diags] of byFile) {
        characterDiagnostics.set(vscode.Uri.file(file), diags);
      }
    } catch {
      /* 诊断失败不阻塞主流程 */
    }
  };
  updateCharacterDataContext();
  const characterDataWatcher = vscode.workspace.createFileSystemWatcher('**/assets/data/{characters.json,character_skills}');
  context.subscriptions.push(
    characterDataWatcher,
    characterDataWatcher.onDidCreate(updateCharacterDataContext),
    characterDataWatcher.onDidDelete(updateCharacterDataContext),
    vscode.workspace.onDidChangeWorkspaceFolders(updateCharacterDataContext),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('okScriptToolkit')) {
        updateCharacterDataContext();
        renderExecutorStatus(okConsole.executorState());
      }
    }),
  );

  context.subscriptions.push(
    vscode.languages.registerInlayHintsProvider(
      { language: 'python', scheme: 'file' },
      inlay,
    ),
    vscode.languages.registerHoverProvider(
      { language: 'python', scheme: 'file' },
      new LangHoverProvider(data, features, effects),
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: 'python', scheme: 'file' },
      new LangCompletionProvider(data, features, effects),
      '.', "'", '"',
    ),
    vscode.languages.registerHoverProvider(
      { language: 'json', scheme: 'file' },
      new EffectHoverProvider(effects),
    ),
    vscode.languages.registerHoverProvider(
      { language: 'jsonc', scheme: 'file' },
      new EffectHoverProvider(effects),
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: 'json', scheme: 'file' },
      new EffectCompletionProvider(effects),
      '"',
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: 'jsonc', scheme: 'file' },
      new EffectCompletionProvider(effects),
      '"',
    ),
    vscode.languages.registerInlayHintsProvider(
      { language: 'json', scheme: 'file' },
      jsonInlay,
    ),
    vscode.languages.registerInlayHintsProvider(
      { language: 'jsonc', scheme: 'file' },
      jsonInlay,
    ),
    runTreeView,
    runTree,
    paramsView,
    resourcesView,
    vscode.window.registerWebviewViewProvider(ParamsViewProvider.viewType, paramsView),
    vscode.window.registerWebviewViewProvider(ResourcesViewProvider.viewType, resourcesView),
    vscode.commands.registerCommand('okScriptToolkit.showTemplates', () => {
      void vscode.commands.executeCommand(`${ResourcesViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('okScriptToolkit.openTemplatesEditor', () => {
      TemplateGalleryPanel.show(features, thumbDir, context.extensionUri);
    }),
    vscode.commands.registerCommand('okScriptToolkit.showTaskLauncher', () => {
      void vscode.commands.executeCommand(`${RunTreeDataProvider.viewId}.focus`);
    }),
    vscode.commands.registerCommand('okScriptToolkit.openCharacterManager', () => {
      CharacterManagerPanel.show(characterManagerDependencies);
    }),
    vscode.commands.registerCommand('okScriptToolkit.console.refresh', () => okConsole.commandRefresh()),
    vscode.commands.registerCommand('okScriptToolkit.console.runTask', () => okConsole.commandRunTask()),
    vscode.commands.registerCommand('okScriptToolkit.console.startExecutor', () => okConsole.commandStartExecutor()),
    vscode.commands.registerCommand('okScriptToolkit.console.pause', () => okConsole.commandPause()),
    vscode.commands.registerCommand('okScriptToolkit.console.resume', () => okConsole.commandResume()),
    vscode.commands.registerCommand('okScriptToolkit.console.stopCurrentTask', () => okConsole.commandStopCurrent()),
    vscode.commands.registerCommand('okScriptToolkit.console.stopExecutor', () => okConsole.commandStopExecutor()),
    vscode.commands.registerCommand('okScriptToolkit.console.showLogs', () => okConsole.showLogs()),
    vscode.commands.registerCommand('okScriptToolkit.console.connectGame', () => gameConnect.connect()),
    vscode.commands.registerCommand('okScriptToolkit.console.disconnectGame', () => gameConnect.disconnect()),
    vscode.commands.registerCommand('okScriptToolkit.openTemplateAssets', () => {
      void vscode.commands.executeCommand(`${ResourcesViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('okScriptToolkit.screenshotToTemplate', () => {
      TemplateAssetPanel.showScreenshot(templateAssetData, thumbDir, context.extensionUri, tempScreenshotStore);
    }),
    vscode.commands.registerCommand('okScriptToolkit.showTempScreenshots', () => {
      void vscode.commands.executeCommand(`${ResourcesViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('okScriptToolkit.captureToInbox', () => resourcesView.captureToInbox()),
    vscode.commands.registerCommand('okScriptToolkit.publishResources', () =>
      TemplateAssetPanel.publish(templateAssetData, thumbDir, context.extensionUri, tempScreenshotStore)),
    vscode.commands.registerCommand('okScriptToolkit.annotateImage', (target?: vscode.Uri | string) =>
      vscode.commands.executeCommand('okScriptToolkit.openAnnotationEditor', target)),
    vscode.commands.registerCommand('okScriptToolkit.insertResourceReference', async (expression?: string) => {
      const text = expression || await vscode.window.showInputBox({ prompt: tr('Resource expression (e.g. fL.btn_claim)') });
      if (text) insertIntoPythonEditor(text);
    }),
    vscode.commands.registerCommand('okScriptToolkit.revealResource', async (name?: string) => {
      await vscode.commands.executeCommand(`${ResourcesViewProvider.viewType}.focus`);
      if (typeof name === 'string' && name) resourcesView.reveal(name);
    }),
    vscode.commands.registerCommand('okScriptToolkit.findTemplateReferences', async (name?: string) => {
      let target = typeof name === 'string' ? name : '';
      if (!target) {
        const picked = await vscode.window.showQuickPick(
          [...features.all()].map((ft) => ({ label: ft.name, description: `${ft.width}×${ft.height}` })),
          { placeHolder: tr('Select a template to find references') },
        );
        target = picked?.label || '';
      }
      if (!target) return;
      const files = await vscode.workspace.findFiles('**/*.py', '**/{.venv,venv,node_modules,.git,__pycache__}/**', 2000);
      const items: (vscode.QuickPickItem & { location: vscode.Location })[] = [];
      for (const uri of files) {
        let text = '';
        try { text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'); } catch { continue; }
        if (!text.includes(target)) continue;
        for (const ref of findReferencesInText(text, target, featureAliases())) {
          items.push({
            label: `$(${ref.kind === 'position' ? 'symbol-field' : ref.kind === 'key' ? 'symbol-string' : 'symbol-constant'}) ${ref.preview}`,
            description: `${vscode.workspace.asRelativePath(uri)}:${ref.line + 1}`,
            location: new vscode.Location(uri, new vscode.Range(ref.line, ref.column, ref.line, ref.column + ref.length)),
          });
        }
      }
      if (!items.length) {
        void vscode.window.showInformationMessage(tr('No references to “{name}” found in Python files.', { name: target }));
        return;
      }
      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: tr('{count} reference(s) to “{name}”', { count: items.length, name: target }),
        matchOnDescription: true,
      });
      if (choice) await vscode.window.showTextDocument(choice.location.uri, { selection: choice.location.range });
    }),
    vscode.commands.registerCommand('okScriptToolkit.pickProject', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        openLabel: tr('Use as ok-script project'),
      });
      if (picked?.[0]) {
        await vscode.workspace.getConfiguration('okScriptToolkit').update('okScriptProjectPath', picked[0].fsPath, vscode.ConfigurationTarget.Workspace);
      }
    }),
    vscode.commands.registerCommand('okScriptToolkit.run.openParams', (node?: RunTreeNode) => paramsView.openForNode(node)),
    vscode.commands.registerCommand('okScriptToolkit.run.runTaskInline', async (node?: RunTreeNode) => {
      if (node?.taskKey) await okConsole.enqueueByKey(node.taskKey);
    }),
    vscode.commands.registerCommand('okScriptToolkit.run.toggleTrigger', async (node?: RunTreeNode) => {
      if (node?.taskKey) await okConsole.setTriggerEnabledByKey(node.taskKey, !node.checked);
    }),
    vscode.commands.registerCommand('okScriptToolkit.openAnnotationEditor', async (target?: vscode.Uri | string) => {
      // 资源管理器右键 / 带参数调用时直接打开；否则让用户从标注管理的图片里选一张。
      templateAssetData.load();
      const images = templateAssetData.listImages();
      const fromArg = typeof target === 'string' ? target : target?.fsPath;
      let imagePath = fromArg && images.find((image) => path.resolve(image) === path.resolve(fromArg));
      if (fromArg && !imagePath) {
        void vscode.window.showWarningMessage(tr('This image is not in Annotation Management yet. Add it there first.'));
        return;
      }
      if (!imagePath) {
        if (!images.length) {
          const add = tr('Open Annotation Management');
          const choice = await vscode.window.showInformationMessage(tr('No images to annotate yet. Capture or import one in Annotation Management first.'), add);
          if (choice === add) TemplateAssetPanel.show(templateAssetData, thumbDir, context.extensionUri, tempScreenshotStore);
          return;
        }
        const picked = await vscode.window.showQuickPick(
          images.map((image) => ({
            label: path.basename(image),
            description: tr('{count} annotations', { count: templateAssetData.getAnnotationsForImage(image, true).length }),
            detail: path.relative(targetRoot || path.dirname(image), image),
            image,
          })),
          { placeHolder: tr('Select an image to annotate'), matchOnDetail: true },
        );
        imagePath = picked?.image;
      }
      if (!imagePath) return;
      AnnotationPanel.show(context.extensionUri, templateAssetData, thumbDir, imagePath, images, () => {
        repaintAllAssetGalleries();
      });
    }),
    vscode.commands.registerCommand('okScriptToolkit.openResourcePublisher', () => {
      return TemplateAssetPanel.publish(templateAssetData, thumbDir, context.extensionUri, tempScreenshotStore);
    }),
    vscode.commands.registerCommand('okScriptToolkit.showConventionSources', () => {
      showConventionSources();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('okScriptToolkit')) {
        const nextRoot = resolveProjectDir() || folder?.uri.fsPath || '';
        if (nextRoot !== targetRoot) {
          targetRoot = nextRoot;
          data.setRoot(targetRoot);
          features.setRoot(targetRoot);
          effects.setRoot(targetRoot);
          templateAssetData.setRoot(targetRoot);
          void refreshCocoFeaturePath(targetRoot).then(() => refreshFeatures([]));
          repaintAllAssetGalleries();
        }
        const nextTemplatesDir = templatesDirectory(targetRoot);
        setTemplatesDirName(nextTemplatesDir);
        recreateWatcher();
        data.refresh(true);
        features.refresh(true);
        effects.refresh(true);
        if (nextTemplatesDir !== templatesDir) {
          templatesDir = nextTemplatesDir;
          clearCropCache();
          clearThumbDir(thumbDir);
        }
        prewarm();
        inlay.fire();
        jsonInlay.fire();
        repaintAllGalleries();
        CharacterManagerPanel.refreshCurrent();
      }
    }),
  );

  data.refresh(true);
  features.refresh(true);
  effects.refresh(true);
  prewarm();
}

export function deactivate(): void {
  // nothing to do
}
