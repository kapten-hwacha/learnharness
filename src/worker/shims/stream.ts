import { EventEmitter } from "./events.ts";

export class Readable extends EventEmitter {
	readable = true;
	pipe<T>(dest: T): T {
		return dest;
	}
	read(): null {
		return null;
	}
	destroy(): this {
		return this;
	}
	static from(): Readable {
		return new Readable();
	}
}

export class Writable extends EventEmitter {
	writable = true;
	write(_chunk: unknown, _cb?: () => void): boolean {
		return true;
	}
	end(_cb?: () => void): this {
		return this;
	}
	destroy(): this {
		return this;
	}
}

export class Transform extends Readable {
	_transform(_chunk: unknown, _enc: unknown, cb: () => void): void {
		cb();
	}
}

export class PassThrough extends Transform {}

export function pipeline(...args: unknown[]): void {
	const cb = args[args.length - 1];
	if (typeof cb === "function") cb(null);
}

export default {
	Readable,
	Writable,
	Transform,
	PassThrough,
	pipeline,
};
