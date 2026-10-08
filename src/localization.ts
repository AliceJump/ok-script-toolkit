import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export type SupportedUiLocale = 'zh-cn' | 'zh-tw' | 'en' | 'ja' | 'ko' | 'es';

export function uiLocale(language = vscode.env.language): SupportedUiLocale {
  const normalized = language.toLowerCase().replace('_', '-');
  if (normalized === 'zh-cn' || normalized.startsWith('zh-hans') || normalized === 'zh') return 'zh-cn';
  if (normalized === 'zh-tw' || normalized.startsWith('zh-hant')) return 'zh-tw';
  if (normalized.startsWith('ja')) return 'ja';
  if (normalized.startsWith('ko')) return 'ko';
  if (normalized.startsWith('es')) return 'es';
  return 'en';
}

export function projectLocale(language = vscode.env.language): string {
  const locale = uiLocale(language);
  const map: Record<SupportedUiLocale, string> = {
    'zh-cn': 'zh_CN',
    'zh-tw': 'zh_TW',
    en: 'en_US',
    ja: 'ja_JP',
    ko: 'ko_KR',
    es: 'es_ES',
  };
  return map[locale];
}

/** UI language mode selected in toolkit settings; auto follows the IDE UI. */
export function selectedProjectLocale(): string {
  const configured = vscode.workspace.getConfiguration('okScriptToolkit').get<string>('displayLocale') || 'auto';
  return configured === 'auto' ? projectLocale() : configured;
}

export function tr(message: string, args?: Record<string, string | number | boolean>): string {
  return args ? vscode.l10n.t(message, args) : vscode.l10n.t(message);
}

export interface WebviewStrings {
  [key: string]: string;
}

const dictionaries = new Map<SupportedUiLocale, WebviewStrings>();

function dictionary(locale: SupportedUiLocale): WebviewStrings {
  const cached = dictionaries.get(locale);
  if (cached) return cached;
  const file = path.join(__dirname, '..', 'l10n', 'webview.' + locale + '.json');
  const strings: WebviewStrings = JSON.parse(fs.readFileSync(file, 'utf8'));
  dictionaries.set(locale, strings);
  return strings;
}

export function webviewStrings(language = vscode.env.language): WebviewStrings {
  return dictionary(uiLocale(language));
}

export function formatWebviewString(strings: WebviewStrings, key: string, args: Record<string, unknown> = {}): string {
  const template = strings[key] || dictionary('en')[key] || key;
  return template.replace(/\{(\w+)\}/g, (_all, name: string) => String(args[name] ?? `{${name}}`));
}

export function injectWebviewLocalization(html: string, marker = '__I18N_JSON__'): string {
  return html.split(marker).join(JSON.stringify(webviewStrings()).replace(/</g, '\\u003c'));
}
