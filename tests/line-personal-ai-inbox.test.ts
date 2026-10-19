import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {
  applyRetention,
  createLineState,
  createSimulatedBackup,
  decryptSimulatedBackup,
  ingestLineMessage,
  maskSensitive,
  projectLineState,
} from '../src/line-inbox.js';

const require = createRequire(import.meta.url);
const {buildSync} = require('esbuild');
const origin = 'https://line.example.test';
let runtime: Miniflare;

before(() => {
  mkdirSync('.audit-tmp/line-personal-ai-inbox', {recursive: true});
  const built = buildSync({
    entryPoints: ['src/worker.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: ['cloudflare:workers', 'node:*'],
  });
  runtime = new Miniflare(convertV4MiniflareOptions({
    name: 'line-personal-ai-inbox',
    modules: true,
    script: built.outputFiles[0].text,
    compatibilityDate: '2026-09-28',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {WORKSPACES: {className: 'BusinessWorkspace', useSQLite: true}},
    bindings: {PUBLIC_DEMO: 'true'},
    resourcePersistencePath: resolve('.audit-tmp/line-personal-ai-inbox/runtime'),
  }));
});
after(async () => {
  await runtime?.dispose();
});

function headerCookie(response: Response, name: string): string {
  const value = response.headers.get('set-cookie') ?? '';
  const match = value.match(new RegExp(`${name}=([^;]+)`));
  assert.ok(match, `缺少 ${name} cookie`);
  return `${name}=${match[1]}`;
}

class LineVisitor {
  cookie = '';
  csrf = '';
  version = 0;

  async request(path: string, options: RequestInit = {}) {
    const response = await runtime.dispatchFetch(origin + path, {
      ...options,
      headers: {Cookie: this.cookie, ...Object.fromEntries(new Headers(options.headers as any).entries())} as any,
    } as any) as unknown as Response;
    const workspaceCookie = response.headers.get('set-cookie')?.match(/line_workspace=([^;]+)/)?.[1];
    const sessionCookie = response.headers.get('set-cookie')?.match(/line_session=([^;]+)/)?.[1];
    const cookies = [workspaceCookie && `line_workspace=${workspaceCookie}`, sessionCookie && `line_session=${sessionCookie}`].filter(Boolean);
    if (cookies.length) this.cookie = cookies.join('; ');
    const body: any = await response.json();
    if (body.csrf) this.csrf = body.csrf;
    if (typeof body.version === 'number') this.version = body.version;
    return {response, body};
  }

  bootstrapView() { return this.request('/api/line-auth/bootstrap'); }

  post(path: string, body: unknown, key = randomUUID(), version = this.version, extra: Record<string, string> = {}) {
    return this.request(path, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        'x-csrf-token': this.csrf,
        'Idempotency-Key': key,
        'If-Match-Version': String(version),
        ...extra,
      },
      body: JSON.stringify(body),
    });
  }

  async bootstrap() {
    await this.bootstrapView();
    return this.post('/api/line-auth/bootstrap', {
      email: 'fish@example.test',
      password: 'fish-demo-password',
      display_name: 'Fish',
    });
  }

  async login(email = 'fish@example.test', password = 'fish-demo-password') {
    await this.bootstrapView();
    return this.post('/api/line-auth/login', {email, password});
  }
}

test('來源投影保留三種來源並以穩定 fingerprint 去重', () => {
  // 後端 Gherkin：保存三種對話來源並保留來源類型；沒有穩定來源訊息 id 時仍避免重複。
  const state = createLineState(1);
  const inputs = [
    {accountScope: 'fish', conversationId: 'private-1', conversationType: 'private' as const, receivedAt: 1, rawText: '電話 0912-345-678', sourceMessageId: 'p-1'},
    {accountScope: 'fish', conversationId: 'group-1', conversationType: 'group' as const, receivedAt: 2, rawText: '群組提醒', sourceMessageId: 'g-1'},
    {accountScope: 'fish', conversationId: 'openchat-1', conversationType: 'openchat' as const, receivedAt: 3, rawText: '社群貼文', sourceMessageId: 'o-1'},
    {accountScope: 'fish', conversationId: 'group-2', conversationType: 'group' as const, receivedAt: 4, rawText: '沒有穩定 id', sourceMessageId: null},
  ];
  for (const input of inputs) ingestLineMessage(state, input);
  const duplicate = ingestLineMessage(state, inputs[3]);
  assert.equal(duplicate.created, false);
  assert.equal(state.inbox.length, 4);
  assert.deepEqual(new Set(state.inbox.map(item => item.conversationType)), new Set(['private', 'group', 'openchat']));
  assert.match(state.inbox.at(-1)!.deduplicationKey, /^[a-f0-9]{64}$/);
});

test('遮罩 projection 不把電話地址帶進 AI 或家人回應', () => {
  // 後端 Gherkin：敏感資料在送外部 AI 前先遮罩；家人帳號不得讀取原始訊息。
  const raw = '請打 0912-345-678，寄到台北市信義路一段 1 號。';
  const masked = maskSensitive(raw, ['0912-345-678', '台北市信義路一段 1 號']);
  assert.equal(masked.includes('0912-345-678'), false);
  assert.equal(masked.includes('台北市信義路一段 1 號'), false);
  const state = createLineState(1);
  ingestLineMessage(state, {accountScope: 'fish', conversationId: 'p', conversationType: 'private', receivedAt: 1, rawText: raw, sourceMessageId: 'p-1'});
  const family = JSON.stringify(projectLineState(state, 'family'));
  assert.equal(family.includes('raw_text'), false);
  assert.equal(family.includes('rawText'), false);
  assert.equal(family.includes('0912-345-678'), false);
});

