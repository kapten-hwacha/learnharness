export type UpdateStatus =
	| "idle"
	| "checking"
	| "downloading"
	| "up-to-date"
	| "downloaded"
	| "error"
	| "disabled";

export interface UpdateState {
	status: UpdateStatus;
	version: string | null;
	revision: number;
}

export function reduceUpdate(
	state: UpdateState,
	ev: { type: UpdateStatus; version?: string }
): UpdateState {
	if (state.status === "disabled") {
		return state;
	}

	if (state.status === "downloaded" && (ev.type === "checking" || ev.type === "error")) {
		return state;
	}

	const nextStatus = ev.type;
	const nextVersion = ev.version !== undefined ? ev.version : state.version;

	if (nextStatus !== state.status || nextVersion !== state.version) {
		return {
			status: nextStatus,
			version: nextVersion,
			revision: state.revision + 1,
		};
	}

	return state;
}
