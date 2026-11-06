import { useCallback, useRef, useState } from "react";
import type { AbortMode } from "@/components/abort-turn-dialog";

export type { AbortMode };

export interface UseChatAbortDialogOptions {
	onConfirmAbort: (mode: AbortMode) => void;
}

export function useChatAbortDialog(options: UseChatAbortDialogOptions) {
	const [abortAsk, setAbortAsk] = useState<AbortMode | null>(null);
	const abortAskRef = useRef<AbortMode | null>(null);
	abortAskRef.current = abortAsk;

	const onConfirmAbortRef = useRef(options.onConfirmAbort);
	onConfirmAbortRef.current = options.onConfirmAbort;

	const confirmAbort = useCallback(
		(mode: AbortMode) => {
			setAbortAsk(null);
			onConfirmAbortRef.current(mode);
		},
		[],
	);

	const cancelAbort = useCallback(() => {
		setAbortAsk(null);
	}, []);

	return {
		abortAsk,
		setAbortAsk,
		abortAskRef,
		confirmAbort,
		cancelAbort,
	};
}
