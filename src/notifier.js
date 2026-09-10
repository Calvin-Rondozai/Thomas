// Tiny pub/sub so the scheduler and the WhatsApp layer don't need to require each
// other directly (keeps the module graph a clean tree instead of a cycle).
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(20);

module.exports = bus;
