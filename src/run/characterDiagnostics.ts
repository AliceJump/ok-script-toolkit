/**
 * Map character-data issues to VS Code Diagnostic-shaped objects (pure).
 * First version: file-level range (line 0). Precise JSON offsets are P2.
 */
export interface CharacterIssueLike {
  message: string;
  severity: 'error' | 'warning' | 'info';
  source?: { fileName?: string; kind?: string; characterId?: string };
}

export interface DiagnosticLike {
  file: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  line: number;
  character: number;
}

export function issuesToDiagnostics(
  issues: CharacterIssueLike[],
  roots: { masterFile?: string; localeFile?: string; characterDir?: string } = {},
): DiagnosticLike[] {
  return issues.map((issue) => {
    const fileName = issue.source?.fileName;
    let file = fileName || roots.masterFile || 'characters.json';
    if (fileName && roots.characterDir && !fileName.includes('/') && !fileName.includes('\\')) {
      file = roots.characterDir.replace(/[\\/]$/, '') + '/' + fileName;
    }
    return {
      file,
      message: issue.message,
      severity: issue.severity,
      line: 0,
      character: 0,
    };
  });
}
