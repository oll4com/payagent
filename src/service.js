// The task flow: submit -> policy gate -> (person accepts) -> agent works -> customer sees a preview and pays
// the task's own address -> the full result is released. Every step goes to the audit log.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { decide } from './policy.js';
import { taskAddress } from './chain.js';
import { buildPaymentRequest, pathXpubs, paysTask } from './payment-builder.js';

const PREVIEW_CHARS = 280;

export function createService({ config, audit, chain, agent, storePath }) {
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
    audit.append({ taskId: task.id, status, ...auditDetail });
  };

  async function run(task) {
    move(task, 'WORKING');
    try {
      const result = String(await agent(task.description));
      move(task, 'AWAITING_PAYMENT', { result, auditDetail: { resultChars: result.length } });
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
      const index = Object.keys(tasks).length;
      const { decision, ruleId } = decide({ description, priceSats }, config);
      const task = {
        id: randomUUID(), index, description, priceSats,
        address: taskAddress(config.hdPublicKey, index, config.addressPrefix),
        createdAt: new Date().toISOString()
      };
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
      move(task, approve ? 'ACCEPTED' : 'DECLINED', { auditDetail: { reviewer } });
      if (approve) await run(task);
      return this.view(id);
    },

    // Reads the task's address; releases the result once the full price has arrived.
    async checkPayment(id) {
      const task = get(id);
      if (task.status !== 'AWAITING_PAYMENT') return this.view(id);
      const received = await chain.receivedSats(task.address);
      if (received >= task.priceSats) move(task, 'PAID', { receivedSats: received, auditDetail: { receivedSats: received } });
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
      audit.append({ taskId: task.id, status: 'BROADCAST', txid });
      return this.checkPayment(id);
    },

    view(id) {
      const { result, ...task } = get(id);
      const paid = task.status === 'PAID';
      return {
        ...task,
        preview: result === undefined ? undefined : result.slice(0, PREVIEW_CHARS),
        result: paid ? result : undefined,
        paymentUri: task.status === 'AWAITING_PAYMENT' ? `${task.address}?amount=${(task.priceSats / 1e8).toFixed(8)}` : undefined
      };
    },
    list: () => Object.keys(tasks).map((id) => ({ id, status: tasks[id].status, priceSats: tasks[id].priceSats, createdAt: tasks[id].createdAt }))
  };
}
