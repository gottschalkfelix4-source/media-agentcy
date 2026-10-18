import { EventEmitter } from 'node:events';

/** Change notifications for the web UI (pushed to browsers via Server-Sent Events). */
export type AppEvent =
  | { type: 'message'; userId: number }
  | { type: 'user'; userId: number }
  | { type: 'ticket'; ticketId: number; userId?: number }
  | { type: 'request'; userId: number }
  | { type: 'activity'; userId?: number | null }
  | { type: 'runtime'; userId: number }
  | { type: 'whatsapp'; state: string }
  | { type: 'settings' }
  | { type: 'log' };

class Bus extends EventEmitter {
  emitEvent(e: AppEvent) {
    this.emit('event', e);
  }
  onEvent(fn: (e: AppEvent) => void) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
