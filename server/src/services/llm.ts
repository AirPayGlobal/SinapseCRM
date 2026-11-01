import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

/**
 * Optional phrasing step for Sinapse Assist. Retrieval and the grounding decision are always made
 * locally; the model only rewrites the already-approved passages into a reply and is instructed to
 * add nothing. If no key is configured, or the call fails or is refused, the extractive answer is
 * used unchanged — the agent never depends on the model to be safe.
 */
let client: Anthropic | null = null;
const getClient = () => (config.anthropicApiKey ? (client ??= new Anthropic({ apiKey: config.anthropicApiKey })) : null);

const SYSTEM = `You are Sinapse Assist, the customer service agent of the Namibian Ports Authority (Namport).
Answer the customer's question using ONLY the approved knowledge-base passages provided.
Do not add facts, figures, tariffs, dates, commitments or interpretations of contracts that are not stated in the passages.
If the passages do not answer the question, reply exactly: NO_GROUNDED_ANSWER
Write in plain, courteous English, at most 120 words. Do not mention "passages" or "knowledge base".`;

export async function phraseGroundedAnswer(question: string, passages: { title: string; text: string }[]): Promise<string | null> {
  const c = getClient();
  if (!c) return null;
  try {
    const response = await c.beta.messages.create({
      model: config.assistModel,
      max_tokens: 1024,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `${passages.map((p, i) => `<passage index="${i + 1}" title="${p.title}">\n${p.text}\n</passage>`).join('\n')}\n\nCustomer question: ${question}`,
      }],
    } as any);
    if (response.stop_reason === 'refusal') return null;
    const text = response.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
    if (!text || text.includes('NO_GROUNDED_ANSWER')) return null;
    return text;
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.warn(`assist phrasing unavailable (${err.status}); using extractive answer`);
    else console.warn('assist phrasing failed; using extractive answer');
    return null;
  }
}
