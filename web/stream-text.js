// Paces streaming text into the visible tail without holding data hostage.
// Arrival is immediate; only subsequent updates are scheduled. A finalizing
// stream drains faster so `turn_end` still settles quickly.
export const STREAM_FRAME_MS = 16;
export const STREAM_CHARS_PER_FRAME = 512;
export const STREAM_FINAL_MULTIPLIER = 4;

export function createPacedText({ onUpdate, onFinalize }) {
  let queue = [];
  let visible = "";
  let raw = "";
  let timer = null;
  let finalizing = false;
  let done = false;
  let started = false;

  function schedule() {
    if (timer === null && queue.length > 0) {
      timer = setTimeout(drain, STREAM_FRAME_MS);
    }
  }

  function drain() {
    timer = null;
    const budget =
      STREAM_CHARS_PER_FRAME * (finalizing ? STREAM_FINAL_MULTIPLIER : 1);
    let remaining = budget;
    while (remaining > 0 && queue.length > 0) {
      const head = queue[0];
      if (head.length <= remaining) {
        visible += head;
        queue.shift();
        remaining -= head.length;
      } else {
        visible += head.slice(0, remaining);
        queue[0] = head.slice(remaining);
        remaining = 0;
      }
    }
    onUpdate?.(visible);
    if (queue.length > 0) {
      schedule();
    } else if (finalizing) {
      finalizing = false;
      done = true;
      onFinalize?.(raw);
    }
  }

  return {
    push(text) {
      if (!text || done) return;
      const first = !started;
      started = true;
      raw += text;
      queue.push(text);
      if (first) {
        // First token paints in this task: zero timer latency for TTFT.
        drain();
      } else {
        schedule();
      }
    },
    finalize() {
      if (done) return;
      finalizing = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (queue.length === 0) {
        done = true;
        onFinalize?.(raw);
        return;
      }
      drain();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queue = [];
      visible = "";
      raw = "";
      finalizing = false;
      done = true;
      started = false;
    },
  };
}
