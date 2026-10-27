const el = (id) => document.getElementById(id);
let timer;
fetch('/api/config').then((r) => r.json()).then((c) => {
  el('network').textContent = c.network;
  if (c.repoUrl) {
    const a = Object.assign(document.createElement('a'), { href: c.repoUrl, textContent: 'Source code' });
    el('repo-link').replaceChildren(a);
  }
  if (c.donationAddress) el('donation').textContent = c.donationAddress;
  el('price').value = c.minPriceSats;
  el('price').min = c.minPriceSats; el('price').max = c.maxPriceSats;
});
function render(t) {
  const box = el('task'); box.hidden = false;
  box.replaceChildren();
  const add = (tag, text) => { const n = document.createElement(tag); n.textContent = text; box.append(n); return n; };
  add('p', 'Status: ').append(Object.assign(document.createElement('span'), { className: 'status', textContent: t.status }));
  if (t.ruleId) add('p', `Policy rule: ${t.ruleId}`);
  if (t.preview && !t.result) { add('p', 'Preview:'); add('pre', t.preview); }
  if (t.paymentUri) {
    add('p', `Pay ${t.priceSats} satoshis to unlock the full result.`);
    const pay = add('button', 'Pay with a WizardConnect wallet');
    pay.type = 'button';
    pay.addEventListener('click', () => walletPay(t.id));
    add('p', 'Or send the exact amount from any wallet:');
    const a = add('a', t.paymentUri); a.href = t.paymentUri;
  }
  if (t.result) { add('p', 'Result:'); add('pre', t.result); }
  if (t.error) add('p', `Error: ${t.error}`);
}
async function walletPay(id) {
  clearInterval(timer);
  const { payWithWallet, qrSvg } = await import('/wallet.bundle.js');
  const status = (text) => { el('wallet-status').textContent = text; };
  el('wallet').hidden = false;
  el('qr').replaceChildren();
  status('Connecting to the wallet relay…');
  try {
    const t = await payWithWallet(id, {
      onPairing: (uri, qrUri) => { el('qr').innerHTML = qrSvg(qrUri); el('wizlink').href = uri; status('Waiting for your wallet…'); },
      onStatus: status
    });
    el('wallet').hidden = true;
    render(t);
    if (t.status !== 'PAID') timer = setInterval(() => poll(id), 5000);
  } catch (error) {
    status(`Payment not sent: ${error.message}`);
    timer = setInterval(() => poll(id), 5000);
  }
}
async function poll(id) {
  const t = await (await fetch(`/api/tasks/${id}/check`, { method: 'POST' })).json();
  render(t);
  if (['PAID', 'REFUSED', 'DECLINED', 'FAILED'].includes(t.status)) clearInterval(timer);
}
el('submit').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearInterval(timer);
  const r = await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: el('description').value, priceSats: Number(el('price').value) }) });
  const t = await r.json();
  if (!r.ok) return render({ status: 'ERROR', error: t.error });
  render(t);
  timer = setInterval(() => poll(t.id), 5000);
});
