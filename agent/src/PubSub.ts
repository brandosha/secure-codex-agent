export type Unsubscribe = () => void;

export class PubSub<EventType> {
  private _subs: ((event: EventType) => void)[] = [];

  publish(event: EventType) {
    this._subs.forEach((callback) => callback(event));
  }

  subscribe(callback: (event: EventType) => void) {
    this._subs.push(callback);
    return () => {
      this._subs = this._subs.filter((cb) => cb !== callback);
    };
  }
}