test('重要訊息低信心進 review queue，Fish projection 可見待辦與草稿', () => {
  const state = createLineState(1);
  const result = ingestLineMessage(state, {accountScope: 'fish', conversationId: 'p', conversationType: 'private', receivedAt: 1, rawText: '請明天前回覆', sourceMessageId: 'p-1', confidence: 0.42});
  assert.equal(result.created, true);
  assert.equal(state.inbox[0].quadrant, null);
  assert.equal(state.inbox[0].reviewQueue, true);
  assert.equal(projectLineState(state, 'fish').reviewQueue.length, 1);
});

test('保存期限清理未保留原文，但重要 hold 留在 local boundary', () => {
  const state = createLineState(1);
  ingestLineMessage(state, {accountScope: 'fish', conversationId: 'remove', conversationType: 'private', receivedAt: 1, rawText: 'old remove', sourceMessageId: 'old-1'});
  ingestLineMessage(state, {accountScope: 'fish', conversationId: 'hold', conversationType: 'private', receivedAt: 1, rawText: 'old hold', sourceMessageId: 'old-2', importantHold: true});
  const result = applyRetention(state, 91 * 24 * 60 * 60 * 1000);
  assert.equal(result.removed, 1);
  assert.equal(state.rawMessages['old-1'], undefined);
  assert.equal(state.rawMessages['old-2']?.rawText, 'old hold');
  assert.equal(state.inbox.length, 2);
});

test('模擬備份先加密，錯誤復原金鑰 fail closed', async () => {
  const state = createLineState(1);
  ingestLineMessage(state, {accountScope: 'fish', conversationId: 'p', conversationType: 'private', receivedAt: 1, rawText: 'private raw', sourceMessageId: 'p-1'});
  const backup = await createSimulatedBackup(state, 'test-recovery-key', 2);
  assert.equal(backup.scope, 'dedicated-line-backup');
  assert.equal(JSON.stringify(backup).includes('private raw'), false);
  await assert.rejects(() => decryptSimulatedBackup(backup, 'wrong-key'));
  const restored = await decryptSimulatedBackup(backup, 'test-recovery-key');
  assert.equal(restored.inbox.length, 1);
});

test('LINE API bootstrap、Fish dashboard 與 family RBAC 不洩漏原文', async () => {
  // 前端 Gherkin：首頁同時顯示待處理收件匣與四象限摘要；家人只能看到摘要與已核准待辦。
  const fish = new LineVisitor();
  const boot = await fish.bootstrap();
  assert.equal(boot.response.status, 200, JSON.stringify(boot.body));
  const login = await fish.login();
  assert.equal(login.response.status, 200, JSON.stringify(login.body));
  const inbox = await fish.request('/api/line-inbox');
  assert.equal(inbox.response.status, 200, JSON.stringify(inbox.body));
  assert.equal(new Set(inbox.body.items.map((item: any) => item.conversationType)).size, 3);
  assert.equal(JSON.stringify(inbox.body).includes('raw_text'), false);
  assert.equal(JSON.stringify(inbox.body).includes('rawText'), false);
  assert.equal(inbox.body.summary.important_urgent >= 1, true);
  const family = new LineVisitor();
  family.cookie = headerCookie(boot.response, 'line_workspace');
  const familyLogin = await family.login('family@example.test', 'family-demo-password');
  assert.equal(familyLogin.response.status, 200, JSON.stringify(familyLogin.body));
  const familyInbox = await family.request('/api/line-inbox');
  assert.equal(familyInbox.response.status, 200, JSON.stringify(familyInbox.body));
  assert.equal(familyInbox.body.role, 'family');
  assert.equal(familyInbox.body.drafts, undefined);
  const denied = await family.post('/api/line-inbox/task-candidates/candidate-urgent/approve', {});
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, 'forbidden');
});

test('LINE API CSRF、冪等、離線送出閘門與 OpenChat capability gate', async () => {
  // 後端 Gherkin：同步中斷時保留狀態並在恢復後補同步；OpenChat 草稿在驗證前不得送出。
  const fish = new LineVisitor();
  await fish.bootstrap();
  await fish.login();
  const csrfFailure = await fish.post('/api/line-inbox/sync/control', {state: 'offline'}, randomUUID(), fish.version, {'x-csrf-token': 'bad'});
  assert.equal(csrfFailure.response.status, 403);
  assert.equal(csrfFailure.body.error.code, 'csrf_failed');
  const offline = await fish.post('/api/line-inbox/sync/control', {state: 'offline'});
  assert.equal(offline.response.status, 200, JSON.stringify(offline.body));
  const send = await fish.post('/api/line-inbox/replies/draft-private/send', {confirmed: true});
  assert.equal(send.response.status, 409);
  assert.equal(send.body.error.code, 'sync_offline');
  const online = await fish.post('/api/line-inbox/sync/control', {state: 'online'});
  assert.equal(online.response.status, 200, JSON.stringify(online.body));
  const openchat = await fish.post('/api/line-inbox/replies/draft-openchat/send', {confirmed: true});
  assert.equal(openchat.response.status, 409);
  assert.equal(openchat.body.error.code, 'capability_disabled');
  const key = randomUUID();
  const first = await fish.post('/api/line-inbox/task-candidates/candidate-urgent/approve', {}, key, fish.version);
  assert.equal(first.response.status, 200, JSON.stringify(first.body));
  const replay = await fish.post('/api/line-inbox/task-candidates/candidate-urgent/approve', {}, key, fish.version);
  assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.replayed, true);
});
