// Shared behaviour of the saved web chat pages: a model picker, a message
// box, a send button, and an answer that is written in parts. Each page
// passes its own markup through window.FAKE.
(() => {
  const F = window.FAKE;
  const $ = (s) => document.querySelector(s);
  const editor = $(F.editor), send = $(F.send), chat = $('#chat');
  const picker = $(F.picker), menu = $('#menu');
  window.asked = [];
  picker.onclick = () => { menu.hidden = false; };
  for (const item of menu.children) item.onclick = () => { picker.querySelector('span').textContent = item.dataset.name; menu.hidden = true; };
  const temp = F.tempButton && $(F.tempButton);
  if (temp) temp.onclick = () => { temp.setAttribute('aria-label', 'Turn off temporary chat'); window.temporary = true; };
  if (F.disableSend) {
    send.disabled = true;
    editor.addEventListener('input', () => { send.disabled = !editor.innerText.trim(); });
  }
  send.onclick = () => {
    const q = editor.innerText.trim();
    if (!q) return;
    window.asked.push(q);
    editor.innerHTML = '';
    if (F.disableSend) send.disabled = true;
    const before = chat.querySelectorAll(F.replyTag).length;
    // Only the start of a long question comes back, so the answer stays short.
    const answer = `Turn ${before + 1}. Model ${picker.querySelector('span').textContent}. You said: ${q.length > 160 ? `${q.slice(0, 160)}…` : q}`;
    // A question that starts with HOLD stops after two words until Stop is pressed.
    const hold = q.startsWith('HOLD');
    const wrap = document.createElement('div');
    wrap.innerHTML = F.reply;
    const reply = wrap.firstElementChild;
    chat.appendChild(reply);
    const text = reply.querySelector('[data-text]') || reply;
    const stop = document.createElement('button');
    stop.setAttribute(F.stop[0], F.stop[1]);
    stop.textContent = 'Stop';
    stop.onclick = () => { window.stopped = true; };
    document.body.appendChild(stop);
    if (F.streaming) reply.setAttribute('data-is-streaming', 'true');
    const words = answer.split(' ');
    let i = 0;
    const timer = setInterval(() => {
      if (hold && i >= 2 && !window.stopped) return;
      if (window.stopped || i >= words.length) {
        clearInterval(timer);
        stop.remove();
        reply.removeAttribute('data-is-streaming');
        if (!window.temporary && !location.search.includes(F.tempParam || '\u0000') && !new RegExp(F.saved).test(location.pathname)) history.pushState({}, '', F.savedPath);
        return;
      }
      text.textContent = words.slice(0, ++i).join(' ');
    }, 40);
  };
})();
