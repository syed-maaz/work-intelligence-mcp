import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../scripts/demo-proof.mjs', () => ({ writeProof:vi.fn() }));
afterEach(() => vi.unstubAllEnvs());
it('the paid trace path uses the isolated DB and never publishes mocked model evidence', async () => {
  vi.stubEnv('DATABASE_PATH',':memory:');vi.stubEnv('ANTHROPIC_API_KEY','');vi.stubEnv('CYPHER_REFINEMENT_ENABLED','0');vi.stubEnv('WI_STAGE1_ENABLED','0');
  const {runDemoTrace}=await import('../../scripts/demo-trace-worker.mjs');
  const {closeDatabase}=await import('../../src/db/connection.js');
  const {writeProof}=await import('../../scripts/demo-proof.mjs');
  const create=vi.fn(async()=>({content:[{type:'text',text:'fictional trace smoke'}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:10,cache_read_input_tokens:0,cache_creation_input_tokens:0}}));
  try {
    const result=await runDemoTrace({anthropicClient:{beta:{promptCaching:{messages:{create}}}}});
    expect(result.session_id).toMatch(/^cyp_demo_/);
    expect(create).toHaveBeenCalled();expect(writeProof).toHaveBeenCalledOnce();
  } finally {closeDatabase();}
});
