// Deterministic n8n deployer — daily 10 English B1 phrases with translation, example, spoiler, and revision.
// Mirrors deploy-weather.mjs conventions exactly (api(), ensureTelegramCred, PUT+activate, state keys).
// Telegram parse_mode: HTML  (avoids MarkdownV2 escaping complexity).
// Spaced-repetition via Google Sheets is a next_step; this version uses AI-generated revision section.
// Usage: node deploy-english-phrases.mjs   (default = daily 09:00 prod)
import fs from 'node:fs';

const here = (p) => new URL(p, import.meta.url);
const env = Object.fromEntries(
  fs.readFileSync(here('./.env'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const state = JSON.parse(fs.readFileSync(here('./.deploy-state.json'), 'utf8') || '{}');
const saveState = () => fs.writeFileSync(here('./.deploy-state.json'), JSON.stringify(state, null, 2) + '\n');

const API = new URL(env.N8N_URL).origin + '/api/v1';
const TZ = 'Europe/Warsaw';
const SEND_HOUR = 9;

async function api(method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { 'X-N8N-API-KEY': env.N8N_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let j; try { j = t ? JSON.parse(t) : {}; } catch { j = { _raw: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(j).slice(0, 240)}`);
  return j;
}

// Reuse the shared Telegram credential (created by deploy-weather.mjs or created fresh here).
async function ensureTelegramCred() {
  if (state.credId) { console.log('reuse telegram cred:', state.credId); return state.credId; }
  const c = await api('POST', '/credentials', {
    name: 'Telegram Bot', type: 'telegramApi', data: { accessToken: env.TELEGRAM_BOT_TOKEN },
  });
  state.credId = c.id; saveState();
  console.log('created telegram cred:', c.id);
  return c.id;
}

// The AI prompt. Returns Telegram-ready HTML so no Code node is needed.
// HTML mode: only <b>, <i>, <tg-spoiler> needed. Escape only &, <, > in text.
const PROMPT = `Generate EXACTLY 10 English phrases or idioms at B1 level (intermediate) for a Ukrainian learner.

Output a Telegram HTML message (parse_mode HTML). Use ONLY these tags: <b>, <i>, <tg-spoiler>.

START with this header (exactly):
📚 <b>Англійські фрази — рівень B1</b>

Then list 10 phrases. Put a blank line between each phrase block:

<b>N. English phrase or idiom</b> — Ukrainian translation
💬 <i>A full example sentence in English using the phrase naturally.</i>
🔤 <tg-spoiler>Ukrainian translation of the example sentence.</tg-spoiler>

After phrase 10, add one blank line then this revision section:
🔁 <b>Повторення:</b>
List 3 classic B1 phrases that learners often forget. One per line, no spoiler needed:
• <b>phrase</b> — Ukrainian translation (short example sentence)

Constraints:
- Mix phrase types: phrasal verbs, collocations, idioms, fixed expressions
- Each phrase must be different and genuinely B1 level
- In the HTML text, replace & with &amp;, replace < with &lt;, replace > with &gt;
- Do NOT wrap the response in a code block or add any explanation
- Return ONLY the message text`;

function buildWorkflow(credId, openaiCredId) {
  return {
    name: 'Daily English B1 Phrases',
    nodes: [
      // 1. Schedule trigger — fires once daily at SEND_HOUR
      {
        id: 'trigger',
        name: 'Trigger',
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [0, 0],
        parameters: { rule: { interval: [{ triggerAtHour: SEND_HOUR }] } },
      },
      // 2. LangChain LLM chain — generates the full Telegram message
      {
        id: 'gen',
        name: 'Generate',
        type: '@n8n/n8n-nodes-langchain.chainLlm',
        typeVersion: 1.9,
        position: [220, 0],
        parameters: {
          promptType: 'define',
          text: PROMPT,
          batching: {},
        },
        retryOnFail: true,
        maxTries: 3,
        waitBetweenTries: 5000,
        onError: 'continueRegularOutput',
      },
      // 3. OpenAI model sub-node (feeds chain via ai_languageModel connection)
      {
        id: 'model',
        name: 'OpenAI Chat Model',
        type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
        typeVersion: 1.3,
        position: [220, 180],
        parameters: {
          model: { __rl: true, mode: 'list', value: 'gpt-4.1-mini', cachedResultName: 'gpt-4.1-mini' },
          options: {},
        },
        credentials: {
          openAiApi: { id: openaiCredId, name: 'OpenAi account' },
        },
      },
      // 4. Telegram send — HTML mode for <b>, <i>, <tg-spoiler> support
      {
        id: 'send',
        name: 'Send',
        type: 'n8n-nodes-base.telegram',
        typeVersion: 1.2,
        position: [440, 0],
        parameters: {
          chatId: env.TELEGRAM_CHAT_ID,
          text: '={{ $json.text }}',
          additionalFields: {
            appendAttribution: false,
            parse_mode: 'HTML',
          },
        },
        credentials: {
          telegramApi: { id: credId, name: 'Telegram Bot' },
        },
        onError: 'continueRegularOutput',
      },
    ],
    connections: {
      // Schedule → LLM chain
      Trigger: { main: [[{ node: 'Generate', type: 'main', index: 0 }]] },
      // Model → chain (sub-node link)
      'OpenAI Chat Model': { ai_languageModel: [[{ node: 'Generate', type: 'ai_languageModel', index: 0 }]] },
      // Chain output ($json.text) → Telegram
      Generate: { main: [[{ node: 'Send', type: 'main', index: 0 }]] },
    },
    settings: {
      executionOrder: 'v1',
      timezone: TZ,
      saveDataSuccessExecution: 'all',
      saveDataErrorExecution: 'all',
      saveManualExecutions: true,
    },
  };
}

// Guard: OpenAI credential must already exist (registered by deploy-weather.mjs or manually).
if (!state.openaiCredId) {
  throw new Error('state.openaiCredId not set in .deploy-state.json. Run deploy-weather.mjs first, or add it manually.');
}

const credId = await ensureTelegramCred();
const wf = buildWorkflow(credId, state.openaiCredId);

// Idempotent: reuse stored workflow ID if it exists.
let id = state.phrasesWorkflowId;
if (id) {
  await api('PUT', '/workflows/' + id, wf);
  console.log('updated workflow:', id);
} else {
  const created = await api('POST', '/workflows', wf);
  id = created.id;
  state.phrasesWorkflowId = id;
  saveState();
  console.log('created workflow:', id);
}

// PUT always resets active=false → re-activate (JSON content-type required, even on empty body).
await api('POST', `/workflows/${id}/activate`, {});
const back = await api('GET', '/workflows/' + id);
const origin = new URL(env.N8N_URL).origin;
console.log('ACTIVE:', back.active, '| nodes:', (back.nodes || []).length);
console.log('SCHEDULE: daily ' + String(SEND_HOUR).padStart(2, '0') + ':00 ' + TZ);
console.log('UI: ' + origin + '/workflow/' + id);
