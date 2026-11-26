import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, createDemoEnvironment } from './demo-sandbox.mjs';
if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('setup requires Node 24');
if (!existsSync(join(ROOT,'wi.config.json'))) copyFileSync(join(ROOT,'wi.config.json.example'),join(ROOT,'wi.config.json'));
// Installation/build never inherit connector credentials or production paths.
const env=createDemoEnvironment(ROOT,{PATH:process.env.PATH});
for (const [cwd,args] of [[ROOT,['ci','--userconfig=/dev/null']],[join(ROOT,'web'),['ci','--userconfig=/dev/null']],[ROOT,['run','build']],[ROOT,['run','config:validate']]]) {
  const result=spawnSync('npm',args,{cwd,env,stdio:'inherit'});
  if (result.error || result.status!==0) { console.error('[setup] failed'); process.exit(result.status??1); }
}
const seeded=spawnSync(process.execPath,[join(ROOT,'scripts/seed-demo.mjs')],{cwd:ROOT,env:{PATH:process.env.PATH},stdio:'inherit'});
if (seeded.status!==0) process.exit(seeded.status??1);
console.log('[setup] dependencies, build, config and fictional demo verified. Environment files are unchanged.');
console.log('Next: npm run demo:recall. For a paid model run, supply only the model key in your process environment and run npm run demo:trace.');
