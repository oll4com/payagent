// The task flow: submit -> policy gate -> (person accepts) -> agent works -> customer sees a preview and pays
// the task's own address -> the full result is released. Every step goes to the audit log.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { decide } from './policy.js';
import { buildPaymentRequest, pathXpubs, paysTask } from './payment-builder.js';
import { hdAddress } from './receiver.js';
import { taskRef } from './audit.js';

const PREVIEW_CHARS = 280;
const GAP_LIMIT = 20; // BIP44: wallets stop looking after 20 unused addresses in a row
const OPEN = ['ACCEPTED', 'WORKING', 'AWAITING_PAYMENT'];
const unavailable = (message) => Object.assign(new Error(message), { status: 503 });

export function createService({ config, audit, chain, agent, storePath, owner }) {
  const lastRead = new Map();
  const tasks = existsSync(storePath) ? JSON.parse(readFileSync(storePath, 'utf8')) : {};
  const save = () => writeFileSync(storePath, JSON.stringify(tasks, null, 2));
  const get = (id) => {
    const task = tasks[id];
    if (!task) throw Object.assign(new Error('task not found'), { status: 404 });
    return task;
  };
  const move = (task, status, { auditDetail, ...fields } = {}) => {
    Object.assign(task, fields, { status, updatedAt: new Date().toISOString() });
    save();
    audit.append({ task: taskRef(task.id), status, ...auditDetail });
  };

  // HD wallet: the lowest never-used index at most GAP_LIMIT past the last used one, so a wallet restored from its seed still
  // finds every payment; an unpaid expired task's index is reused only while its address has no transaction at all.
  // Static address: every open task gets its own amount (price + 1..999 satoshis) to tell the payments apart.
  async function assignReceiver(task) {
    const receiver = owner.current();
    if (!receiver) throw unavailable('the owner has not set up a receiving wallet yet');
    const all = Object.values(tasks).filter((t) => t.id !== task.id);
    for (const t of all.filter((t) => t.status === 'AWAITING_PAYMENT')) await settle(t);
    if (receiver.mode === 'static') {
      const taken = new Set(all.filter((t) => OPEN.includes(t.status) && t.address === receiver.address).map((t) => t.amountSats - t.priceSats));
      const tag = Array.from({ length: 999 }, (_, i) => i + 1).find((n) => !taken.has(n));
      if (!tag) throw unavailable('too many unpaid tasks are open; try again later');
      return { mode: 'static', address: receiver.address, amountSats: task.priceSats + tag, sinceHeight: await chain.tipHeight() };
    }
    const same = all.filter((t) => t.receiver?.xpub === receiver.xpub);
    let lastUsed = Math.max(-1, ...same.filter((t) => t.status === 'PAID').map((t) => t.receiver.index));
    for (let index = 0; index <= lastUsed + GAP_LIMIT; index += 1) {
      const earlier = same.filter((t) => t.receiver.index === index);
      if (earlier.some((t) => OPEN.includes(t.status) || t.status === 'PAID')) continue;
      const address = hdAddress(receiver, index, config.addressPrefix);
      // Only a never-used address is handed out: money that arrived before (a late payment, or the wallet's own use) must
      // never count as this task's payment. A used address counts for the gap limit.
      if (await chain.hasHistory(address)) {
        for (const t of earlier.filter((t) => t.status === 'EXPIRED')) await settle(t);
        lastUsed = Math.max(lastUsed, index);
        continue;
      }
      return { mode: 'hd', xpub: receiver.xpub, path: receiver.path, index, address, amountSats: task.priceSats };
    }
    throw unavailable('too many unpaid tasks are open; try again later');
  }

  // Marks a task PAID once its amount has arrived; an unpaid task expires after the payment window.
  async function settle(task) {
    if (!['AWAITING_PAYMENT', 'EXPIRED'].includes(task.status)) return;
    let paid;
    if (task.receiver.mode === 'hd') {
      // An expired task's address may have gone to a newer task; then its late payments can't be told apart.
      const reused = task.status === 'EXPIRED' && Object.values(tasks).some((t) => t !== task && t.receiver?.xpub === task.receiver.xpub && t.receiver.index === task.receiver.index && t.createdAt > task.createdAt);
      if (reused) return;
      const received = await chain.receivedSats(task.address);
      if (received >= task.amountSats) paid = { receivedSats: received };
    } else {
      const claimed = new Set(Object.values(tasks).map((t) => t.paidOutpoint).filter(Boolean));
      const utxo = (await chain.listUnspent(task.address)).find((u) =>
        u.value === task.amountSats && !claimed.has(`${u.tx_hash}:${u.tx_pos}`) && (u.height <= 0 || u.height >= task.receiver.sinceHeight));
      if (utxo) paid = { receivedSats: utxo.value, paidOutpoint: `${utxo.tx_hash}:${utxo.tx_pos}` };
    }
    if (paid) return move(task, 'PAID', { ...paid, auditDetail: { ...paid, late: task.status === 'EXPIRED' || undefined } });
    if (task.status === 'AWAITING_PAYMENT' && Date.now() - Date.parse(task.awaitingSince) > config.paymentWindowHours * 3600_000) {
      move(task, 'EXPIRED');
    }
  }

  // Tokens the model reported for tasks worked today (UTC), from the stored tasks, so a restart forgets nothing.
  const tokensToday = () => {
    const today = new Date().toISOString().slice(0, 10);
    return Object.values(tasks).reduce((sum, t) => sum + (t.workedAt?.startsWith(today) ? t.agentTokens ?? 0 : 0), 0);
  };
  const assertBudget = () => {
    if (config.agentDailyTokens > 0 && tokensToday() >= config.agentDailyTokens) {
      throw unavailable("the demo's model budget for today is used up; try again after 00:00 UTC");
    }
  };

  async function run(task) {
    try {
      const receiver = await assignReceiver(task);
      Object.assign(task, { receiver, address: receiver.address, amountSats: receiver.amountSats });
    } catch (error) {
      return move(task, 'FAILED', { error: error.message, auditDetail: { error: error.message } });
    }
    move(task, 'WORKING');
    try {
      const answer = await agent(task.description);
      const { text, tokens = 0 } = typeof answer === 'string' ? { text: answer } : answer;
      const result = String(text);
      const now = new Date().toISOString();
      move(task, 'AWAITING_PAYMENT', {
        result, awaitingSince: now, workedAt: now, agentTokens: tokens,
        auditDetail: { resultChars: result.length, tokens, amountSats: task.amountSats }
      });
    } catch (error) {
      move(task, 'FAILED', { error: error.message, auditDetail: { error: error.message } });
    }
  }

  return {
    async submit({ description, priceSats }) {
      description = String(description ?? '').trim();
      priceSats = Number(priceSats);
      if (!description || description.length > 4000) throw Object.assign(new Error('description must be 1-4000 characters'), { status: 400 });
      if (!Number.isSafeInteger(priceSats) || priceSats <= 0) throw Object.assign(new Error('priceSats must be a positive integer'), { status: 400 });
      const { decision, ruleId } = decide({ description, priceSats }, config);
      if (decision === 'AUTO') assertBudget();
      const task = { id: randomUUID(), description, priceSats, createdAt: new Date().toISOString() };
      tasks[task.id] = task;
      const status = { AUTO: 'ACCEPTED', APPROVE: 'NEEDS_APPROVAL', REFUSE: 'REFUSED' }[decision];
      move(task, status, { ruleId, auditDetail: { decision, ruleId, priceSats } });
      if (status === 'ACCEPTED') await run(task);
      return this.view(task.id);
    },

    // A person accepts or declines a task the policy held.
    async review(id, approve, reviewer) {
      const task = get(id);
      if (task.status !== 'NEEDS_APPROVAL') throw Object.assign(new Error(`task is ${task.status}`), { status: 409 });
      if (approve) assertBudget();
      move(task, approve ? 'ACCEPTED' : 'DECLINED', { auditDetail: { reviewer } });
      if (approve) await run(task);
      return this.view(id);
    },

    // Reads the task's address; releases the result once the full amount has arrived.
    async checkPayment(id) {
      const task = get(id);
      const now = Date.now();
      // A task's address is read from the chain at most once per interval, however often clients ask.
      if (now - (lastRead.get(id) ?? 0) >= config.paymentRecheckMs) {
        lastRead.set(id, now);
        await settle(task);
      }
      return this.view(id);
    },

    // WizardConnect: an unsigned payment from the customer's wallet for the wallet to sign.
    async paymentRequest(id, paths) {
      const task = get(id);
      if (task.status !== 'AWAITING_PAYMENT') throw Object.assign(new Error(`task is ${task.status}`), { status: 409 });
      return buildPaymentRequest({ xpubs: pathXpubs(paths), task, chain, prefix: config.addressPrefix });
    },

    async submitPayment(id, signedTransaction) {
      const task = get(id);
      if (task.status !== 'AWAITING_PAYMENT') throw Object.assign(new Error(`task is ${task.status}`), { status: 409 });
      if (typeof signedTransaction !== 'string' || !/^[0-9a-f]{20,200000}$/i.test(signedTransaction) || !paysTask(signedTransaction, task)) {
        throw Object.assign(new Error('the signed transaction does not pay this task in full'), { status: 400 });
      }
      const txid = await chain.broadcast(signedTransaction);
      audit.append({ task: taskRef(task.id), status: 'BROADCAST', txid });
      lastRead.delete(task.id);
      return this.checkPayment(id);
    },

    view(id) {
      const { result, receiver, paidOutpoint, ...task } = get(id);
      const paid = task.status === 'PAID';
      return {
        ...task,
        ref: taskRef(task.id),
        preview: result === undefined ? undefined : result.slice(0, PREVIEW_CHARS),
        result: paid ? result : undefined,
        paymentUri: task.status === 'AWAITING_PAYMENT' ? `${task.address}?amount=${(task.amountSats / 1e8).toFixed(8)}` : undefined
      };
    },
    list: () => Object.keys(tasks).map((id) => ({ id, status: tasks[id].status, priceSats: tasks[id].priceSats, createdAt: tasks[id].createdAt }))
  };
}
