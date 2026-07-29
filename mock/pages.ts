export const scenarioNames = [
  "normal",
  "queue",
  "sold-out",
  "captcha",
  "login-expired",
  "price-limit",
  "page-changed"
] as const;

export type MockScenario = (typeof scenarioNames)[number];

export function isMockScenario(value: string): value is MockScenario {
  return (scenarioNames as readonly string[]).includes(value);
}

const scenarioCopy: Record<MockScenario, { eyebrow: string; title: string; note: string }> = {
  normal: {
    eyebrow: "正常开售",
    title: "山海之间 · 夏日现场",
    note: "标准可购买流程，默认选中最低价票档和 1 张票。"
  },
  queue: {
    eyebrow: "官方排队",
    title: "正在进入购票通道",
    note: "执行器应保持单页面等待，不刷新、不并发创建队列。"
  },
  "sold-out": {
    eyebrow: "已售罄",
    title: "本场次暂时无票",
    note: "所有票档均不可选择，执行器应进入 SOLD_OUT。"
  },
  captcha: {
    eyebrow: "需要人工验证",
    title: "请完成安全验证",
    note: "仿真页不会自动处理验证码，执行器应停止并请求人工接管。"
  },
  "login-expired": {
    eyebrow: "登录失效",
    title: "登录状态已过期",
    note: "执行器应停止购票并提醒用户在专用浏览器中重新登录。"
  },
  "price-limit": {
    eyebrow: "价格超限",
    title: "仅剩高价票档",
    note: "页面最低总价为 ¥1,280，测试计划的模拟上限为 ¥500。"
  },
  "page-changed": {
    eyebrow: "页面改版",
    title: "全新购票工作台",
    note: "关键选择器已被刻意移除，执行器应进入 PAGE_CHANGED，而不是猜测点击。"
  }
};

