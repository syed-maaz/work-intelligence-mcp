import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardedDemoClient } from '../../scripts/demo-client.mjs';
test('an ignored whitelist cannot send a broad live-tool catalog to the model',async()=>{
  let calls=0;
  const client=guardedDemoClient([{name:'wi_search'}],{beta:{promptCaching:{messages:{create:async()=>{calls++;return {content:[]};}}}}});
  await assert.rejects(()=>client.beta.promptCaching.messages.create({tools:[{name:'wi_sync'}]}),/unsafe tool/);
  assert.equal(calls,0);
});
test('an unadvertised model tool cannot reach dispatch',async()=>{
  const client=guardedDemoClient([{name:'wi_search'}],{beta:{promptCaching:{messages:{create:async()=>({content:[{type:'tool_use',name:'wi_send_email'}]})}}}});
  await assert.rejects(()=>client.beta.promptCaching.messages.create({tools:[{name:'wi_search'}]}),/unsafe tool/);
});
