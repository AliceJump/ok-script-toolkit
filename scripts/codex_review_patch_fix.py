from pathlib import Path

p = Path('scripts/codex_review_patch.py')
s = p.read_text(encoding='utf-8')
old = "s = replace_once(s, \"      case 'thumbs': {\\n        for (const it of (msg.items || []))\", \"      case 'thumbs': {\\n        if (msg.mode && msg.mode !== currentMode) break;\\n        for (const it of (msg.items || []))\", 'thumb mode guard')"
new = "s = replace_once(s, \"      case 'thumbs':\\n        for (const item of (msg.items || []))\", \"      case 'thumbs':\\n        if (msg.mode && msg.mode !== currentMode) break;\\n        for (const item of (msg.items || []))\", 'thumb mode guard')"
if old not in s:
    raise SystemExit('patch-script thumb matcher not found')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
