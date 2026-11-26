import Database from 'better-sqlite3';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, expect, it, vi } from 'vitest';
import { initializeDatabase } from '../../src/db/schema.js';
import { runLoop } from '../../src/services/cypher/loop.js';
import { recallMemory } from '../../src/services/brain/recall.js';
import { demoTools } from '../../scripts/demo-tools.mjs';
afterEach(() => vi.unstubAllEnvs());
it('the real loop rejects an invented live tool and can still retrieve fictional evidence', async () => {
  vi.stubEnv('CYPHER_REFINEMENT_ENABLED','0'); vi.stubEnv('WI_STAGE1_ENABLED','0');
  const db = new Database(':memory:'); initializeDatabase(db);
  db.prepare("INSERT INTO topics(name) VALUES ('demo')").run();
  db.prepare("INSERT INTO messages(topic_id,source,content,author) VALUES(1,'teams','fictional widget rollout','alex')").run();
  db.prepare("INSERT INTO cypher_sessions(session_id,goal,user,status) VALUES('cyp_isolation','widget','demo','pending')").run();
  const tools = demoTools(db,recallMemory);
  const responses = [
    {content:[{type:'tool_use',id:'forbidden',name:'wi_send_email',input:{}}],stop_reason:'tool_use'},
    {content:[{type:'tool_use',id:'local',name:'wi_search',input:{query:'widget'}}],stop_reason:'tool_use'},
    {content:[{type:'text',text:'fictional widget rollout'}],stop_reason:'end_turn'},
  ];
  const create = vi.fn(async (_request: {tools: {name:string}[]}) => ({...responses.shift(),usage:{input_tokens:10,output_tokens:10,cache_read_input_tokens:0,cache_creation_input_tokens:0}}));
  try {
    const result = await runLoop({db,palace:null,goal:'widget',user:'demo',session_id:'cyp_isolation',posture:'generic',confirm_mode:'auto',is_interactive:false,
      halt_flag:{halted:false,halt(){}},tools,anthropic_client:{beta:{promptCaching:{messages:{create}}}} as unknown as Anthropic,max_iterations:4});
    expect(result.tool_calls.find(c => c.name === 'wi_send_email')?.ok).toBe(false);
    expect(result.tool_calls.find(c => c.name === 'wi_search')?.ok).toBe(true);
    expect(result.surface).toContain('fictional widget rollout');
    expect(tools.some(t => t.name === 'wi_send_email')).toBe(false);
    expect(create.mock.calls[0][0].tools.map(t => t.name).sort()).toEqual(tools.map(t => t.name).sort());
  } finally { db.close(); }
});
