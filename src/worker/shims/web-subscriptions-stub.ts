import type { ChatGPTStatus } from "../../core/contracts/chatgpt.ts";
import type { NativeSubscriptionSnapshot } from "../../core/contracts/subscriptions.ts";

export function webSubscriptionsEnabled(): boolean {
	return false;
}

export function webSubscriptionOwner(): never {
	throw new Error("Web subscription controls are unavailable in desktop-owned mode.");
}

export async function webSubscriptionStatus(): Promise<{
	chatgpt: ChatGPTStatus;
	native: NativeSubscriptionSnapshot["statuses"];
}> {
	return {
		chatgpt: {
			available: false,
			pending: false,
			allowBackgroundUse: false,
			activeId: null,
			accounts: [],
			error: null,
		},
		native: [],
	};
}

export function createWebSubscriptionOwner(): never {
	throw new Error("Web subscription controls are unavailable in desktop-owned mode.");
}

export async function webSubscriptionRequest<T>(): Promise<T> {
	throw new Error("The web subscription owner is unavailable in desktop mode.");
}
