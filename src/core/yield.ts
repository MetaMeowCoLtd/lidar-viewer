/**
 * Lets the browser run everything waiting for the thread - input, rendering,
 * other tasks - before continuing.
 *
 * A message on a channel rather than a timer: browsers throttle timers in a
 * background tab to about one per second, which would stretch a job that
 * yields a hundred times into minutes if the user switched tabs while it ran.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}
