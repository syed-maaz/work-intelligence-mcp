import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoEnvironment, redactDemoOutput } from "../../scripts/demo-sandbox.mjs";
const dirs = [];
afterEach(() => dirs.splice(0).forEach(p => rmSync(p, {recursive:true,force:true})));
function root() { const p=realpathSync(mkdtempSync(join(tmpdir(),"wi-demo-test-"))); dirs.push(p); return p; }
test("demo drops live credentials, inherited loaders and production paths", () => {
  const p=root();
  const env=createDemoEnvironment(p, {PATH:process.env.PATH, HOME:"/fictional-home", JIRA_MCP_TOKEN:"synthetic", GITHUB_TOKEN:"synthetic", NODE_OPTIONS:"--require unsafe", WI_DEMO_MODE:"0", WI_STAGE1_ENABLED:"1", BROWSER_PROFILE_PATH:"/live-browser", ANTHROPIC_API_KEY:"synthetic-model-key"});
  assert.equal(env.JIRA_MCP_TOKEN,undefined); assert.equal(env.GITHUB_TOKEN,undefined); assert.equal(env.NODE_OPTIONS,undefined);
  assert.equal(env.WI_DEMO_MODE,"1"); assert.equal(env.WI_STAGE1_ENABLED,"0"); assert.equal(env.CYPHER_REFINEMENT_ENABLED,"0");
  assert.ok(env.HOME.startsWith(p)); assert.notEqual(env.BROWSER_PROFILE_PATH,"/live-browser");
  assert.equal(env.ANTHROPIC_API_KEY,"synthetic-model-key");
});
test("live demo profile override is forbidden", () => assert.throws(() => createDemoEnvironment(root(), {WI_DEMO_BROWSER_PROFILE:"/live-browser"}), /profile/i));
test("outside databases and unmarked existing databases are rejected", () => {
  const p=root(); mkdirSync(join(p,"data")); writeFileSync(join(p,"data/demo.db"),"unknown database");
  assert.throws(() => createDemoEnvironment(p, {DATABASE_PATH:join(p,"data/demo.db")}), /unmarked/i);
  assert.throws(() => createDemoEnvironment(p, {DATABASE_PATH:"/fictional-home/.work-intelligence-mcp/data.db"}), /database/i);
});
test("symlinked demo paths cannot escape into production", () => {
  const p=root(), outside=root(); symlinkSync(outside,join(p,"data"));
  assert.throws(() => createDemoEnvironment(p,{DATABASE_PATH:join(p,"data/demo.db")}), /symlink/i);
});
test("a dangling database symlink is rejected before SQLite can create its target", () => {
  const p=root(),outside=root();mkdirSync(join(p,'data'));
  symlinkSync(join(outside,'not-created.db'),join(p,'data/demo.db'));
  assert.throws(() => createDemoEnvironment(p,{DATABASE_PATH:join(p,'data/demo.db')}),/symlink/i);
});
test('child output cannot print the model credential', () => {
  assert.equal(redactDemoOutput('failure: fictional-model-key',{ANTHROPIC_API_KEY:'fictional-model-key'}),'failure: [REDACTED]');
});
