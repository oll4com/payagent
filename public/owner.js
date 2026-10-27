const el = (id) => document.getElementById(id);
const token = () => el('token').value;
const call = async (method, path, body) => {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-review-token': token() }, body: body && JSON.stringify(body) });
  const v = await r.json();
  if (!r.ok) throw new Error(v.error ?? `failed (${r.status})`);
  return v;
};
const status = (text) => { el('status').textContent = text; };
async function show() {
  const { receiver } = await call('GET', '/api/owner');
  el('current').textContent = !receiver ? 'No receiving wallet yet.'
    : receiver.mode === 'hd' ? `Paired wallet (${receiver.path} xpub ${receiver.xpub}): a new address per task.`
    : `Static address ${receiver.address}: each task gets its own amount.`;
}
el('show').addEventListener('click', () => show().catch((e) => status(e.message)));
el('pair').addEventListener('click', async () => {
  try {
    status('Connecting to the wallet relay…');
    const { pairWallet, qrSvg } = await import('/wallet.bundle.js');
    const { xpub, walletName } = await pairWallet({ onPairing: (uri, qrUri) => {
      el('pairing').hidden = false; el('qr').innerHTML = qrSvg(qrUri); el('wizlink').href = uri; status('Waiting for your wallet…');
    } });
    el('pairing').hidden = true;
    await call('POST', '/api/owner/wallet', { xpub, path: 'receive' });
    status(`Paired with ${walletName ?? 'your wallet'}.`);
    await show();
  } catch (e) { el('pairing').hidden = true; status(`Not paired: ${e.message}`); }
});
el('save-address').addEventListener('click', async () => {
  try { await call('POST', '/api/owner/static-address', { address: el('address').value }); status('Address saved.'); await show(); }
  catch (e) { status(e.message); }
});
