import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './demo-sandbox.mjs';
import { scanTree } from './leak-scan.mjs';
/** Scan generated model text before replacing any public evidence. */
export function writeProof(target, markdown) {
  for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN']) {
    if (process.env[key] && markdown.includes(process.env[key])) throw new Error('model output contains a credential');
  }
  if (/\/Users\/|\.work-intelligence-mcp\/|live.connector|outlook\.office\.com/i.test(markdown)) throw new Error('proof contains private paths or live connector output');
  const dir=mkdtempSync(join(process.env.WI_DEMO_STATE,'proof-'));
  try {
    writeFileSync(join(dir,'proof.md'),markdown);
    const scan=scanTree(dir,{strict:true,patterns:join(ROOT,'scripts/leak-patterns.txt'),names:join(ROOT,'scripts/leak-names.txt'),allow:join(ROOT,'scripts/leak-allow.txt')});
    if (!scan.clean) throw new Error('proof leak scan failed');
    const result=spawnSync('gitleaks',['detect','--source',dir,'--no-git','--no-banner','--redact','--ignore-gitleaks-allow','--config',join(ROOT,'scripts/release-gitleaks.toml'),'--gitleaks-ignore-path',join(ROOT,'scripts/release-gitleaks-ignore.txt')],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}});
    if (result.error || result.status!==0) throw new Error('proof secret scan failed or unavailable');
    writeFileSync(target,markdown);
  } finally { rmSync(dir,{recursive:true,force:true}); }
}
