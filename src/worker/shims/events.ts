export class EventEmitter {
	private _events: Record<string, ((...args: unknown[]) => void)[]> = {};

	on(event: string, listener: (...args: unknown[]) => void): this {
		(this._events[event] ??= []).push(listener);
		return this;
	}

	addListener(event: string, listener: (...args: unknown[]) => void): this {
		return this.on(event, listener);
	}

	once(event: string, listener: (...args: unknown[]) => void): this {
		const g = (...args: unknown[]) => {
			this.off(event, g);
			listener.apply(this, args);
		};
		return this.on(event, g);
	}

	off(event: string, listener: (...args: unknown[]) => void): this {
		const list = this._events[event];
		if (!list) return this;
		this._events[event] = list.filter((l) => l !== listener);
		return this;
	}

	removeListener(event: string, listener: (...args: unknown[]) => void): this {
		return this.off(event, listener);
	}

	emit(event: string, ...args: unknown[]): boolean {
		const list = this._events[event]?.slice();
		if (!list || list.length === 0) return false;
		for (const l of list) l.apply(this, args);
		return true;
	}

	removeAllListeners(event?: string): this {
		if (event) delete this._events[event];
		else this._events = {};
		return this;
	}
}

export async function once(emitter: { once: (event: string, cb: (...args: unknown[]) => void) => unknown }, event: string): Promise<unknown[]> {
	return new Promise((resolve) => {
		emitter.once(event, (...args: unknown[]) => resolve(args));
	});
}

export default EventEmitter;
