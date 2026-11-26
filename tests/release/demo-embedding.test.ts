import { afterEach, expect, it, vi } from 'vitest';
import { embed, EMBEDDING_DIM, checkOllamaAvailable, EmbeddingService, embedPromptMemory, embedDocs } from '../../src/services/embedder.js';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('demo embeddings use fictional hash vectors without contacting an existing Ollama server', async () => {
  vi.stubEnv('WI_DEMO_MODE', '1'); vi.stubEnv('WI_EMBED_STUB', '1');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect((await embed('fictional widget rollout'))?.length).toBe(EMBEDDING_DIM);
  expect(fetch).not.toHaveBeenCalled();
});
it('a demo without hash embeddings skips rather than calling a model server', async () => {
  vi.stubEnv('WI_DEMO_MODE', '1'); vi.stubEnv('WI_EMBED_STUB', '0');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await embed('fictional widget rollout')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it('demo availability, prompt-memory and document indexing never contact Ollama', async () => {
  vi.stubEnv('WI_DEMO_MODE', '1');
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await checkOllamaAvailable()).toBe(false);
  expect(await new EmbeddingService(null as never).checkEnabled()).toBe(false);
  expect(await embedPromptMemory(null as never)).toEqual({ indexed: 0, skipped: 0 });
  expect(await embedDocs(null as never, '/fictional-documents')).toEqual({ indexed: 0, skipped: 0, unchanged: 0 });
  expect(fetch).not.toHaveBeenCalled();
});
