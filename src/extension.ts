import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { LangData, poDirectorySetting } from './langData';
import { tr } from './localization';
import { cocoFeatureRelPaths, refreshCocoFeaturePath } from './cocoFeaturePath';
import { effectsFileSetting, i18nLangDirectorySetting, templatesDirectory } from './projectConfig';
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
import { TaskLauncherViewProvider } from './taskLauncher';
import { CharacterManagerLauncherViewProvider, CharacterManagerPanel } from './characterPanel';
import { TemplateAssetData } from './templateAssetData';
import {
  TemplateAssetViewProvider,
  TemplateAssetPanel,
  repaintAllAssetGalleries,
} from './templateAssetPanel';
import { TempScreenshotStore } from './tempScreenshotStore';
import { TempScreenshotViewProvider } from './tempScreenshotPanel';

/** 缩略图缓存 key 版本：内容 hash 化后旧命名（t_/a_）需要清理一次 */
const THUMB_KEY_VERSION = 'content-hash-v2';
const LEGACY_THUMB_PURGE_KEY = 'okScriptToolkit.legacyThumbPurgeVersion';

export function activate(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  // 模板目录名可配，但 `pngCrop` **刻意不自己读配置**（它被纯 Node 沙箱测试直接 require，
  // 见 `setTemplatesDirName` 的注释），由宿主注入；配置变更时在下面重新注入一次。
  setTemplatesDirName(templatesDirectory(folder?.uri.fsPath));
  const data = new LangData(folder);
  const features = new FeatureData(folder);
  const effects = new EffectData(folder);
  const inlay = new LangInlayHintsProvider(data, features, effects);
  const jsonInlay = new EffectInlayHintsProvider(effects);
  // 模板缩略图 PNG 落盘目录（按工作区隔离，避免多工作区共享缓存冲突）
  // hash 第一个工作区路径作为子目录，不同工作区 → 不同目录
  const wsHash = crypto.createHash('sha1')
    .update(folder?.uri.fsPath ?? 'default')
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
      thumbDir: thumbDirForSource(thumbDir, ft.imagePath),  // 按来源分目录
    }));
    void warmCropCache(reqs);
  };

  // ---- 各数据源独立防抖刷新（300ms） ----
  /** 哪些数据源需要刷新（由 getAffectedSources 判定） */
  type RefreshTarget = { lang: boolean; features: boolean; effects: boolean; coco: boolean };

  const DEBOUNCE_MS = 300;

  // lang 数据：self.lang JSON / gettext PO → 刷新 LangData + 幽灵注释
  let langTimer: NodeJS.Timeout | undefined;
  const refreshLang = () => {
    if (langTimer) clearTimeout(langTimer);
    langTimer = setTimeout(() => {
      data.refresh(true);
      inlay.fire();
    }, DEBOUNCE_MS);
  };

  // 模板数据：coco_annotations.json / 图片 PNG → 刷新 FeatureData + 清缓存 + 预热 + 画廊
  let featTimer: NodeJS.Timeout | undefined;
  const refreshFeatures = (changedUris?: vscode.Uri[]) => {
    if (featTimer) clearTimeout(featTimer);
    featTimer = setTimeout(() => {
      features.refresh(true);
      let cacheInvalidated = false;
      // 按变更文件的选择性清除：只清受影响来源的缩略图
      if (changedUris && changedUris.length > 0) {
        const sources = new Set<string>();
        for (const uri of changedUris) {
          sources.add(thumbSourceSubdir(uri.fsPath));
        }
        const tplDir = templatesDirectory(folder?.uri.fsPath);
        for (const src of sources) {
          // 模板目录：只清被改动 PNG 对应的缩略图，不影响同源其他 PNG
          if (src === tplDir) {
            const pngRe = /\.png$/i;
            // fsPath 在 Windows 上是反斜杠，先归一化再做目录段匹配。
            // 用 startsWith/includes 而不是正则：目录名可配，拼正则还要转义，
            // 漏转义时失配是**静默**的（缩略图永远不刷新）。
            const tplPrefix = `${tplDir}/`;
            const pngUris = changedUris.filter(u => {
              const normalized = u.fsPath.replace(/[\\/]+/g, '/');
              return (normalized.startsWith(tplPrefix) || normalized.includes(`/${tplPrefix}`)) && pngRe.test(u.fsPath);
            });
            for (const uri of pngUris) {
              // 先删旧缩略图（此时内容 hash 记录仍是旧值，才能删到旧文件），再作废指纹
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
      } else {
        // 无变更信息时（如手动触发），清全部
        clearCropCache();
        clearThumbDir(thumbDir);
        cacheInvalidated = true;
      }
      if (cacheInvalidated) {
        prewarm();
        repaintAllGalleries();
        CharacterManagerPanel.refreshCurrent();
      }
    }, DEBOUNCE_MS);
  };

  // 效果 ID：effects.py → 刷新 EffectData + JSON 幽灵注释
  let effectTimer: NodeJS.Timeout | undefined;
  const refreshEffects = () => {
    if (effectTimer) clearTimeout(effectTimer);
    effectTimer = setTimeout(() => {
      effects.refresh(true);
      jsonInlay.fire();
    }, DEBOUNCE_MS);
  };

  /** 转义 glob 元字符（PO 目录可能含 . 等） */
  const escapeGlobSeg = (s: string) => s.replace(/([\\*?[\]{}()!])/g, '\\$1');

  /** 语言数据监听 glob：lang JSON + gettext PO + 模板数据 + 效果 ID */
  const langWatchPattern = () => {
    // `poDirectorySetting()` / `i18nLangDirectorySetting()` / `effectsFileSetting()` 出来的
    // 值都已过 `normalizeRelPath`（`\` → `/`、去首尾斜杠与开头 `./`），这里不再重复处理。
    const poGlob = poDirectorySetting().split('/').map(escapeGlobSeg).join('/');
    // 模板目录名可配：拼进 glob 前按段转义（目录名可能含 `[`、`*` 等 glob 元字符）。
    // 不转义时 watcher 静默失配 —— 界面正常，但改了模板文件不刷新。
    const tplGlob = templatesDirectory(folder?.uri.fsPath).split('/').map(escapeGlobSeg).join('/');
    // langDirectory 同样可配（IDE 设置 → 项目约定 `i18n.langDirectory`），所以也不能写死。
    const langGlob = i18nLangDirectorySetting().split('/').map(escapeGlobSeg).join('/');
    const effectsFile = effectsFileSetting();
    // 运行时模板库路径可配（项目约定 `templates.cocoAnnotations` → config.py 的
    // `template_matching.coco_feature_json` → 两个惯例位置），所以也不能写死。
    const cocoGlobs = cocoFeatureRelPaths(folder?.uri.fsPath ?? '')
      .map((rel) => rel.split('/').map(escapeGlobSeg).join('/'))
      .join(',');
    // 末尾的 `config.py`：它决定运行时模板库放在哪，改了要重探 + 重建监听。
    // 放在 `**/{...}` 里等价于 `**/config.py`（任意深度的同名文件都会派发进来，
    // `getAffectedSources` 再按路径筛一次）。
    return `**/{${langGlob}/*.json,${poGlob}/**/*.po,${cocoGlobs},assets/images/*.png,ok_tasks/assets/images/*.png,${tplGlob}/*.png,${effectsFile},config.py}`;
  };

  /**
   * 判定变更文件属于哪些数据源（lang / features / effects）。
   * createFileSystemWatcher 的字符串 glob 在嵌套路径 + brace 组合下可能把工作区
   * 任意文件变更都派发进来，因此这里按 URI 的相对路径二次过滤，避免每次保存任意
   * 代码都重载模板库。
   */
  const getAffectedSources = (uri: vscode.Uri): RefreshTarget => {
    const empty: RefreshTarget = { lang: false, features: false, effects: false, coco: false };
    const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
    const rel = (wsFolder ? path.relative(wsFolder.uri.fsPath, uri.fsPath) : uri.fsPath)
      .replace(/[\\/]+/g, '/')
      .replace(/^\/+/, '');
    if (!rel) return empty;

    const poDir = poDirectorySetting();
    // 同上：取值链已归一化，这里不再重复 replace
    const effectsFile = effectsFileSetting();
    const langDir = i18nLangDirectorySetting();

    if (rel.startsWith(`${langDir}/`) && rel.endsWith('.json')) {
      return { ...empty, lang: true };
    }
    if (rel.startsWith(`${poDir}/`) && rel.endsWith('.po')) {
      return { ...empty, lang: true };
    }
    const pngRe = /\.png$/i;
    // 运行时模板库：路径可配（项目约定 → config.py → 两个惯例位置），所以不能写死。
    if (cocoFeatureRelPaths(folder?.uri.fsPath ?? '').includes(rel)) {
      return { ...empty, features: true };
    }
    // `config.py` 决定库放在哪 —— 它一变就要**重探 + 重建监听**，不只是刷新数据。
    // 只认 `_resolve_config_path` 会看的两个位置（任意深度的 config.py 都会派发进来，这里再筛一次）。
    if (rel === 'config.py' || rel === 'src/config.py') {
      return { ...empty, coco: true };
    }
    if (
      (rel.startsWith('assets/images/') && pngRe.test(rel)) ||
      (rel.startsWith('ok_tasks/assets/images/') && pngRe.test(rel)) ||
      (rel.startsWith(`${templatesDirectory(folder?.uri.fsPath)}/`) && pngRe.test(rel))
    ) {
      return { ...empty, features: true };
    }
    // 相对路径按工作区相对比较；绝对路径配置（如 D:/proj/src/data/effects.py）按解析后的绝对路径比较
    if (rel === effectsFile) {
      return { ...empty, effects: true };
    }
    if (wsFolder) {
      const sameFile = (a: string, b: string) => {
        const na = a.replace(/[\\/]+/g, '/');
        const nb = b.replace(/[\\/]+/g, '/');
        return process.platform === 'win32'
          ? na.toLowerCase() === nb.toLowerCase()
          : na === nb;
      };
      if (sameFile(uri.fsPath, path.resolve(wsFolder.uri.fsPath, effectsFile))) {
        return { ...empty, effects: true };
      }
    }
    return empty;
  };

  const dispatchRefresh = (target: RefreshTarget, uri?: vscode.Uri) => {
    if (target.lang) refreshLang();
    if (target.effects) refreshEffects();
    if (target.coco) {
      // 先重探库路径再刷新特征 —— 顺序反了会拿旧路径白读一遍。
      // 用 setTimeout 跳出当前 watcher 回调再重建监听：不想在自己的事件处理里同步 dispose 自己。
      void refreshCocoFeaturePath(folder?.uri.fsPath).then(() => {
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
    watcher = vscode.workspace.createFileSystemWatcher(langWatchPattern());
    watcher.onDidChange((uri) => dispatchRefresh(getAffectedSources(uri), uri));
    watcher.onDidCreate((uri) => dispatchRefresh(getAffectedSources(uri), uri));
    watcher.onDidDelete((uri) => dispatchRefresh(getAffectedSources(uri), uri));
    return watcher;
  };
  recreateWatcher();
  // 运行时模板库的路径可能来自 config.py 的 `template_matching.coco_feature_json`
  // （异步探测）。探到之后要**重建监听并刷新一次** —— 否则首次激活用的是兜底探测，
  // 探到的真实路径要等到下次文件变动才生效，而"配置生效不了"是静默的。
  void refreshCocoFeaturePath(folder?.uri.fsPath).then(() => {
    recreateWatcher();
    refreshFeatures();
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

  const taskLauncher = new TaskLauncherViewProvider(context.extensionUri);
  const characterManagerDependencies = {
    extensionUri: context.extensionUri,
    features,
    thumbDir,
  };

  // 模板素材数据管理
  const templateAssetData = new TemplateAssetData(folder);
  // 临时截图存储（侧边栏最多 10 张，按工作区隔离）
  const tempScreenshotStore = new TempScreenshotStore(
    path.join(context.globalStorageUri.fsPath, 'temp-screenshots', wsHash),
  );
  tempScreenshotStore.ensure();
  const tempThumbDir = path.join(context.globalStorageUri.fsPath, 'temp-thumbs', wsHash);
  // 缩略图命名已由「原图路径」切换为「原图内容 hash」：清理旧格式残留，
  // 否则旧缩略图会一直躺在缓存目录里（升级后按新名字查找，永远读不到也删不掉）
  if (context.globalState.get<string>(LEGACY_THUMB_PURGE_KEY) !== THUMB_KEY_VERSION) {
    purgeLegacyThumbFiles(thumbDir);
    purgeLegacyThumbFiles(tempThumbDir);
    void context.globalState.update(LEGACY_THUMB_PURGE_KEY, THUMB_KEY_VERSION);
  }
  context.subscriptions.push(taskLauncher);

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
    // 效果 ID 提示：JSON / JSONC 数据文件（character_skills/*.json 等）中的
    // "effect_id": "XXX" hover 显示分类与描述，引号内补全效果 ID。
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
    // 效果 ID 幽灵注释：JSON / JSONC 中 "effect_id": "XXX" 后行内显示中文描述
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
      TaskLauncherViewProvider.viewType,
      taskLauncher,
    ),
    vscode.window.registerWebviewViewProvider(
      CharacterManagerLauncherViewProvider.viewType,
      new CharacterManagerLauncherViewProvider(characterManagerDependencies),
    ),
    vscode.window.registerWebviewViewProvider(
      TemplateAssetViewProvider.viewType,
      new TemplateAssetViewProvider(templateAssetData, thumbDir, context.extensionUri, context.globalState, tempScreenshotStore),
    ),
    vscode.window.registerWebviewViewProvider(
      TempScreenshotViewProvider.viewType,
      new TempScreenshotViewProvider(tempScreenshotStore, templateAssetData, tempThumbDir, context.extensionUri),
    ),
    vscode.commands.registerCommand('okScriptToolkit.showTemplates', () => {
      // 聚焦活动栏中的模板视图（左侧图标 Tab）
      void vscode.commands.executeCommand(`${TemplateGalleryViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('okScriptToolkit.openTemplatesEditor', () => {
      TemplateGalleryPanel.show(features, thumbDir, context.extensionUri);
    }),
    vscode.commands.registerCommand('okScriptToolkit.showTaskLauncher', () => {
      // 聚焦活动栏中的任务启动视图
      void vscode.commands.executeCommand(`${TaskLauncherViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('okScriptToolkit.openCharacterManager', () => {
      CharacterManagerPanel.show(characterManagerDependencies);
    }),
    vscode.commands.registerCommand('okScriptToolkit.openTemplateAssets', () => {
      TemplateAssetPanel.show(templateAssetData, thumbDir, context.extensionUri, context.globalState, tempScreenshotStore);
    }),
    vscode.commands.registerCommand('okScriptToolkit.screenshotToTemplate', () => {
      // 快捷键入口（默认 ctrl+alt+s）：打开标注模板管理面板并立即截图。
      // 复用面板自己的截图动作 —— 不新增截图实现，否则两条路径的行为迟早漂移。
      TemplateAssetPanel.showScreenshot(templateAssetData, thumbDir, context.extensionUri, context.globalState, tempScreenshotStore);
    }),
    vscode.commands.registerCommand('okScriptToolkit.showTempScreenshots', () => {
      // 聚焦活动栏中的临时截图视图
      void vscode.commands.executeCommand(`${TempScreenshotViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand('okScriptToolkit.openAnnotationEditor', () => {
      // 打开当前选中的图片，或者提示用户先选择
      void vscode.window.showInformationMessage(tr('Please click an image in the Template Assets panel to open the annotation editor.'));
    }),
    vscode.commands.registerCommand('okScriptToolkit.showConventionSources', () => {
      // 「项目约定 vs 我的设置」：显示每一项的生效值来自哪一层，并可清掉个人覆盖。
      // 存在的理由见 docs/project-config.md §3 —— 个人偏好最高会让项目声明"永久失效"。
      showConventionSources();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('okScriptToolkit')) {
        // 模板目录名可能变了，先重新注入 —— 下面 clearThumbDir/prewarm 都会用到它
        setTemplatesDirName(templatesDirectory(folder?.uri.fsPath));
        recreateWatcher();
        data.refresh(true);
        features.refresh(true);
        effects.refresh(true);
        clearCropCache();
        clearThumbDir(thumbDir);
        prewarm();
        inlay.fire();
        jsonInlay.fire();
        repaintAllGalleries();
        CharacterManagerPanel.refreshCurrent();
      }
    }),
  );

  // 首次激活：先加载数据，再后台预热缩略图缓存
  data.refresh(true);
  features.refresh(true);
  effects.refresh(true);
  prewarm();
}

export function deactivate(): void {
  // nothing to do
}
