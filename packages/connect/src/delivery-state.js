/** Private in-memory state for chat delivery. Snapshots copy saved values. */
const copy = (value) => {
  if (Array.isArray(value)) return value.map(copy);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
  }
  return value;
};

// A driver is a live handle. Keep that exact object while copying marker data.
const copyEcho = (item) => {
  const { driver, ...data } = item;
  const marker = copy(data);
  if (Object.hasOwn(item, 'driver')) marker.driver = item.driver;
  return marker;
};

export class DeliveryState {
  #queues = new Map();
  #sending = new Set();
  #steps = new Map();
  #steered = new Map();
  #delivering = new Map();
  #awaitingEcho = new Map();
  #settling = new Map();
  #closedTurns = new Map();

  // Queue tickets and delivery steps.
  queue(id) {
    return copy(this.#queues.get(id) ?? []);
  }

  queueSize(id) {
    return this.#queues.get(id)?.length ?? 0;
  }

  hasQueue(id) {
    return this.queueSize(id) > 0;
  }

  ticket(id, turnId) {
    const item = this.#queues.get(id)?.find((entry) => entry.turnId === turnId);
    return item && copy(item);
  }

  hasTicket(id, turnId) {
    return !!this.#queues.get(id)?.some((item) => item.turnId === turnId);
  }

  addTicket(id, item) {
    const queue = this.#queues.get(id) ?? [];
    queue.push(copy(item));
    this.#queues.set(id, queue);
  }

  updateTicket(id, turnId, update) {
    const ticket = this.#queues.get(id)?.find((item) => item.turnId === turnId);
    if (!ticket) return false;
    Object.assign(ticket, copy(update));
    return true;
  }

  restoreQueue(id, items) {
    if (items?.length) this.#queues.set(id, copy(items));
    else this.#queues.delete(id);
  }

  clearQueue(id) {
    this.#queues.delete(id);
  }

  removeTicket(id, turnId) {
    const queue = this.#queues.get(id) ?? [];
    const index = queue.findIndex((item) => item.turnId === turnId);
    if (index < 0) return null;
    const [item] = queue.splice(index, 1);
    if (!queue.length) this.#queues.delete(id);
    return copy(item);
  }

  takeNextTicket(id) {
    const queue = this.#queues.get(id) ?? [];
    const item = queue.shift();
    if (!queue.length) this.#queues.delete(id);
    return item && copy(item);
  }

  removeQueue(id) {
    const items = this.queue(id);
    this.#queues.delete(id);
    return items;
  }

  isSending(id) {
    return this.#sending.has(id);
  }

  setSending(id, value = true) {
    if (value) this.#sending.add(id);
    else this.#sending.delete(id);
  }

  steps(id) {
    return [...(this.#steps.get(id) ?? [])];
  }

  hasSteps(id) {
    return !!this.#steps.get(id)?.size;
  }

  addStep(id, step) {
    const steps = this.#steps.get(id) ?? new Set();
    steps.add(step);
    this.#steps.set(id, steps);
  }

  removeStep(id, step) {
    const steps = this.#steps.get(id);
    steps?.delete(step);
    if (!steps?.size) this.#steps.delete(id);
  }

  clearSteps(id) {
    this.#steps.delete(id);
  }

  restoreSteps(id, steps) {
    if (steps?.length) this.#steps.set(id, new Set(steps));
    else this.#steps.delete(id);
  }

  // Tickets handed to a running agent.
  steered(id) {
    return copy(this.#steered.get(id) ?? []);
  }

  addSteered(id, item) {
    const list = this.#steered.get(id) ?? [];
    list.push(copy(item));
    this.#steered.set(id, list);
  }

  steeredTicket(id, turnId) {
    const item = this.#steered.get(id)?.find((entry) => entry.turnId === turnId);
    return item && copy(item);
  }

  removeSteered(id, turnId) {
    const list = this.#steered.get(id) ?? [];
    const index = list.findIndex((item) => item.turnId === turnId);
    if (index < 0) return null;
    const [item] = list.splice(index, 1);
    if (!list.length) this.#steered.delete(id);
    return copy(item);
  }

  restoreSteered(id, items) {
    if (items?.length) this.#steered.set(id, copy(items));
    else this.#steered.delete(id);
  }

  clearSteered(id) {
    this.#steered.delete(id);
  }

  steeredSize(id) {
    return this.#steered.get(id)?.length ?? 0;
  }

  delivering(id) {
    return this.#delivering.get(id);
  }

  setDelivering(id, turnId) {
    if (turnId == null) this.#delivering.delete(id);
    else this.#delivering.set(id, turnId);
  }

  // Echo markers for new turns.
  awaitingEcho(id) {
    return (this.#awaitingEcho.get(id) ?? []).map(copyEcho);
  }

  addAwaitingEcho(id, item) {
    const list = this.#awaitingEcho.get(id) ?? [];
    list.push(copyEcho(item));
    if (list.length > 16) list.shift();
    this.#awaitingEcho.set(id, list);
  }

  removeAwaitingEcho(id, turnId, driver) {
    const list = this.#awaitingEcho.get(id) ?? [];
    const index = list.findIndex((item) => item.turnId === turnId && (driver === undefined || item.driver === driver));
    if (index < 0) return null;
    const [item] = list.splice(index, 1);
    if (list.length) this.#awaitingEcho.set(id, list);
    else this.#awaitingEcho.delete(id);
    return copyEcho(item);
  }

  clearAwaitingEcho(id) {
    this.#awaitingEcho.delete(id);
  }

  restoreAwaitingEcho(id, items) {
    if (items?.length) this.#awaitingEcho.set(id, items.map(copyEcho));
    else this.#awaitingEcho.delete(id);
  }

  // Settle timers and duplicate turn-close tracking.
  settling(id) {
    return this.#settling.get(id);
  }

  hasSettling(id) {
    return this.#settling.has(id);
  }

  setSettling(id, timer) {
    if (timer == null) this.#settling.delete(id);
    else this.#settling.set(id, timer);
  }

  clearSettling(id) {
    const timer = this.#settling.get(id);
    this.#settling.delete(id);
    return timer;
  }

  settlingIds() {
    return [...this.#settling.keys()];
  }

  isClosed(id, turnId) {
    return this.#closedTurns.get(id)?.has(turnId) ?? false;
  }

  closeTurn(id, turnId) {
    let closed = this.#closedTurns.get(id);
    if (!closed) this.#closedTurns.set(id, closed = new Set());
    if (closed.has(turnId)) return false;
    closed.add(turnId);
    if (closed.size > 200) closed.delete(closed.values().next().value);
    return true;
  }

  seedClosedTurns(id, load) {
    if (!this.#closedTurns.has(id)) this.#closedTurns.set(id, new Set(load()));
  }

  clearClosedTurns(id) {
    this.#closedTurns.delete(id);
  }

  clear(id) {
    this.#queues.delete(id);
    this.#sending.delete(id);
    this.#steps.delete(id);
    this.#steered.delete(id);
    this.#delivering.delete(id);
    this.#awaitingEcho.delete(id);
    clearTimeout(this.#settling.get(id));
    this.#settling.delete(id);
    this.#closedTurns.delete(id);
  }
}
