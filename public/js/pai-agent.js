// P.AI's in-app guide: the button in the bottom-right corner of every signed-in
// page, and the panel behind it.
//
// Self-contained on purpose — it injects its own styles and markup and asks
// nothing of the page it is on, so adding it to a new page is one script tag,
// and it will drop into the other sites the same way.
//
// It answers "where do I find…" and "can P.AI do…". It does not read the
// numbers on the page: the server prompt tells it to point at the page that
// has them rather than guess, because a confident wrong number is worse than
// a link.

(function () {
  'use strict';

  // The shift-leader audit form is public and has no session, so the API would
  // 401. Nothing to guide there anyway — it is one form.
  const OFF = ['/', '/index.html', '/audit', '/audit.html'];
  if (OFF.includes(location.pathname)) return;

  const STORE_KEY = 'pai-agent-open';

  const CSS = `
.pai-fab{position:fixed;right:20px;bottom:20px;z-index:9000;width:52px;height:52px;border-radius:50%;
  border:none;cursor:pointer;background:#e31837;color:#fff;font:700 15px/1 system-ui,sans-serif;
  box-shadow:0 6px 24px rgba(0,0,0,.45);transition:transform .15s,box-shadow .15s;}
.pai-fab:hover{transform:scale(1.06);box-shadow:0 8px 30px rgba(0,0,0,.55);}
.pai-fab[hidden]{display:none;}

.pai-panel{position:fixed;right:20px;bottom:20px;z-index:9001;width:370px;max-width:calc(100vw - 32px);
  max-height:min(560px,calc(100vh - 40px));display:none;flex-direction:column;
  background:#1b1e25;border:1px solid #30353f;border-radius:14px;overflow:hidden;
  box-shadow:0 20px 60px rgba(0,0,0,.6);font:14px/1.6 system-ui,-apple-system,sans-serif;color:#e8eaed;}
.pai-panel.on{display:flex;}

.pai-head{display:flex;align-items:center;gap:9px;padding:12px 14px;background:#15181e;
  border-bottom:1px solid #30353f;flex:0 0 auto;}
.pai-head b{font-size:14px;font-weight:700;}
.pai-head b span{color:#e31837;}
.pai-head .pai-sub{font-size:11.5px;color:#8b909b;margin-left:2px;}
.pai-x{margin-left:auto;background:none;border:none;color:#8b909b;cursor:pointer;font-size:20px;
  line-height:1;padding:2px 4px;border-radius:5px;font-family:inherit;}
.pai-x:hover{color:#e8eaed;background:#262a33;}

.pai-log{flex:1 1 auto;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:11px;}
.pai-msg{padding:9px 12px;border-radius:11px;max-width:92%;white-space:pre-wrap;word-wrap:break-word;}
.pai-msg.me{align-self:flex-end;background:#e31837;color:#fff;border-bottom-right-radius:3px;}
.pai-msg.it{align-self:flex-start;background:#262a33;border-bottom-left-radius:3px;}
.pai-msg.err{align-self:flex-start;background:#3a1d22;color:#ff9aa4;border-bottom-left-radius:3px;}
.pai-go{align-self:flex-start;display:inline-block;background:#e31837;color:#fff;text-decoration:none;
  padding:7px 14px;border-radius:8px;font-size:13px;font-weight:600;}
.pai-go:hover{background:#c41530;}

.pai-eg{display:flex;flex-wrap:wrap;gap:6px;}
.pai-eg button{background:transparent;border:1px dashed #40454f;color:#8b909b;padding:5px 10px;
  border-radius:13px;font:12px system-ui,sans-serif;cursor:pointer;}
.pai-eg button:hover{color:#e8eaed;border-style:solid;}

.pai-ask{display:flex;gap:8px;padding:11px;border-top:1px solid #30353f;background:#15181e;flex:0 0 auto;}
.pai-ask input{flex:1;background:#262a33;border:1px solid #30353f;color:#e8eaed;padding:9px 12px;
  border-radius:8px;font:14px system-ui,sans-serif;}
.pai-ask input:focus{outline:none;border-color:#e31837;}
.pai-ask button{background:#e31837;border:none;color:#fff;padding:9px 15px;border-radius:8px;
  font:600 13px system-ui,sans-serif;cursor:pointer;}
.pai-ask button:disabled{opacity:.55;cursor:default;}

@media (max-width:480px){
  .pai-panel{right:8px;left:8px;bottom:8px;width:auto;max-height:calc(100vh - 16px);}
}`;

  const EXAMPLES = [
    'Where do I see my speed of service?',
    'How do I send an audit to a store?',
    'What does P.AI do with my P&L?',
    'Where are yesterday\'s guest comments?',
  ];

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const fab = document.createElement('button');
  fab.className = 'pai-fab';
  fab.title = 'Ask P.AI';
  fab.textContent = 'P.AI';

  const panel = document.createElement('div');
  panel.className = 'pai-panel';
  panel.innerHTML = `
    <div class="pai-head">
      <b>P<span>.AI</span></b><span class="pai-sub">your way around</span>
      <button class="pai-x" title="Close">&times;</button>
    </div>
    <div class="pai-log"></div>
    <form class="pai-ask">
      <input type="text" placeholder="Ask me where something is…" autocomplete="off" maxlength="1000">
      <button type="submit">Ask</button>
    </form>`;

  document.body.appendChild(fab);
  document.body.appendChild(panel);

  const log = panel.querySelector('.pai-log');
  const form = panel.querySelector('.pai-ask');
  const input = form.querySelector('input');
  const send = form.querySelector('button');

  function say(text, kind){
    const el = document.createElement('div');
    el.className = 'pai-msg ' + kind;
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function greet(){
    say('I know my way around P.AI. Ask me where something lives, or what a module will do for you.', 'it');
    const row = document.createElement('div');
    row.className = 'pai-eg';
    for (const q of EXAMPLES){
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = q;
      b.onclick = () => { row.remove(); ask(q); };
      row.appendChild(b);
    }
    log.appendChild(row);
  }

  function open(){
    panel.classList.add('on');
    fab.hidden = true;
    if (!log.children.length) greet();
    input.focus();
    try { sessionStorage.setItem(STORE_KEY, '1'); } catch (e) {}
  }

  function close(){
    panel.classList.remove('on');
    fab.hidden = false;
    try { sessionStorage.removeItem(STORE_KEY); } catch (e) {}
  }

  async function ask(question){
    say(question, 'me');
    const thinking = say('…', 'it');
    send.disabled = true;
    input.disabled = true;

    try {
      const res = await fetch('/api/agent/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, page: location.pathname }),
      });

      // Session expired mid-conversation: say so rather than showing a
      // login page's HTML as an answer.
      if (res.status === 401){
        thinking.className = 'pai-msg err';
        thinking.textContent = 'You have been signed out. Reload the page and sign in again.';
        return;
      }

      const data = await res.json().catch(() => null);
      if (!res.ok){
        thinking.className = 'pai-msg err';
        thinking.textContent = (data && data.error) || 'I could not answer that right now.';
        return;
      }

      thinking.textContent = data.answer || 'I do not have an answer for that one.';

      if (data.go && data.go !== location.pathname){
        const a = document.createElement('a');
        a.className = 'pai-go';
        a.href = data.go;
        a.textContent = 'Take me there →';
        log.appendChild(a);
        log.scrollTop = log.scrollHeight;
      }
    } catch (e) {
      thinking.className = 'pai-msg err';
      thinking.textContent = 'I could not reach the server: ' + e.message;
    } finally {
      send.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  fab.onclick = open;
  panel.querySelector('.pai-x').onclick = close;

  form.addEventListener('submit', e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    ask(q);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && panel.classList.contains('on')) close();
  });

  // Reopens itself across pages in one sitting, so following a "take me
  // there" link does not close the conversation you were having.
  try { if (sessionStorage.getItem(STORE_KEY)) open(); } catch (e) {}
})();
