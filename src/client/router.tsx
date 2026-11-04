import React, { useSyncExternalStore } from "react";

export interface RouterInstance {
	push(href: string, opts?: { scroll?: boolean }): void;
	replace(href: string, opts?: { scroll?: boolean }): void;
	back(): void;
	forward(): void;
	refresh(): void;
	prefetch(href: string): void;
}

export interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
	href: string;
	prefetch?: boolean;
	replace?: boolean;
	scroll?: boolean;
}

export class RedirectError extends Error {
	constructor(public href: string) {
		super(`NEXT_REDIRECT: ${href}`);
		this.name = "RedirectError";
	}
}

export class NotFoundError extends Error {
	constructor() {
		super("NEXT_NOT_FOUND");
		this.name = "NotFoundError";
	}
}

interface RouterState {
	href: string;
	pathname: string;
	searchParams: URLSearchParams;
	params: Record<string, string>;
}

export function matchRouteParams(
	pathname: string,
	pattern: string,
): Record<string, string> | null {
	const pathSegments = pathname.split("/").filter(Boolean);
	const patternSegments = pattern.split("/").filter(Boolean);

	if (pathSegments.length !== patternSegments.length) {
		return null;
	}

	const params: Record<string, string> = {};

	for (let i = 0; i < patternSegments.length; i++) {
		const patternSeg = patternSegments[i];
		const pathSeg = pathSegments[i];

		if (patternSeg === undefined || pathSeg === undefined) {
			return null;
		}

		if (patternSeg.startsWith(":")) {
			const paramName = patternSeg.slice(1);
			params[paramName] = decodeURIComponent(pathSeg);
		} else if (patternSeg.startsWith("[") && patternSeg.endsWith("]")) {
			const paramName = patternSeg.slice(1, -1);
			params[paramName] = decodeURIComponent(pathSeg);
		} else if (patternSeg !== pathSeg) {
			return null;
		}
	}

	return params;
}

function extractParams(pathname: string, pattern?: string): Record<string, string> {
	if (pattern) {
		return matchRouteParams(pathname, pattern) ?? {};
	}
	// Fall back to default known application routes
	if (pathname.startsWith("/chat/") && pathname !== "/chat/new") {
		return matchRouteParams(pathname, "/chat/:id") ?? {};
	}
	return {};
}

function parseState(href: string, pattern?: string): RouterState {
	const parsed = new URL(href, "http://localhost");
	const pathname = parsed.pathname;
	const searchParams = new URLSearchParams(parsed.search);
	const params = extractParams(pathname, pattern);
	return {
		href,
		pathname,
		searchParams,
		params,
	};
}

let activeRoutePattern: string | undefined;

function getInitialHref(): string {
	if (typeof window !== "undefined" && window.location) {
		const loc = window.location;
		return (loc.pathname || "/") + (loc.search || "") + (loc.hash || "");
	}
	return "/";
}

let currentState: RouterState = parseState(getInitialHref());

type Listener = () => void;
const listeners = new Set<Listener>();

function subscribe(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function notify(): void {
	for (const listener of listeners) {
		listener();
	}
}

let attachedWindow: Window | undefined;

function ensureWindowListener(): void {
	if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
		if (attachedWindow !== window) {
			attachedWindow = window;
			window.addEventListener("popstate", () => {
				const newHref =
					(window.location.pathname || "/") +
					(window.location.search || "") +
					(window.location.hash || "");
				updateState(newHref);
			});
		}
	}
}

function updateState(href: string): void {
	ensureWindowListener();
	currentState = parseState(href, activeRoutePattern);
	notify();
}

const routerInstance: RouterInstance = {
	push(href: string, opts?: { scroll?: boolean }): void {
		ensureWindowListener();
		if (typeof window !== "undefined" && window.history?.pushState) {
			try {
				window.history.pushState(null, "", href);
			} catch {
				// linkedom or restricted environments
			}
			if (opts?.scroll !== false && typeof window.scrollTo === "function") {
				try {
					window.scrollTo(0, 0);
				} catch {
					// ignore
				}
			}
		}
		updateState(href);
	},

	replace(href: string, opts?: { scroll?: boolean }): void {
		ensureWindowListener();
		if (typeof window !== "undefined" && window.history?.replaceState) {
			try {
				window.history.replaceState(null, "", href);
			} catch {
				// linkedom or restricted environments
			}
			if (opts?.scroll !== false && typeof window.scrollTo === "function") {
				try {
					window.scrollTo(0, 0);
				} catch {
					// ignore
				}
			}
		}
		updateState(href);
	},

	back(): void {
		if (typeof window !== "undefined" && window.history?.back) {
			window.history.back();
		}
	},

	forward(): void {
		if (typeof window !== "undefined" && window.history?.forward) {
			window.history.forward();
		}
	},

	refresh(): void {
		notify();
	},

	prefetch(_href: string): void {
		// SPA no-op
	},
};

export function useRouter(): RouterInstance {
	return routerInstance;
}

const getPathnameSnapshot = () => currentState.pathname;
const getSearchParamsSnapshot = () => currentState.searchParams;
const getParamsSnapshot = () => currentState.params;

export function usePathname(): string {
	return useSyncExternalStore(subscribe, getPathnameSnapshot, getPathnameSnapshot);
}

export function useSearchParams(): URLSearchParams {
	return useSyncExternalStore(subscribe, getSearchParamsSnapshot, getSearchParamsSnapshot);
}

export function useParams<T extends Record<string, string | string[]> = Record<string, string>>(): T {
	return useSyncExternalStore(subscribe, getParamsSnapshot, getParamsSnapshot) as unknown as T;
}

export function redirect(href: string): never {
	routerInstance.replace(href);
	throw new RedirectError(href);
}

export function notFound(): never {
	throw new NotFoundError();
}

export function resetClientRouterForTest(initialHref: string, routePattern?: string): void {
	activeRoutePattern = routePattern;
	ensureWindowListener();
	if (typeof window !== "undefined" && window.history?.replaceState) {
		try {
			window.history.replaceState(null, "", initialHref);
		} catch {
			// ignore
		}
	}
	updateState(initialHref);
}

export function Link({
	href,
	prefetch: _prefetch,
	replace: shouldReplace,
	scroll: shouldScroll,
	onClick,
	children,
	target,
	...rest
}: LinkProps): React.JSX.Element {
	const router = useRouter();

	const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
		if (onClick) {
			onClick(event);
		}
		if (event.defaultPrevented) {
			return;
		}

		const isPlainLeftClick =
			event.button === 0 &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.shiftKey &&
			!event.altKey &&
			!target;

		if (isPlainLeftClick) {
			event.preventDefault();
			if (shouldReplace) {
				router.replace(href, { scroll: shouldScroll });
			} else {
				router.push(href, { scroll: shouldScroll });
			}
		}
	};

	return (
		<a href={href} target={target} onClick={handleClick} {...rest}>
			{children}
		</a>
	);
}

export default Link;
