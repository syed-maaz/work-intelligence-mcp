import Anthropic from '@anthropic-ai/sdk';
/** Enforce the demo surface at the model boundary as well as dispatch. */
export function guardedDemoClient(tools, injected) {
  const allowed=new Set(tools.map(tool=>tool.name));
  const key=process.env.ANTHROPIC_API_KEY;
  const baseURL=process.env.ANTHROPIC_BASE_URL;
  if (!injected&&!key) throw new Error('demo model key is required');
  const client=injected??new Anthropic({apiKey:baseURL?'x-proxy':key,
    ...(baseURL?{baseURL,defaultHeaders:{Authorization:'Bearer '+key}}:{})});
  return {beta:{promptCaching:{messages:{create:async(request,...args)=>{
    if (!Array.isArray(request.tools) || request.tools.some(tool=>!allowed.has(tool.name))) throw new Error('demo model request contains an unsafe tool');
    const response=await client.beta.promptCaching.messages.create(request,...args);
    if (response.content.some(block=>block.type==='tool_use'&&!allowed.has(block.name))) throw new Error('demo model response contains an unsafe tool');
    return response;
  }}}}};
}