const sharedStyles = String.raw`
  :root {
    color-scheme: light;
    --ink: #201c18;
    --muted: #756d64;
    --paper: #f6f0e5;
    --paper-deep: #e7dcc9;
    --signal: #cf2e2e;
    --signal-dark: #8e1717;
    --line: rgba(32, 28, 24, 0.2);
    --ok: #1d6948;
    font-family: "Avenir Next", "PingFang SC", sans-serif;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    min-height: 100vh;
    color: var(--ink);
    background:
      linear-gradient(rgba(32, 28, 24, 0.035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(32, 28, 24, 0.035) 1px, transparent 1px),
      var(--paper);
    background-size: 22px 22px;
  }

  body::before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    opacity: 0.28;
    background: radial-gradient(circle at 82% 12%, #fff 0, transparent 34%);
  }

  button, select, input { font: inherit; }

  .shell {
    width: min(1040px, calc(100% - 32px));
    margin: 0 auto;
    padding: 28px 0 56px;
    position: relative;
  }

  .masthead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--ink);
  }

  .brand {
    display: flex;
    align-items: baseline;
    gap: 12px;
    font-family: "Songti SC", "STSong", serif;
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.05em;
  }

  .brand small {
    color: var(--muted);
    font: 600 10px/1 "Avenir Next", sans-serif;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .local-badge {
    padding: 7px 10px;
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.45);
    font-size: 12px;
  }

  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 260px;
    gap: 42px;
    padding: 52px 0 38px;
  }

  .eyebrow {
    margin: 0 0 12px;
    color: var(--signal);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.18em;
  }

  h1 {
    max-width: 720px;
    margin: 0;
    font: 800 clamp(42px, 7vw, 78px)/0.98 "Songti SC", "STSong", serif;
    letter-spacing: -0.055em;
  }

  .scenario-note {
    align-self: end;
    margin: 0;
    padding-left: 18px;
    border-left: 3px solid var(--signal);
    color: var(--muted);
    font-size: 14px;
    line-height: 1.7;
  }

  .status-strip {
    display: flex;
    gap: 20px;
    padding: 13px 16px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.5);
    font-size: 12px;
  }

  .status-strip span::before {
    content: "";
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 7px;
    border-radius: 50%;
    background: var(--ok);
  }

  .status-strip [data-status="expired"]::before,
  .status-strip [data-status="sold-out"]::before { background: var(--signal); }

  .ticket-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.4fr) minmax(300px, 0.6fr);
    gap: 22px;
    margin-top: 22px;
  }

  .panel {
    position: relative;
    padding: 26px;
    border: 1px solid var(--line);
    background: rgba(255, 253, 248, 0.82);
    box-shadow: 0 18px 50px rgba(70, 53, 34, 0.07);
  }

  .panel h2 {
    margin: 0 0 18px;
    font: 800 19px/1.2 "Songti SC", "STSong", serif;
  }

  .field + .field { margin-top: 26px; }

  .field-label {
    display: flex;
    justify-content: space-between;
    margin-bottom: 10px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
  }

  .options { display: grid; gap: 9px; }

  .option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 18px;
    width: 100%;
    padding: 14px 15px;
    border: 1px solid var(--line);
    background: #fffdf8;
    color: var(--ink);
    text-align: left;
    cursor: pointer;
    transition: border-color 160ms ease, transform 160ms ease, background 160ms ease;
  }

  .option:hover:not(:disabled) { transform: translateX(3px); border-color: var(--ink); }
  .option[aria-pressed="true"] { border-color: var(--signal); background: #fff1ed; }
  .option:disabled { color: #9b938a; cursor: not-allowed; text-decoration: line-through; }
  .option strong { color: var(--signal-dark); font-variant-numeric: tabular-nums; }

  .quantity {
    width: 100%;
    padding: 12px;
    border: 1px solid var(--line);
    border-radius: 0;
    background: #fffdf8;
  }

  .attendee {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 12px 0;
    border-top: 1px dotted var(--line);
  }

  .summary { position: sticky; top: 20px; }

  .summary-line {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    padding: 11px 0;
    border-bottom: 1px dotted var(--line);
    color: var(--muted);
    font-size: 13px;
  }

  .summary-line strong { color: var(--ink); text-align: right; }

  .total {
    display: flex;
    align-items: end;
    justify-content: space-between;
    margin: 28px 0 18px;
  }

  .total strong {
    color: var(--signal);
    font: 800 34px/1 "Avenir Next", sans-serif;
    letter-spacing: -0.06em;
  }

  .primary {
    width: 100%;
    padding: 15px 18px;
    border: 1px solid var(--signal-dark);
    background: var(--signal);
    color: white;
    font-weight: 800;
    cursor: pointer;
    transition: background 160ms ease;
  }

  .primary:hover:not(:disabled) { background: var(--signal-dark); }
  .primary:disabled { border-color: #a7a099; background: #bcb6af; cursor: not-allowed; }

  .fine-print { margin: 14px 0 0; color: var(--muted); font-size: 11px; line-height: 1.6; }

  .state-card {
    min-height: 360px;
    display: grid;
    place-items: center;
    margin-top: 22px;
    padding: 54px 28px;
    border: 1px solid var(--line);
    background: rgba(255, 253, 248, 0.88);
    text-align: center;
  }

  .state-card > div { max-width: 540px; }
  .state-card h2 { margin: 18px 0 10px; font: 800 36px/1.1 "Songti SC", "STSong", serif; }
  .state-card p { color: var(--muted); line-height: 1.7; }

  .queue-mark {
    width: 92px;
    height: 92px;
    margin: 0 auto;
    border: 3px solid var(--paper-deep);
    border-top-color: var(--signal);
    border-radius: 50%;
    animation: orbit 1.35s linear infinite;
  }

  .warning-mark {
    display: grid;
    place-items: center;
    width: 74px;
    height: 74px;
    margin: 0 auto;
    border: 2px solid var(--signal);
    border-radius: 50%;
    color: var(--signal);
    font: 800 34px/1 serif;
  }

  .secondary {
    display: inline-block;
    margin-top: 12px;
    padding: 11px 18px;
    border: 1px solid var(--ink);
    background: transparent;
    color: var(--ink);
    cursor: pointer;
    text-decoration: none;
  }

  .modal-backdrop {
    position: fixed;
    z-index: 10;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgba(22, 18, 15, 0.74);
  }

  .modal {
    width: min(460px, 100%);
    padding: 34px;
    border-top: 5px solid var(--signal);
    background: var(--paper);
    box-shadow: 0 28px 90px rgba(0, 0, 0, 0.38);
  }

  .modal h2 { margin: 0 0 12px; font: 800 30px/1.1 "Songti SC", "STSong", serif; }
  .modal p { color: var(--muted); line-height: 1.7; }

  .price-warning {
    margin: 16px 0;
    padding: 12px;
    border-left: 3px solid var(--signal);
    background: #fff0ec;
    color: var(--signal-dark);
    font-size: 12px;
    line-height: 1.6;
  }

  .order-result {
    margin-top: 14px;
    padding: 12px;
    border: 1px solid var(--ok);
    color: var(--ok);
    font-size: 12px;
  }

  .revamp {
    min-height: 420px;
    margin-top: 22px;
    padding: 38px;
    color: #e7ff70;
    background: #171717;
    overflow: hidden;
  }

  .revamp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 48px; }
  .revamp-tile { min-height: 130px; padding: 20px; border: 1px solid #e7ff70; }
  .revamp h2 { margin: 0; font: 800 clamp(42px, 8vw, 86px)/0.9 "Courier New", monospace; letter-spacing: -0.08em; }

  @keyframes orbit { to { transform: rotate(360deg); } }

  @media (max-width: 760px) {
    .hero, .ticket-layout { grid-template-columns: 1fr; }
    .hero { gap: 22px; padding: 38px 0 28px; }
    .scenario-note { align-self: auto; }
    .summary { position: static; }
    .status-strip { flex-direction: column; gap: 7px; }
    .revamp-grid { grid-template-columns: 1fr; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
  }
`;

