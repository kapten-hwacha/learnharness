export class AsyncLocalStorage<T> {
	private currentStore: T | undefined = undefined;

	getStore(): T | undefined {
		return this.currentStore;
	}

	run<R, A extends unknown[]>(store: T, callback: (...args: A) => R, ...args: A): R {
		const prev = this.currentStore;
		this.currentStore = store;
		try {
			const result = callback(...args);
			const maybePromise = result as unknown as Promise<unknown>;
			if (maybePromise && typeof maybePromise === "object" && typeof maybePromise.then === "function") {
				return maybePromise.then(
					(val) => {
						this.currentStore = prev;
						return val;
					},
					(err: unknown) => {
						this.currentStore = prev;
						throw err;
					},
				) as R;
			}
			this.currentStore = prev;
			return result;
		} catch (err) {
			this.currentStore = prev;
			throw err;
		}
	}

	enterWith(store: T): void {
		this.currentStore = store;
	}

	disable(): void {
		this.currentStore = undefined;
	}
}

export const asyncHooksShim = {
	AsyncLocalStorage,
};

export default asyncHooksShim;
