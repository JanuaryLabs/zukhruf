import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Mutex, TicketQueueFileStore } from '@zukhruf/mutex';

import { createApp } from './create-app.ts';
import { FencedStock } from './fenced-stock.ts';

const directory = join(tmpdir(), 'mutex');
await mkdir(directory, { recursive: true });

// Durable stock needs durable tokens: the ticket queue's default counter files survive restarts.
const stock = new FencedStock(join(directory, 'inventory.db'));
stock.seed('product:42', 1);

export default createApp({
  mutex: new Mutex(new TicketQueueFileStore(directory)),
  stock,
});