function documentShell(scenario: MockScenario, content: string, extra = ""): string {
  const copy = scenarioCopy[scenario];
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${copy.eyebrow} · 大麦仿真站</title>
  <style>${sharedStyles}</style>
</head>
<body>
  <main class="shell" data-platform="damai" data-scenario="${scenario}">
    <header class="masthead">
      <div class="brand">大麦仿真站 <small>local fixture</small></div>
      <span class="local-badge">仅限 127.0.0.1 · 不连接真实平台</span>
    </header>
    <section class="hero" data-event-id="MOCK-DAMAI-001">
      <div>
        <p class="eyebrow">${copy.eyebrow}</p>
        <h1 data-testid="event-title" data-event-title="${copy.title}">${copy.title}</h1>
      </div>
      <p class="scenario-note">${copy.note}</p>
    </section>
    ${content}
  </main>
  ${extra}
</body>
</html>`;
}

function statusStrip(saleStatus: "on-sale" | "sold-out", loginStatus: "authenticated" | "expired" = "authenticated"): string {
  return `<div class="status-strip" aria-label="页面状态">
    <span data-testid="login-status" data-status="${loginStatus}">登录：${loginStatus === "authenticated" ? "有效" : "已失效"}</span>
    <span data-testid="sale-status" data-status="${saleStatus}">销售：${saleStatus === "on-sale" ? "已开售" : "已售罄"}</span>
    <span>活动 ID：MOCK-DAMAI-001</span>
  </div>`;
}

function purchasePanel(scenario: "normal" | "price-limit" | "captcha"): string {
  const highPrice = scenario === "price-limit";
  const prices = highPrice
    ? [{ id: "vip", label: "VIP 看台", fen: 128_000 }]
    : [
        { id: "upper", label: "高层看台", fen: 38_000 },
        { id: "lower", label: "下层看台", fen: 68_000 },
        { id: "floor", label: "内场", fen: 98_000 }
      ];
  const tierButtons = prices
    .map(
      (price, index) => `<button class="option" type="button" data-testid="tier-option" data-tier-id="${price.id}" data-tier-label="${price.label}" data-price-fen="${price.fen}" aria-pressed="${index === 0 ? "true" : "false"}">
          <span>${price.label}${index === 0 ? " · 当前最低" : ""}</span><strong>¥${(price.fen / 100).toFixed(0)}</strong>
        </button>`
    )
    .join("");

  return `${statusStrip("on-sale")}
  <div class="ticket-layout">
    <section class="panel" aria-label="票务选择">
      <div class="field">
        <div class="field-label"><span>01 / 选择场次</span><span>按偏好排序</span></div>
        <div class="options">
          <button class="option" type="button" data-testid="session-option" data-session-id="evening" data-session-label="8月18日 周二 19:30" aria-pressed="true">
            <span>8月18日 周二 19:30</span><strong>可售</strong>
          </button>
          <button class="option" type="button" data-testid="session-option" data-session-id="matinee" data-session-label="8月19日 周三 14:30" aria-pressed="false" disabled aria-disabled="true">
            <span>8月19日 周三 14:30</span><strong>不可选</strong>
          </button>
        </div>
      </div>
      <div class="field">
        <div class="field-label"><span>02 / 选择票档</span><span>${highPrice ? "仅剩 1 档" : "价格从低到高"}</span></div>
        <div class="options">${tierButtons}</div>
      </div>
      <div class="field">
        <div class="field-label"><span>03 / 数量</span><span>默认 1 张</span></div>
        <select class="quantity" data-testid="quantity" data-role="ticket-quantity" aria-label="购票数量">
          <option value="1" selected>1 张</option>
          <option value="2">2 张</option>
          <option value="3">3 张</option>
        </select>
      </div>
      <div class="field">
        <div class="field-label"><span>04 / 观演人</span><span>本地测试别名</span></div>
        <label class="attendee"><input type="checkbox" data-testid="attendee-option" data-attendee-alias="本人"> 本人（仿真）</label>
      </div>
    </section>
    <aside class="panel summary" aria-label="订单摘要">
      <h2>订单核对</h2>
      <div class="summary-line"><span>活动</span><strong>山海之间 · 夏日现场</strong></div>
      <div class="summary-line"><span>场次</span><strong data-testid="selected-session">8月18日 周二 19:30</strong></div>
      <div class="summary-line"><span>票档</span><strong data-testid="selected-tier">${prices[0]?.label ?? ""}</strong></div>
      <div class="summary-line"><span>数量</span><strong data-testid="selected-quantity">1 张</strong></div>
      ${highPrice ? `<div class="price-warning" data-testid="price-warning" data-policy-limit-fen="50000">模拟计划上限 ¥500.00；此订单必须被价格策略拦截。</div>` : ""}
      <div class="total"><span>合计</span><strong data-testid="order-total" data-total-fen="${prices[0]?.fen ?? 0}" data-order-total-fen="${prices[0]?.fen ?? 0}">¥${((prices[0]?.fen ?? 0) / 100).toFixed(2)}</strong></div>
      <button class="primary" type="button" data-testid="submit-order"${highPrice ? " disabled aria-disabled=\"true\"" : ""}>${highPrice ? "超过模拟预算" : "提交订单"}</button>
      <p class="fine-print">仿真按钮不会创建真实订单或发起支付。支付和账户确认始终需要人工处理。</p>
      <div class="order-result" data-testid="order-result" hidden></div>
    </aside>
  </div>
  <script>
    (() => {
      const sessions = [...document.querySelectorAll('[data-testid="session-option"]')];
      const tiers = [...document.querySelectorAll('[data-testid="tier-option"]')];
      const quantity = document.querySelector('[data-testid="quantity"]');
      const total = document.querySelector('[data-testid="order-total"]');
      const selectedSession = document.querySelector('[data-testid="selected-session"]');
      const selectedTier = document.querySelector('[data-testid="selected-tier"]');
      const selectedQuantity = document.querySelector('[data-testid="selected-quantity"]');

      function selectOne(items, selected) {
        items.forEach((item) => item.setAttribute('aria-pressed', String(item === selected)));
      }

      function renderTotal() {
        const active = tiers.find((item) => item.getAttribute('aria-pressed') === 'true');
        const amount = Number(active?.dataset.priceFen || 0) * Number(quantity?.value || 1);
        if (total) {
          total.dataset.totalFen = String(amount);
          total.dataset.orderTotalFen = String(amount);
          total.textContent = '¥' + (amount / 100).toFixed(2);
        }
        if (selectedTier) selectedTier.textContent = active?.dataset.tierLabel || '';
        if (selectedQuantity) selectedQuantity.textContent = (quantity?.value || '1') + ' 张';
      }

      sessions.forEach((item) => item.addEventListener('click', () => {
        selectOne(sessions, item);
        if (selectedSession) selectedSession.textContent = item.dataset.sessionLabel || '';
      }));
      tiers.forEach((item) => item.addEventListener('click', () => { selectOne(tiers, item); renderTotal(); }));
      quantity?.addEventListener('change', renderTotal);
      document.querySelector('[data-testid="submit-order"]')?.addEventListener('click', () => {
        const result = document.querySelector('[data-testid="order-result"]');
        if (!result) return;
        result.hidden = false;
        result.dataset.state = 'PAY_REQUIRED';
        result.dataset.orderReference = 'MOCK-ORDER-001';
        result.textContent = '仿真订单已提交 · PAY_REQUIRED · MOCK-ORDER-001';
      });
    })();
  </script>`;
}

function normalPage(scenario: "normal" | "price-limit" | "captcha"): string {
  const captchaModal = scenario === "captcha"
    ? `<div class="modal-backdrop" data-testid="captcha" data-state="CAPTCHA_REQUIRED" role="dialog" aria-modal="true" aria-labelledby="captcha-title">
        <section class="modal">
          <p class="eyebrow">HUMAN TAKEOVER</p>
          <h2 id="captcha-title">请完成安全验证</h2>
          <p>这是静态仿真提示，不包含验证码求解功能。自动执行器必须在此停止，并通知用户接管浏览器。</p>
          <button class="primary" type="button" disabled aria-disabled="true">等待人工处理</button>
        </section>
      </div>`
    : "";
  return documentShell(scenario, purchasePanel(scenario), captchaModal);
}

function queuePage(): string {
  return documentShell(
    "queue",
    `${statusStrip("on-sale")}
    <section class="state-card" data-testid="official-queue" data-state="OFFICIAL_QUEUE" aria-live="polite">
      <div>
        <div class="queue-mark" aria-hidden="true"></div>
        <h2>前方还有 318 人</h2>
        <p>页面会自动更新，请勿刷新或关闭。本场景保持静态，便于断言执行器没有高频刷新或另开页面。</p>
        <a class="secondary" data-testid="mock-release-queue" href="/damai/normal">仿真：放行至购票页</a>
      </div>
    </section>`
  );
}

function soldOutPage(): string {
  return documentShell(
    "sold-out",
    `${statusStrip("sold-out")}
    <section class="state-card" data-testid="sold-out" data-state="SOLD_OUT">
      <div>
        <div class="warning-mark" aria-hidden="true">×</div>
        <h2>所有票档已售罄</h2>
        <p>¥380 / ¥680 / ¥980 均无库存。仿真页不会自动轮询或刷新。</p>
        <button class="primary" type="button" data-testid="submit-order" disabled aria-disabled="true">暂时无票</button>
      </div>
    </section>`
  );
}

function loginExpiredPage(): string {
  return documentShell(
    "login-expired",
    `${statusStrip("on-sale", "expired")}
    <section class="state-card" data-testid="login-required" data-state="LOGIN_EXPIRED">
      <div>
        <div class="warning-mark" aria-hidden="true">!</div>
        <h2>请重新登录</h2>
        <p>专用浏览器的本地会话已经过期。不要上传 Cookie 或账号密码，请由用户在本机完成登录。</p>
        <button class="secondary" type="button" data-testid="manual-login">人工登录（仿真）</button>
      </div>
    </section>`
  );
}

function pageChangedPage(): string {
  return documentShell(
    "page-changed",
    `<section class="revamp" data-testid="mock-page-changed" data-revamped-ui="v2">
      <p>LAYOUT REVISION / V2</p>
      <h2>CHOOSE<br>YOUR NIGHT</h2>
      <div class="revamp-grid">
        <div class="revamp-tile"><strong>19:30</strong><p>新的未知场次组件</p></div>
        <div class="revamp-tile"><strong>¥ ?</strong><p>新的未知票档组件</p></div>
      </div>
      <p>标准 session-option、tier-option、order-total 和 submit-order 契约均被刻意移除。</p>
    </section>`
  );
}

export function renderScenario(scenario: MockScenario): string {
  switch (scenario) {
    case "normal":
    case "price-limit":
    case "captcha":
      return normalPage(scenario);
    case "queue":
      return queuePage();
    case "sold-out":
      return soldOutPage();
    case "login-expired":
      return loginExpiredPage();
    case "page-changed":
      return pageChangedPage();
  }
}

export function renderIndex(): string {
  const cards = scenarioNames
    .map((scenario) => {
      const copy = scenarioCopy[scenario];
      return `<a class="option" href="/damai/${scenario}"><span><strong>${copy.eyebrow}</strong><br><small>${copy.note}</small></span><span>打开 →</span></a>`;
    })
    .join("");
  return documentShell(
    "normal",
    `<section class="panel">
      <h2>选择仿真场景</h2>
      <p class="fine-print">所有页面和交互都在本机运行，不会请求大麦、猫眼或任何外部服务。</p>
      <nav class="options" aria-label="仿真场景">${cards}</nav>
    </section>`
  );
}
