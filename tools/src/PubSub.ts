export type Unsubscribe = () => void;

export class PubSub<EventType> {
  #subs: ((event: EventType) => void)[] = [];

  publish(event: EventType) {
    this.#subs.forEach((callback) => callback(event));
  }

  subscribe(callback: (event: EventType) => void) {
    this.#subs.push(callback);
    return () => {
      this.#subs = this.#subs.filter((cb) => cb !== callback);
    };
  }
}
