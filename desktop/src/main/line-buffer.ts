// Turns pipe chunks into whole lines (SPEC-006 FR-6). No electron import, so node tests can load it.

/** A line longer than this without a newline is emitted as is instead of growing forever. */
export const MAX_PENDING_CHARS = 65_536;
export const MAX_CONTROL_FRAME_CHARS = 2 * 1024 * 1024;

export interface LineBuffer {
  /** Feed decoded text (use stream.setEncoding("utf8") so characters are never split). */
  push(chunk: string): void;
  /** Emit whatever is left, e.g. a last line without a trailing newline. */
  flush(): void;
}

/**
 * Pipe chunks end anywhere, even in the middle of a line. `emit` receives only complete lines:
 * all complete lines of one chunk at once (with their newlines), the unfinished tail waits for
 * the next chunk.
 */
export function createLineBuffer(emit: (text: string) => void, framedPrefix?: string): LineBuffer {
  let droppingFrame = false;
  let pending = "";
  return {
    push(chunk: string) {
      if (droppingFrame) {
        const end = chunk.indexOf("\n");
        if (end < 0) return;
        chunk = chunk.slice(end + 1); droppingFrame = false;
      }
      const text = pending + chunk;
      const cut = text.lastIndexOf("\n");
      if (cut < 0) {
        pending = text;
        if (framedPrefix && pending.startsWith(framedPrefix)) {
          // Do not split a protocol record into two log lines. Drop an over-limit frame through LF.
          if (pending.length > MAX_CONTROL_FRAME_CHARS) { droppingFrame = true; pending = ""; }
        } else if (pending.length > MAX_PENDING_CHARS) {
          pending = "";
          emit(text);
        }
        return;
      }
      pending = text.slice(cut + 1);
      emit(text.slice(0, cut + 1));
    },
    flush() {
      if (!pending) return;
      const text = pending;
      pending = "";
      emit(text);
    },
  };
}
