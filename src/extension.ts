import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { LangData, poDirectorySetting } from './langData';
import { tr } from './localization';
import { cocoFeatureRelPaths, refreshCocoFeaturePath } from './cocoFeaturePath';
import { effectsFileSetting, i18nLangDirectorySetting, resolveProjectDir, templatesDirectory } from './projectConfig';
import { showConventionSources } from './conventionSources';
import { FeatureData } from './featureData';
import { EffectData } from './effectData';
import { clearCropCache, clearSourceCropCache, clearCropCacheForImage, removeTemplateThumbFile, clearThumbDir, warmCropCache, initCropWorkerPool, disposeCropWorkerPool, setCropLogger, setTemplatesDirName, THUMB_HEIGHT, thumbDirForSource, thumbSourceSubdir, clearSourceThumbs, purgeLegacyThumbFiles, invalidateImageContentHash } from './pngCrop';
import { initAssetPackPool, disposeAssetPackPool } from './assetPack';
import {
  LangCompletionProvider,
  LangHoverProvider,
  LangInlayHintsProvider,
} from './providers';
import { EffectCompletionProvider, EffectHoverProvider, EffectInlayHintsProvider } from './effectProvider';
import {
  TemplateGalleryPanel,
  TemplateGalleryViewProvider,
  repaintAllGalleries,
} from './templatePanel';
import { ConsoleViewProvider } from './consolePanel';
import { CharacterManagerPanel } from './characterPanel';
import { GameConnectService } from './toolboxConnect';
import { TemplateAssetData } from './templateAssetData';
import {
  TemplateAssetViewProvider,
  TemplateAssetPanel,
  repaintAllAssetGalleries,
} from './templateAssetPanel';
import { TempScreenshotStore } from './tempScreenshotStore';
import { TempScreenshotViewProvider } from './tempScreenshotPanel';
import { notifyAnnotationDataChanged } from './cocoAnnotationData';

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
  context.subscriptions.push(cropLog);

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
  const tempScreenshotStore = new TempScreenshotStore(
    path.join(context.globalStorageUri.fsPath, 'temp-screenshots', wsHash),
  );
  tempScreenshotStore.ensure();
  const tempThumbDir = path.join(context.globalStorageUri.fsPath, 'temp-thumbs', wsHash);
  if (context.globalState.get<string>(LEGACY_THUMB_PURGE_KEY) !== THUMB_KEY_VERSION) {
    purgeLegacyThumbFiles(thumbDir);
    purgeLegacyThumbFiles(tempThumbDir);
    void context.globalState.update(LEGACY_THUMB_PURGE_KEY, THUMB_KEY_VERSION);
  }
  context.subscriptions.push(gameConnect, okConsole);

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
    vscode.window.registerWebviewViewProvider(
      TemplateGalleryViewProvider.viewType,
      new TemplateGalleryViewProvider(context.extensionUri, features, thumbDir),
    ),
    vscode.window.registerWebviewViewProvider(
      ConsoleViewProvider.viewType,
      okConsole,
    ),
    vscode.window.registerWebviewViewProvider(
      TemplateAssetViewProvider.viewType,
      new TemplateAssetViewProvider(templateAssetData, thumbDir, context.extensionUri, tempScreenshotStore),
    ),
    vscode.window.registerWebviewViewProvider(
      TempScreenshotViewProvider.viewType,
      new TempScreenshotViewProvider(tempScreenshotStore, templateAssetData, tempThumbDir, context.extensionUri),
    ),
    vscode.commands.registerCommand('okScriptToolkit.showTemplates', () => {
      void vscode.commands.executeCommand(`${TemplateGalleryViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('okScriptToolkit.openTemplatesEditor', () => {
      TemplateGalleryPanel.show(features, thumbDir, context.extensionUri);
    }),
    vscode.commands.registerCommand('okScriptToolkit.showTaskLauncher', () => {
      void vscode.commands.executeCommand(`${ConsoleViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('okScriptToolkit.openCharacterManager', () => {
      CharacterManagerPanel.show(characterManagerDependencies);
    }),
    vscode.commands.registerCommand('okScriptToolkit.openTemplateAssets', () => {
      TemplateAssetPanel.show(templateAssetData, thumbDir, context.extensionUri, tempScreenshotStore);
    }),
    vscode.commands.registerCommand('okScriptToolkit.screenshotToTemplate', () => {
      TemplateAssetPanel.showScreenshot(templateAssetData, thumbDir, context.extensionUri, tempScreenshotStore);
    }),
    vscode.commands.registerCommand('okScriptToolkit.showTempScreenshots', () => {
      void vscode.commands.executeCommand(`${TempScreenshotViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('okScriptToolkit.openAnnotationEditor', () => {
      void vscode.window.showInformationMessage(tr('Please click an image in the Template Assets panel to open the annotation editor.'));
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
