// test/helpers.js — minimal fakes shared by the suites.
import { ReadableStream } from 'node:stream/web';

/** A fake ServerResponse that records SSE output and exposes its listeners. */
export function fakeRes({ backpressure = () => true } = {}) {
  const listeners = {};
  const parts = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    listeners,
    parts,
    /** Number of listeners currently registered for an event. */
    count(event) { return (listeners[event] ?? []).length; },
    writeHead(status, headers) { this.headersSent = true; this.status = status; this.headers = headers; },
    write(s) { parts.push(s); return backpressure(parts.length); },
    end() { this.writableEnded = true; },
    on(k, f) { (listeners[k] ??= []).push({ f, once: false }); },
    once(k, f) { (listeners[k] ??= []).push({ f, once: true }); },
    off(k, f) { listeners[k] = (listeners[k] ?? []).filter((x) => x.f !== f); },
    removeListener(k, f) { this.off(k, f); },
    // faithful EventEmitter: 'once' listeners are removed before being invoked
    emit(k) {
      for (const entry of (listeners[k] ?? []).slice()) {
        if (entry.once) listeners[k] = (listeners[k] ?? []).filter((x) => x !== entry);
        entry.f();
      }
    },
    get out() { return parts.join(''); },
    /** SSE event names in order. */
    get events() { return [...this.out.matchAll(/^event: (\w+)/gm)].map((m) => m[1]); },
    /** Concatenated text_delta payloads. */
    get text() { return [...this.out.matchAll(/"type":"text_delta","text":"([^"]*)"/g)].map((m) => m[1]).join(''); },
    /** Parsed message_delta payload, or null. */
    get messageDelta() {
      const i = this.out.indexOf('event: message_delta');
      if (i === -1) return null;
      const line = this.out.slice(i).split('\n').find((l) => l.startsWith('data: '));
      return JSON.parse(line.slice(6));
    },
  };
  return res;
}

/** An OpenAI-style SSE body from an array of chunk objects. */
export function sseBody(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode('data: ' + JSON.stringify(ch) + '\n\n'));
      c.close();
    },
  });
}

/** Fake upstream response object for the translators. */
export function fakeUpstream(body, contentType = 'text/event-stream') {
  return { headers: { get: (k) => (k === 'content-type' ? contentType : null) }, body };
}

export const delta = (content) => ({ choices: [{ delta: { content } }] });
